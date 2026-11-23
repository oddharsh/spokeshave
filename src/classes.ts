// Cross-language class names: which CSS classes a site can rename safely, and
// the rewrite that renames them in every file at once.
//
// A class name lives in many languages at once: a stylesheet's selectors, an
// HTML class attribute, a script's classList.add("x"), a Worker template's
// class="${x}". Renaming it is safe only when every place the name can appear
// as a class is found and rewritten together, and no other text can turn into
// that name at runtime.
//
// So the census records every class POSITION with its exact offsets, and a
// name is renameable only when nothing else in the tree could become it:
//
// - Markup and stylesheets are read directly: class attributes, selectors.
// - Scripts are parsed with terser's scope analysis (TypeScript first has its
//   types blanked to spaces by amaro, so offsets stay the source's). Every
//   dynamic value that flows into a class (className=, classList.*,
//   setAttribute("class"), an open class="..." in a template or concat chain,
//   a selector argument, a <style> body) is traced to its literal pieces
//   through real bindings, iteration over literal arrays, local and imported
//   helper returns, and option keys across files. The pieces it reaches are
//   class positions; a word cut by an interpolation reserves its prefix or
//   suffix.
// - A literal reached through a binding, key or helper that is also read
//   outside a sink is dual-use, and its words are reserved.
// - A sink that can't be traced TAINTS its file, and a tainted file reserves
//   every word of its prose. Prose in an untainted file can't become a class,
//   except through markup it builds (class attributes, <style>) or text
//   shaped like CSS, which reserves its class names.
// - JSON is data: its words reserve only when a script that reads it (spells
//   its path, or fetches a URL that could reach it and reads text) is tainted.
//   An attribute a sink reads (getAttribute, dataset, a reflected property)
//   reserves its values wherever markup writes them.
//
// One assumption carries the rest: data from outside the tree (an API
// response, user input) reaches a class only through a literal prefix or a
// word its reading file spells, since the tainted file reserves those.
//
// `applyClassNames` rewrites exactly the recorded positions, and
// `assertClassIntegrity` runs the census again on the result to prove the
// rename moved every position and nothing else.
import { transformSync as stripTypes } from "amaro";
import { dirname, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const lib = join(dirname(fileURLToPath(import.meta.resolve("terser"))), "lib");
const { parse } = await import(pathToFileURL(join(lib, "parse.js")).href);
// `any` here is terser's internal AST and scope objects, which ship no types.
const A: any = await import(pathToFileURL(join(lib, "ast.js")).href);
await import(pathToFileURL(join(lib, "scope.js")).href);

/** One class position: `name` sits at `[start, start + name.length)` of `file`. */
export type ClassPosition = { file: string; start: number; name: string };

export type ClassCensus = {
  /** Every class position the census found, in file order. */
  positions: ClassPosition[];
  /** How many positions each class name has, including ones without offsets. */
  counts: Map<string, number>;
  /** Words that could become a class at runtime, with the first reason found. */
  reserved: Map<string, string>;
  /** Fragments cut by an interpolation: no renamed name may start, end or contain one. */
  prefixes: Set<string>;
  suffixes: Set<string>;
  substrings: Set<string>;
  /** Files with a sink the census couldn't trace, and how many. */
  tainted: Map<string, number>;
  /** Names whose every position is known and that nothing else can become. */
  renameable: Set<string>;
  /** One line per untraced sink, for a reader asking why a file is tainted. */
  misses: string[];
};

export type CensusOptions = {
  /** The served root inside the staged tree, so a fetch URL maps to a file ("public"). */
  publicDir: string;
};

const NAME = /-?[_a-zA-Z][\w-]*/g;
const IS_NAME = /^-?[_a-zA-Z][\w-]*$/;
const words = (s: string) => s.match(NAME) ?? [];
const lastWord = (s: string) =>
  /[\s"'=.\u0000]$/.test(s) ? undefined : s.match(/(-?[_a-zA-Z][\w-]*)$/)?.[1];
const firstWord = (s: string) => s.match(/^([\w-]+)/)?.[1];
const blank = (s: string) => s.replace(/[^\n]/g, " ");

export function censusClasses(
  files: ReadonlyMap<string, string>,
  options: CensusOptions,
): ClassCensus {
  const positions: ClassPosition[] = [];
  const counts = new Map<string, number>();
  const reserved = new Map<string, string>();
  const prefixes = new Set<string>(),
    suffixes = new Set<string>(),
    substrings = new Set<string>();
  const tainted = new Map<string, number>();
  const misses: string[] = [];
  const reserve = (n: string, why: string) => {
    if (!reserved.has(n)) reserved.set(n, why);
  };
  const count = (n: string) => counts.set(n, (counts.get(n) ?? 0) + 1);
  const hitAt = (file: string, start: number, name: string) => {
    count(name);
    positions.push({ file, start, name });
  };

  // ---------- text scanners: shared by every language, offsets kept ----------
  // A selector's `.name` tokens. A name followed by a backslash is an escaped
  // selector (`.sm\:x`), whose real class isn't the token, so it's reserved.
  const scanSelector = (sel: string, file: string, base: number) => {
    for (const m of sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)(\\?)/g)) {
      if (m[2]) {
        reserve(m[1]!, "escaped selector");
        continue;
      }
      hitAt(file, base + m.index! + 1, m[1]!);
    }
    for (const m of sel.matchAll(
      /\[\s*class\s*([~|^$*]?)=\s*["']?([^"'\]]+)/g,
    )) {
      const v = m[2]!.trim();
      if (m[1] === "^" || m[1] === "|") prefixes.add(v);
      else if (m[1] === "$") suffixes.add(v);
      else if (m[1] === "*") substrings.add(v);
      else for (const w of v.split(/\s+/)) reserve(w, "attribute selector");
    }
  };
  // A stylesheet's selectors. Comments, strings and url() are blanked first (so
  // `url(x.svg)` reads as no class), and a prelude is only its text after the
  // last `;`, which drops a nested rule's preceding declarations.
  const scanCss = (css: string, file: string, base: number) => {
    const clean = css
      .replace(/\/\*[\s\S]*?\*\//g, blank)
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, blank)
      .replace(/url\([^)]*\)/gi, blank);
    for (const m of clean.matchAll(/([^{};]*)\{/g)) {
      const prelude = m[1]!;
      if (
        /^\s*@(font-face|keyframes|-webkit-keyframes|property|counter-style|page|font-feature-values)\b/.test(
          prelude,
        )
      )
        continue;
      scanSelector(prelude, file, base + m.index!);
    }
  };
  // A class attribute value: whitespace-separated tokens. A token that isn't a
  // plain name (an interpolation, `sm:x`) can't be renamed, so its words reserve.
  const scanClassValue = (
    value: string,
    file: string,
    base: number,
    at: (i: number) => number | undefined,
  ) => {
    for (const m of value.matchAll(/\S+/g)) {
      const t = m[0];
      const off = at(base + m.index!);
      if (IS_NAME.test(t) && off !== undefined) hitAt(file, off, t);
      else
        for (const w of words(t.replace(/\u0000/g, " ")))
          reserve(w, "class token");
    }
  };
  // Markup inside text (a string, or the joined pieces of a template with
  // U+0000 for each interpolation): class attributes and <style> bodies.
  // `at` maps a virtual index to a file offset, or undefined inside an
  // interpolation. Returns the text with both blanked, for the prose rules.
  const CLASS_ATTR = /(\sclass=)(?:(\\?["'])([^"'\\]*)|([^\s"'=<>`\\]+))/g;
  const scanMarkup = (
    s: string,
    file: string,
    at: (i: number) => number | undefined,
  ): string => {
    let rest = s;
    for (const m of s.matchAll(CLASS_ATTR)) {
      const value = m[3] ?? m[4] ?? "";
      const vstart = m.index! + m[1]!.length + (m[2]?.length ?? 0);
      scanClassValue(value, file, vstart, at);
      rest =
        rest.slice(0, vstart) +
        blank(value) +
        rest.slice(vstart + value.length);
    }
    for (const st of s.matchAll(/(<style[^>]*>)([\s\S]*?)<\/style>/g)) {
      const body = st[2]!,
        bstart = st.index! + st[1]!.length;
      // A style body inside a template can hold interpolations; selectors are
      // read only from stretches of real text.
      for (const run of body.matchAll(/[^\u0000]+/g)) {
        const off = at(bstart + run.index!);
        if (off !== undefined) scanCss(run[0], file, off);
      }
      rest =
        rest.slice(0, bstart) + blank(body) + rest.slice(bstart + body.length);
    }
    return rest;
  };

  // ---------- phase 1: parse every script unit ----------
  type Unit = {
    file: string;
    base: number;
    source: string;
    tree: any;
    ts: boolean;
    parents: Map<any, any>;
  };
  const units: Unit[] = [];
  const parseUnit = (file: string, code: string, base: number, ts: boolean) => {
    let src = code;
    if (ts) {
      try {
        src = stripTypes(code, { mode: "strip-only" }).code;
      } catch {
        for (const w of words(code)) reserve(w, "unparsed");
        tainted.set(file, (tainted.get(file) ?? 0) + 1);
        misses.push(`${file} types could not be stripped`);
        return;
      }
      // SAFETY: strip-only blanks types to spaces, so every offset is the source's.
      if (src.length !== code.length)
        throw new Error(
          `classes: ${file} changed length when its types were stripped`,
        );
    }
    let tree: any;
    for (const module of [true, false]) {
      try {
        tree = parse(src, { module });
        tree.figure_out_scope({ module });
        break;
      } catch {
        tree = undefined;
      }
    }
    if (!tree) {
      for (const w of words(code)) reserve(w, "unparsed");
      tainted.set(file, (tainted.get(file) ?? 0) + 1);
      misses.push(`${file} does not parse`);
      return;
    }
    const parents = new Map<any, any>();
    tree.walk(
      new A.TreeWalker(function (this: any, node: any) {
        parents.set(node, this.parent());
      }),
    );
    units.push({ file, base, source: src, tree, ts, parents });
  };
  const SCRIPT = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  const JSON_SCRIPT = /application\/(ld\+)?json|importmap|speculationrules/;
  const htmlFiles: string[] = [];
  const jsonScripts: Array<{ file: string; attrs: string; body: string }> = [];
  for (const [f, t] of files) {
    if (f.endsWith(".ts")) parseUnit(f, t, 0, true);
    else if (/\.(js|mjs)$/.test(f)) parseUnit(f, t, 0, false);
    // An SVG document is markup too: its class attributes and <style> rules.
    else if (f.endsWith(".html") || f.endsWith(".svg")) {
      htmlFiles.push(f);
      for (const s of t.matchAll(SCRIPT)) {
        if (JSON_SCRIPT.test(s[1]!))
          jsonScripts.push({ file: f, attrs: s[1]!, body: s[2]! });
        else if (s[2]!.trim())
          parseUnit(f, s[2]!, s.index! + s[0].indexOf(">") + 1, false);
      }
    }
  }
  const nodeUnit = new Map<any, Unit>();
  for (const u of units) for (const n of u.parents.keys()) nodeUnit.set(n, u);
  const parentOf = (n: any) => nodeUnit.get(n)?.parents.get(n);

  // Raw text of a string literal or template segment, and its file offset.
  const rawOf = (node: any): { text: string; start: number } | undefined => {
    const u = nodeUnit.get(node);
    if (!u || !node.start) return;
    const pos = node.start.pos;
    if (node instanceof A.AST_TemplateSegment)
      return { text: node.raw, start: u.base + pos + 1 };
    if (node instanceof A.AST_String) {
      const q = u.source[pos];
      if (q !== '"' && q !== "'") return; // a property key or directive, not a quoted literal
      let i = pos + 1;
      while (i < u.source.length && u.source[i] !== q)
        i += u.source[i] === "\\" ? 2 : 1;
      return { text: u.source.slice(pos + 1, i), start: u.base + pos + 1 };
    }
  };

  // Option keys across files: every `key: value` property and `x.key = value`.
  const keyValues = new Map<string, any[]>();
  const keyReads = new Map<string, any[]>();
  const addTo = (m: Map<string, any[]>, k: string, v: any) =>
    m.set(k, [...(m.get(k) ?? []), v]);
  const exported = new Map<string, any[]>();
  for (const u of units)
    u.tree.walk(
      new A.TreeWalker((n: any) => {
        if (
          n instanceof A.AST_ObjectKeyVal &&
          typeof n.key === "string" &&
          !(u.parents.get(n) instanceof A.AST_Destructuring)
        )
          addTo(keyValues, n.key, n.value);
        if (
          n instanceof A.AST_Assign &&
          n.left instanceof A.AST_Dot &&
          n.operator === "="
        )
          addTo(keyValues, n.left.property, n.right);
        if (n instanceof A.AST_Dot) {
          const p = u.parents.get(n);
          if (!(p instanceof A.AST_Assign && p.left === n))
            addTo(keyReads, n.property, n);
        }
        if (n instanceof A.AST_Export && n.exported_definition) {
          const d = n.exported_definition;
          if (d instanceof A.AST_Defun && d.name)
            addTo(exported, d.name.name, d);
          if (d instanceof A.AST_Definitions)
            for (const v of d.definitions)
              if (v.value instanceof A.AST_Lambda && v.name?.name)
                addTo(exported, v.name.name, v.value);
        }
      }),
    );

  // ---------- phase 2: trace sinks ----------
  const claimed = new Set<any>(); // literal nodes proven to be class text
  const sinkNodes = new Set<any>(); // every node visited from a sink
  const viaDefs = new Set<any>(),
    viaKeys = new Set<string>(),
    viaFns = new Set<any>();
  const escapingNames = new Set<string>();
  const keyNames = new Set<string>(); // object keys that became class names
  let quiet = false; // fetch-URL probing reads bindings without recording misses
  const subst = new Map<any, any>(); // a helper's parameters, bound to one call's arguments
  const miss = (e: any, why: string) => {
    if (quiet) return;
    const f = nodeUnit.get(e)?.file ?? "?";
    tainted.set(f, (tainted.get(f) ?? 0) + 1);
    misses.push(`${f} ${why} ${e?.TYPE ?? typeof e}`);
  };
  const ITER = new Set([
    "map",
    "forEach",
    "filter",
    "flatMap",
    "some",
    "every",
    "find",
    "findLast",
    "findIndex",
    "reduce",
  ]);
  const PASS = new Set([
    "filter",
    "slice",
    "toSorted",
    "toReversed",
    "concat",
    "flat",
  ]);
  const isLambda = (n: any) => n instanceof A.AST_Lambda;
  const isExported = (n: any) => {
    for (let p = parentOf(n); p; p = parentOf(p)) {
      if (p instanceof A.AST_Export) return true;
      if (p instanceof A.AST_Lambda) return false;
    }
    return false;
  };
  const escape = (lambda: any, fdef: any) => {
    if (quiet) return;
    const name = fdef?.name ?? lambda.name?.name;
    if (name && (fdef?.export || fdef?.global || isExported(lambda)))
      escapingNames.add(name);
    else miss(lambda, "escaping function");
  };

  type Value =
    | { v: any; edge?: "suffix" }
    | { elementsOf: any }
    | { key: string; dflt?: any };
  // Values a binding can hold, or undefined when one source can't be seen.
  const defValues = (def: any): Value[] | undefined => {
    if (!def || def.undeclared || (def.global && !def.orig?.length)) return;
    const out: Value[] = [];
    for (const o of def.orig) {
      const p = parentOf(o);
      if (o instanceof A.AST_SymbolFunarg) {
        let q = p,
          dflt;
        if (q instanceof A.AST_DefaultAssign && q.left === o) {
          dflt = q.right;
          q = parentOf(q);
        }
        if (
          q instanceof A.AST_ObjectKeyVal &&
          parentOf(q) instanceof A.AST_Destructuring
        ) {
          out.push({ key: q.key, dflt });
          continue;
        }
        if (!isLambda(q)) return;
        const lambda = q,
          i = lambda.argnames.findIndex((a: any) => a === o || a?.left === o);
        if (dflt) out.push({ v: dflt });
        const lp = parentOf(lambda);
        if (
          lp instanceof A.AST_Call &&
          lp.args[0] === lambda &&
          lp.expression instanceof A.AST_Dot &&
          ITER.has(lp.expression.property)
        ) {
          if (i === 0 && lp.expression.property !== "reduce") {
            out.push({ elementsOf: lp.expression.expression });
            continue;
          }
          return;
        }
        // A local function: every reference must be a direct call, or a
        // callback handed to an iterator (its first argument is an element).
        const fdef =
          lambda.name?.thedef ??
          (lp instanceof A.AST_VarDef && lp.value === lambda
            ? lp.name.thedef
            : undefined);
        if (!fdef || fdef.export || isExported(lambda)) {
          escape(lambda, fdef);
          return;
        }
        for (const r of fdef.references) {
          const rp = parentOf(r);
          if (
            rp instanceof A.AST_Call &&
            rp.args[0] === r &&
            rp.expression instanceof A.AST_Dot &&
            ITER.has(rp.expression.property) &&
            rp.expression.property !== "reduce"
          ) {
            if (i !== 0) return;
            out.push({ elementsOf: rp.expression.expression });
            continue;
          }
          if (!(rp instanceof A.AST_Call && rp.expression === r)) {
            escape(lambda, fdef);
            return;
          }
          if (rp.args.some((a: any) => a instanceof A.AST_Expansion)) return;
          if (rp.args[i]) out.push({ v: rp.args[i] });
        }
        continue;
      }
      if (p instanceof A.AST_VarDef && p.name === o) {
        if (p.value) out.push({ v: p.value });
        // for (const s of X): the VarDef has no value and sits in the ForOf init.
        const defs = parentOf(p),
          loop = defs && parentOf(defs);
        if (!p.value && loop instanceof A.AST_ForOf && loop.init === defs)
          out.push({ elementsOf: loop.object });
      } else if (
        o instanceof A.AST_SymbolDefun ||
        o instanceof A.AST_SymbolLambda
      )
        out.push({ v: parentOf(o) });
      else return;
    }
    for (const r of def.references) {
      const rp = parentOf(r);
      if (rp instanceof A.AST_Assign && rp.left === r) {
        if (rp.operator === "=") out.push({ v: rp.right });
        else if (rp.operator === "+=")
          out.push({ v: rp.right, edge: "suffix" });
        else return;
      }
      if (
        (rp instanceof A.AST_UnaryPrefix && /\+\+|--/.test(rp.operator)) ||
        rp instanceof A.AST_UnaryPostfix
      )
        return;
    }
    return out;
  };

  const returnsOf = (fn: any): any[] => {
    if (fn instanceof A.AST_Arrow && fn.body && !Array.isArray(fn.body))
      return [fn.body];
    const out: any[] = [];
    for (const s of fn.body ?? [])
      s.walk(
        new A.TreeWalker((m: any) => {
          if (m !== s && isLambda(m)) return true;
          if (m instanceof A.AST_Return && m.value) out.push(m.value);
        }),
      );
    return out;
  };
  const calleeFn = (call: any): any | undefined => {
    const e = call.expression;
    if (isLambda(e)) return e;
    if (!(e instanceof A.AST_SymbolRef) || !e.thedef || e.thedef.undeclared)
      return;
    const o = e.thedef.orig[0],
      p = parentOf(o);
    if (o instanceof A.AST_SymbolDefun) return p;
    if (
      p instanceof A.AST_VarDef &&
      isLambda(p.value) &&
      e.thedef.orig.length === 1 &&
      !e.thedef.references.some(
        (r: any) =>
          parentOf(r) instanceof A.AST_Assign && parentOf(r).left === r,
      )
    )
      return p.value;
  };
  // An imported helper: the one exported function of that name in the tree.
  const importedFn = (call: any): any | undefined => {
    const e = call.expression;
    if (!(e instanceof A.AST_SymbolRef) || !e.thedef) return;
    const o = e.thedef.orig[0];
    if (!(o instanceof A.AST_SymbolImport)) return;
    const p = parentOf(o);
    const name =
      p instanceof A.AST_NameMapping
        ? (p.foreign_name?.name ?? o.name)
        : o.name;
    const fns = exported.get(name);
    return fns?.length === 1 ? fns[0] : undefined;
  };

  // Object literals an expression can evaluate to, or undefined.
  const objects = (e: any, depth: number): any[] | undefined => {
    if (!e || depth > 10) return;
    sinkNodes.add(e);
    if (e instanceof A.AST_Object) return [e];
    if (e instanceof A.AST_Array) return arrayElementObjects(e, depth);
    if (e instanceof A.AST_Conditional) {
      const a = objects(e.consequent, depth + 1),
        b = objects(e.alternative, depth + 1);
      return a && b ? [...a, ...b] : undefined;
    }
    if (e instanceof A.AST_SymbolRef) {
      const vs = defValues(e.thedef);
      if (!vs) return;
      viaDefs.add(e.thedef);
      const out: any[] = [];
      for (const v of vs) {
        const o =
          "elementsOf" in v
            ? objects(v.elementsOf, depth + 1)
            : "v" in v
              ? objects(v.v, depth + 1)
              : undefined;
        if (!o) return;
        out.push(...o);
      }
      return out;
    }
    if (
      e instanceof A.AST_Call &&
      e.expression instanceof A.AST_Dot &&
      PASS.has(e.expression.property)
    )
      return objects(e.expression.expression, depth + 1);
    if (e instanceof A.AST_Sub) {
      const os = objects(e.expression, depth + 1);
      if (!os) return arrayElementObjects(e.expression, depth + 1);
      const out: any[] = [];
      for (const o of os)
        for (const p of o.properties) {
          if (!(p instanceof A.AST_ObjectKeyVal)) return;
          const v = objects(p.value, depth + 1);
          if (!v) return;
          out.push(...v);
        }
      return out;
    }
    if (e instanceof A.AST_Call) {
      const fn = calleeFn(e);
      if (!fn) return;
      viaFns.add(fn);
      const out: any[] = [];
      for (const r of returnsOf(fn)) {
        const o = objects(r, depth + 1);
        if (!o) return;
        out.push(...o);
      }
      return out;
    }
  };
  const arrayElementObjects = (arr: any, depth: number): any[] | undefined => {
    if (arr instanceof A.AST_Array) {
      const out: any[] = [];
      for (const x of arr.elements) {
        const o = objects(x, depth + 1);
        if (!o) return;
        out.push(...o);
      }
      return out;
    }
    if (arr instanceof A.AST_SymbolRef) {
      const vs = defValues(arr.thedef);
      if (!vs) return;
      viaDefs.add(arr.thedef);
      const out: any[] = [];
      for (const v of vs) {
        if (!("v" in v)) return;
        const o = arrayElementObjects(v.v, depth + 1);
        if (!o) return;
        out.push(...o);
      }
      return out;
    }
  };

  // DOM reads a sink couldn't trace: an attribute a script reads can carry its
  // value into a class, so its values are reserved wherever markup writes them,
  // and a text read reserves page text.
  const attrsRead = new Set<string>();
  let allAttrsRead = false,
    textRead = false;
  const REFLECTED = new Set([
    "id",
    "title",
    "href",
    "src",
    "alt",
    "name",
    "value",
    "content",
    "rel",
    "type",
    "lang",
    "dir",
    "role",
    "label",
    "placeholder",
  ]);
  const TEXT = new Set([
    "textContent",
    "innerText",
    "innerHTML",
    "outerHTML",
    "nodeValue",
    "data",
    "text",
  ]);
  const noteDomRead = (e: any) => {
    if (e instanceof A.AST_Dot) {
      if (
        e.expression instanceof A.AST_Dot &&
        e.expression.property === "dataset"
      )
        attrsRead.add(
          "data-" +
            e.property.replace(/[A-Z]/g, (c: string) => "-" + c.toLowerCase()),
        );
      else if (REFLECTED.has(e.property)) attrsRead.add(e.property);
      else if (TEXT.has(e.property)) textRead = true;
    }
    if (
      e instanceof A.AST_Call &&
      e.expression instanceof A.AST_Dot &&
      e.expression.property === "getAttribute"
    ) {
      if (e.args[0] instanceof A.AST_String) attrsRead.add(e.args[0].value);
      else allAttrsRead = true;
    }
  };

  type Mode = "class" | "selector" | "reserve";
  type Piece = { kind: "lit"; node: any } | { kind: "expr"; node: any };
  const flatten = (e: any): Piece[] => {
    if (e instanceof A.AST_TemplateString)
      return e.segments.flatMap((s: any) =>
        s instanceof A.AST_TemplateSegment
          ? [{ kind: "lit", node: s } as Piece]
          : flatten(s),
      );
    if (e instanceof A.AST_PrefixedTemplateString)
      return flatten(e.template_string);
    if (e instanceof A.AST_Binary && e.operator === "+")
      return [...flatten(e.left), ...flatten(e.right)];
    if (e instanceof A.AST_String) return [{ kind: "lit", node: e }];
    return [{ kind: "expr", node: e }];
  };
  const litText = (node: any): string =>
    node instanceof A.AST_TemplateSegment
      ? node.raw
      : (rawOf(node)?.text ?? node.value);
  // A literal proven to be class text, as a class list or a selector.
  const claimLiteral = (node: any, mode: Mode) => {
    if (claimed.has(node)) return;
    claimed.add(node);
    const raw = rawOf(node);
    const file = nodeUnit.get(node)?.file ?? "?";
    const text = raw?.text ?? node.value;
    if (mode === "reserve")
      for (const w of words(text)) reserve(w, "attribute read");
    else if (mode === "selector") {
      if (raw) scanSelector(raw.text, file, raw.start);
      else for (const w of words(text)) reserve(w, "unplaced literal");
    } else if (raw) scanClassValue(raw.text, file, raw.start, (i) => i);
    else for (const w of words(text)) reserve(w, "unplaced literal");
  };

  // Resolve a value flowing into a class position.
  const resolve = (
    e: any,
    depth: number,
    seen: Set<any>,
    mode: Mode = "class",
  ): void => {
    if (!e || seen.has(e)) return;
    if (depth > 12) {
      miss(e, "depth");
      return;
    }
    seen.add(e);
    sinkNodes.add(e);
    if (e instanceof A.AST_String) {
      claimLiteral(e, mode);
      return;
    }
    if (
      e instanceof A.AST_Number ||
      e instanceof A.AST_Boolean ||
      e instanceof A.AST_Null ||
      e instanceof A.AST_Undefined ||
      e instanceof A.AST_Atom
    )
      return;
    if (
      e instanceof A.AST_UnaryPrefix &&
      ["!", "typeof", "-", "+", "void"].includes(e.operator)
    )
      return;
    if (
      e instanceof A.AST_Binary &&
      [
        "<",
        ">",
        "<=",
        ">=",
        "==",
        "===",
        "!=",
        "!==",
        "instanceof",
        "in",
        "-",
        "*",
        "/",
        "%",
        "|",
        "&",
        "^",
        "<<",
        ">>",
        ">>>",
      ].includes(e.operator)
    )
      return;
    if (e instanceof A.AST_PrefixedTemplateString) {
      resolve(e.template_string, depth + 1, seen, mode);
      return;
    }
    if (
      e instanceof A.AST_TemplateString ||
      (e instanceof A.AST_Binary && e.operator === "+")
    ) {
      const pieces = flatten(e);
      if (mode === "selector") {
        // A dynamic piece of a selector names a class only after a `.`; inside
        // [attr="..."], after `#`, or in a pseudo-class's parentheses it can't.
        let acc = "";
        pieces.forEach((p, i) => {
          if (p.kind === "lit") {
            claimLiteral(p.node, "selector");
            acc += litText(p.node);
            return;
          }
          const opens = (o: string, c: string) =>
            acc.lastIndexOf(o) > acc.lastIndexOf(c);
          const cls = acc.match(/\.(-?[_a-zA-Z][\w-]*)?$/);
          if (opens("[", "]") || opens("(", ")") || /#[\w-]*$/.test(acc)) {
            /* attribute value, id or pseudo argument */
          } else if (cls) {
            if (cls[1]) prefixes.add(cls[1]);
            const next = pieces[i + 1];
            if (next?.kind === "lit") {
              const w = firstWord(litText(next.node));
              if (w) suffixes.add(w);
            }
            resolve(p.node, depth + 1, seen, "class");
          } else resolve(p.node, depth + 1, seen, "selector");
          acc += "\u0000";
        });
        return;
      }
      pieces.forEach((p, i) => {
        if (p.kind === "expr") {
          resolve(p.node, depth + 1, seen, mode);
          return;
        }
        claimLiteral(p.node, mode);
        const s = litText(p.node);
        if (pieces[i + 1]?.kind === "expr") {
          const w = lastWord(s);
          if (w) prefixes.add(w);
        }
        if (pieces[i - 1]?.kind === "expr") {
          const w = firstWord(s);
          if (w) suffixes.add(w);
        }
      });
      return;
    }
    if (e instanceof A.AST_Conditional) {
      resolve(e.consequent, depth + 1, seen, mode);
      resolve(e.alternative, depth + 1, seen, mode);
      return;
    }
    if (e instanceof A.AST_Binary && ["||", "&&", "??"].includes(e.operator)) {
      resolve(e.left, depth + 1, seen, mode);
      resolve(e.right, depth + 1, seen, mode);
      return;
    }
    if (e instanceof A.AST_Chain) {
      resolve(e.expression, depth + 1, seen, mode);
      return;
    }
    if (e instanceof A.AST_Sequence) {
      resolve(e.expressions.at(-1), depth + 1, seen, mode);
      return;
    }
    if (e instanceof A.AST_SymbolRef && subst.has(e.thedef)) {
      const a = subst.get(e.thedef);
      if (a) resolve(a, depth + 1, new Set(), mode);
      return;
    }
    if (e instanceof A.AST_SymbolRef) {
      const vs = defValues(e.thedef);
      if (!vs) {
        miss(e, "binding");
        return;
      }
      viaDefs.add(e.thedef);
      for (const v of vs) {
        if ("elementsOf" in v)
          resolveElements(v.elementsOf, depth + 1, seen, mode);
        else if ("key" in v) {
          viaKeys.add(v.key);
          if (v.dflt) resolve(v.dflt, depth + 1, seen, mode);
          for (const x of keyValues.get(v.key) ?? [])
            resolve(x, depth + 1, seen, mode);
        } else {
          if (v.edge === "suffix" && v.v instanceof A.AST_String) {
            const w = firstWord(v.v.value);
            if (w) suffixes.add(w);
          }
          resolve(v.v, depth + 1, seen, mode);
        }
      }
      return;
    }
    if (e instanceof A.AST_Dot) {
      const os = objects(e.expression, 0);
      if (!os) {
        noteDomRead(e);
        miss(e, "member object");
        return;
      }
      viaKeys.add(e.property);
      for (const o of os) {
        if (
          o.properties.some(
            (p: any) =>
              !(p instanceof A.AST_ObjectKeyVal) || typeof p.key !== "string",
          )
        ) {
          miss(e, "object shape");
          return;
        }
        const prop = o.properties.find((p: any) => p.key === e.property);
        if (prop) resolve(prop.value, depth + 1, seen, mode);
      }
      return;
    }
    if (e instanceof A.AST_Sub) {
      // A lookup table: every value of the object, or every element of the array.
      const os = objects(e.expression, 0);
      if (!os) {
        resolveElements(e.expression, depth + 1, seen, mode);
        return;
      }
      for (const o of os)
        for (const p of o.properties) {
          if (!(p instanceof A.AST_ObjectKeyVal)) {
            miss(e, "table shape");
            return;
          }
          resolve(p.value, depth + 1, seen, mode);
        }
      return;
    }
    if (e instanceof A.AST_Call) {
      const ex = e.expression;
      if (ex instanceof A.AST_Dot && ex.property === "join") {
        resolveElements(ex.expression, depth + 1, seen, mode);
        if (e.args[0]) resolve(e.args[0], depth + 1, seen, mode);
        return;
      }
      if (
        ex instanceof A.AST_Dot &&
        ["trim", "trimStart", "trimEnd"].includes(ex.property) &&
        !e.args.length
      ) {
        resolve(ex.expression, depth + 1, seen, mode);
        return;
      }
      // .replace(re, ...) whose pattern matches no name character (HTML
      // escaping, slash trimming) leaves class names intact.
      if (
        ex instanceof A.AST_Dot &&
        ["replace", "replaceAll"].includes(ex.property) &&
        e.args[0] instanceof A.AST_RegExp
      ) {
        const src = String(e.args[0].value?.source ?? "")
          .replace(/\\[^A-Za-z0-9]/g, "")
          .replace(/\(\?<?[!=:]/g, "");
        if (!/[A-Za-z0-9_\s-]/.test(src)) {
          resolve(ex.expression, depth + 1, seen, mode);
          return;
        }
      }
      if (
        ex instanceof A.AST_SymbolRef &&
        ex.name === "String" &&
        ex.thedef?.undeclared
      ) {
        resolve(e.args[0], depth + 1, seen, mode);
        return;
      }
      // An element stringifies to "[object HTML...Element]".
      if (
        ex instanceof A.AST_Dot &&
        [
          "closest",
          "querySelector",
          "getElementById",
          "createElement",
          "cloneNode",
        ].includes(ex.property)
      ) {
        reserve("object", "element string");
        return;
      }
      const fn = calleeFn(e) ?? importedFn(e);
      if (fn) {
        viaFns.add(fn);
        resolveCallReturns(e, fn, depth, seen, mode);
        return;
      }
      noteDomRead(e);
      miss(e, "call");
      return;
    }
    miss(e, "expression");
  };
  // A helper's returns for one call, with its parameters bound to that call's
  // arguments. `new Wrapper(param)` (an Html marker) passes the argument through.
  const resolveCallReturns = (
    call: any,
    fn: any,
    depth: number,
    seen: Set<any>,
    mode: Mode,
  ) => {
    const argOf = (r: any) =>
      r instanceof A.AST_SymbolRef
        ? fn.argnames.findIndex(
            (a: any) => (a?.left ?? a) === r.thedef?.orig[0],
          )
        : -1;
    const added: any[] = [];
    fn.argnames.forEach((a: any, i: number) => {
      const sym = a instanceof A.AST_DefaultAssign ? a.left : a;
      if (!(sym instanceof A.AST_SymbolFunarg) || subst.has(sym.thedef)) return;
      if (
        sym.thedef.references.some(
          (r: any) =>
            parentOf(r) instanceof A.AST_Assign && parentOf(r).left === r,
        )
      )
        return;
      if (
        call.args.slice(0, i + 1).some((x: any) => x instanceof A.AST_Expansion)
      )
        return;
      subst.set(
        sym.thedef,
        call.args[i] ?? (a instanceof A.AST_DefaultAssign ? a.right : null),
      );
      added.push(sym.thedef);
    });
    try {
      for (const r of returnsOf(fn)) {
        if (argOf(r) >= 0) resolve(call.args[argOf(r)], depth + 1, seen, mode);
        else if (
          r instanceof A.AST_New &&
          r.args.length === 1 &&
          argOf(r.args[0]) >= 0
        )
          resolve(call.args[argOf(r.args[0])], depth + 1, seen, mode);
        else resolve(r, depth + 1, seen, mode);
      }
    } finally {
      for (const d of added) subst.delete(d);
    }
  };
  // Elements of an array-valued expression, resolved as class values.
  const resolveElements = (
    arr: any,
    depth: number,
    seen: Set<any>,
    mode: Mode,
  ): void => {
    if (!arr) return;
    sinkNodes.add(arr);
    if (arr instanceof A.AST_Array) {
      for (const x of arr.elements) {
        if (x instanceof A.AST_Expansion)
          resolveElements(x.expression, depth + 1, seen, mode);
        else resolve(x, depth + 1, seen, mode);
      }
      return;
    }
    if (arr instanceof A.AST_Call && arr.expression instanceof A.AST_Dot) {
      const p = arr.expression.property,
        obj = arr.expression.expression;
      if (PASS.has(p)) {
        resolveElements(obj, depth + 1, seen, mode);
        if (p === "concat")
          for (const a of arr.args) resolveElements(a, depth + 1, seen, mode);
        return;
      }
      if (p === "map" && isLambda(arr.args[0])) {
        for (const r of returnsOf(arr.args[0]))
          resolve(r, depth + 1, seen, mode);
        return;
      }
      if (
        obj instanceof A.AST_SymbolRef &&
        obj.name === "Object" &&
        obj.thedef?.undeclared &&
        (p === "keys" || p === "values")
      ) {
        const os = objects(arr.args[0], 0);
        if (!os) {
          miss(arr, "Object.keys source");
          return;
        }
        for (const o of os)
          for (const q of o.properties) {
            if (
              !(q instanceof A.AST_ObjectKeyVal) ||
              typeof q.key !== "string"
            ) {
              miss(arr, "object shape");
              return;
            }
            // A key that becomes a class can't be renamed without breaking its
            // lookups, so it is counted and reserved.
            if (p === "keys") {
              for (const w of words(q.key)) count(w);
              keyNames.add(q.key);
            } else resolve(q.value, depth + 1, seen, mode);
          }
        return;
      }
    }
    if (arr instanceof A.AST_SymbolRef) {
      const vs = defValues(arr.thedef);
      if (!vs) {
        miss(arr, "array binding");
        return;
      }
      viaDefs.add(arr.thedef);
      for (const v of vs) {
        if (!("v" in v)) {
          miss(arr, "array source");
          return;
        }
        resolveElements(v.v, depth + 1, seen, mode);
      }
      // push(x) into the array adds elements too.
      for (const r of arr.thedef.references) {
        const d = parentOf(r),
          c = d && parentOf(d);
        if (
          d instanceof A.AST_Dot &&
          d.expression === r &&
          (d.property === "push" || d.property === "unshift") &&
          c instanceof A.AST_Call &&
          c.expression === d
        ) {
          sinkNodes.add(c);
          for (const a of c.args) resolve(a, depth + 1, seen, mode);
        }
      }
      return;
    }
    if (arr instanceof A.AST_Dot) {
      const os = objects(arr.expression, 0);
      if (!os) {
        miss(arr, "array member");
        return;
      }
      viaKeys.add(arr.property);
      for (const o of os) {
        const p = o.properties.find((q: any) => q.key === arr.property);
        if (p) resolveElements(p.value, depth + 1, seen, mode);
      }
      return;
    }
    miss(arr, "array expression");
  };

  // The virtual text of a template or concat chain: its literal pieces' raw
  // text with U+0000 for each interpolation, and the map back to file offsets.
  type Chain = {
    text: string;
    at: (i: number) => number | undefined;
    pieces: Piece[];
    litAt: Array<{ node: any; from: number; to: number }>;
  };
  const chainOf = (n: any): Chain => {
    const pieces = flatten(n);
    let text = "";
    const spans: Array<{
      from: number;
      to: number;
      start: number | undefined;
    }> = [];
    const litAt: Chain["litAt"] = [];
    for (const p of pieces) {
      if (p.kind === "expr") {
        text += "\u0000";
        continue;
      }
      const raw = rawOf(p.node);
      const s = raw?.text ?? litText(p.node);
      spans.push({
        from: text.length,
        to: text.length + s.length,
        start: raw?.start,
      });
      litAt.push({
        node: p.node,
        from: text.length,
        to: text.length + s.length,
      });
      text += s;
    }
    const at = (i: number) => {
      for (const sp of spans)
        if (i >= sp.from && i < sp.to)
          return sp.start === undefined ? undefined : sp.start + (i - sp.from);
    };
    return { text, at, pieces, litAt };
  };
  const isChain = (n: any) =>
    n instanceof A.AST_PrefixedTemplateString ||
    n instanceof A.AST_TemplateString ||
    n instanceof A.AST_String ||
    (n instanceof A.AST_Binary && n.operator === "+");
  const isTop = (n: any, parents: Map<any, any>) => {
    const p = parents.get(n);
    return (
      !(p instanceof A.AST_Binary && p.operator === "+") &&
      !(p instanceof A.AST_TemplateString) &&
      !(p instanceof A.AST_PrefixedTemplateString)
    );
  };

  const SELECTOR = new Set([
    "querySelector",
    "querySelectorAll",
    "closest",
    "matches",
  ]);
  const CLASSLIST = new Set(["add", "remove", "toggle", "contains", "replace"]);
  for (const u of units)
    u.tree.walk(
      new A.TreeWalker((n: any) => {
        if (n instanceof A.AST_Call && n.expression instanceof A.AST_Dot) {
          const p = n.expression.property,
            obj = n.expression.expression;
          if (
            CLASSLIST.has(p) &&
            obj instanceof A.AST_Dot &&
            obj.property === "classList"
          )
            for (const a of n.args.slice(0, p === "toggle" ? 1 : undefined))
              resolve(a, 0, new Set());
          if (p === "getElementsByClassName" && n.args[0])
            resolve(n.args[0], 0, new Set());
          if (SELECTOR.has(p) && n.args[0])
            resolve(n.args[0], 0, new Set(), "selector");
          if (
            p === "setAttribute" &&
            n.args[0] instanceof A.AST_String &&
            n.args[0].value === "class"
          )
            resolve(n.args[1], 0, new Set());
        }
        if (
          n instanceof A.AST_Assign &&
          n.left instanceof A.AST_Dot &&
          // Assigning a string to classList sets the class attribute too.
          (n.left.property === "className" || n.left.property === "classList")
        )
          resolve(n.right, 0, new Set());
        // An interpolation inside an open class="..." or a <style> selector.
        if (isChain(n) && !(n instanceof A.AST_String) && isTop(n, u.parents)) {
          const { pieces } = chainOf(n);
          let acc = "";
          pieces.forEach((p, i) => {
            if (p.kind === "lit") {
              acc += litText(p.node);
              return;
            }
            if (/\sclass=(\\?["'][^"'\\]*|[^\s"'=<>`\\]*)$/.test(acc)) {
              const w = lastWord(acc);
              if (w) prefixes.add(w);
              const next = pieces[i + 1];
              if (next?.kind === "lit") {
                const s = firstWord(litText(next.node));
                if (s) suffixes.add(s);
              }
              resolve(p.node, 0, new Set());
            }
            const css = acc.match(/<style[^>]*>([^<]*)$/)?.[1];
            if (
              css !== undefined &&
              css.lastIndexOf("{") <= css.lastIndexOf("}")
            )
              resolve(p.node, 0, new Set(), "selector");
            acc += "\u0000";
          });
        }
      }),
    );
  // Markup a script builds for an attribute some script reads: its literal words
  // are reserved and its interpolations traced in reserve mode, to a fixed point.
  const OPEN_ATTR = /\s([\w:-]+)=\\?["']([^"'\\]*)$/;
  for (let seen = -1; seen !== attrsRead.size + (allAttrsRead ? 1e6 : 0);) {
    seen = attrsRead.size + (allAttrsRead ? 1e6 : 0);
    const read = (a: string) =>
      a !== "class" && (allAttrsRead || attrsRead.has(a));
    for (const u of units)
      u.tree.walk(
        new A.TreeWalker((n: any) => {
          if (!(isChain(n) && isTop(n, u.parents))) return;
          const { text, pieces } = chainOf(n);
          for (const m of text.matchAll(/\s([\w:-]+)=\\?["']([^"'\\]*)/g))
            if (read(m[1]!))
              for (const w of words(m[2]!.replace(/\u0000/g, " ")))
                reserve(w, "attribute read");
          let acc = "";
          for (const p of pieces) {
            if (p.kind === "lit") {
              acc += litText(p.node);
              continue;
            }
            const open = acc.match(OPEN_ATTR);
            if (open && read(open[1]!))
              resolve(p.node, 0, new Set(), "reserve");
            acc += "\u0000";
          }
        }),
      );
  }
  // An escaping function's callers live in files that mention its name.
  for (const name of escapingNames) {
    const re = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`);
    for (const [f, t] of files)
      if (/\.(js|mjs|ts|html)$/.test(f) && re.test(t)) {
        tainted.set(f, (tainted.get(f) ?? 0) + 1);
        misses.push(`${f} may call the escaping function ${name}`);
      }
  }

  // ---------- phase 3: dual use ----------
  const inSink = (n: any) => {
    for (let p: any = n; p; p = parentOf(p)) {
      if (sinkNodes.has(p)) return true;
      if (p instanceof A.AST_Statement || isLambda(p)) return false;
    }
    return false;
  };
  const reserveClaimed = (e: any) =>
    e?.walk?.(
      new A.TreeWalker((m: any) => {
        if (
          (m instanceof A.AST_String || m instanceof A.AST_TemplateSegment) &&
          claimed.has(m)
        )
          for (const w of words(litText(m))) reserve(w, "dual-use");
      }),
    );
  for (const def of viaDefs) {
    const dual = def.references.some((r: any) => {
      const rp = parentOf(r);
      return !(rp instanceof A.AST_Assign && rp.left === r) && !inSink(r);
    });
    if (dual)
      for (const v of defValues(def) ?? [])
        reserveClaimed(
          "v" in v ? v.v : "elementsOf" in v ? v.elementsOf : undefined,
        );
  }
  for (const k of viaKeys)
    if ((keyReads.get(k) ?? []).some((d) => !inSink(d)))
      for (const v of keyValues.get(k) ?? []) reserveClaimed(v);
  for (const fn of viaFns) {
    const p = parentOf(fn);
    const def =
      fn.name?.thedef ??
      (p instanceof A.AST_VarDef ? p.name.thedef : undefined);
    if ((def?.references ?? []).some((r: any) => !inSink(parentOf(r))))
      for (const r of returnsOf(fn)) reserveClaimed(r);
  }
  for (const k of keyNames) for (const w of words(k)) reserve(w, "object key");

  // ---------- phase 4: what reads JSON ----------
  // Each file's script text and markup text, cut once. jsonReaders asks for
  // them once per JSON file, and recutting every page for each of 230 JSON
  // files was half of a census on aadhar.sh (1.3 of 2.6 s, 2026-11-23).
  const codeCache = new Map<string, string>();
  const codeOf = (g: string) => {
    let code = codeCache.get(g);
    if (code === undefined) {
      code = g.endsWith(".html")
        ? [...files.get(g)!.matchAll(SCRIPT)]
            .filter((m) => !JSON_SCRIPT.test(m[1]!))
            .map((m) => m[2]!)
            .join("\n")
        : files.get(g)!;
      codeCache.set(g, code);
    }
    return code;
  };
  const markupCache = new Map<string, string>();
  const markupOf = (g: string) => {
    let markup = markupCache.get(g);
    if (markup === undefined) {
      markup = files
        .get(g)!
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/g, " ")
        .replace(/<script([^>]*)>[\s\S]*?<\/script>/g, " $1 ");
      markupCache.set(g, markup);
    }
    return markup;
  };
  const served = (path: string) => join(options.publicDir, path.split("?")[0]!);
  const pageScripts = (g: string) => {
    const out = [g];
    for (const m of files
      .get(g)!
      .matchAll(/<script[^>]*\ssrc=["']?([^"' >]+)/g))
      if (files.has(served(m[1]!))) out.push(served(m[1]!));
    return out;
  };
  // The literal start of a fetch URL, or undefined when it can't be seen.
  const heads = (e: any, depth: number): string[] | undefined => {
    if (!e || depth > 10) return;
    if (e instanceof A.AST_String) return [e.value];
    if (
      e instanceof A.AST_TemplateString ||
      (e instanceof A.AST_Binary && e.operator === "+")
    ) {
      const p = flatten(e)[0]!;
      return p.kind === "lit" ? [p.node.value] : heads(p.node, depth + 1);
    }
    if (e instanceof A.AST_Conditional) {
      const a = heads(e.consequent, depth + 1),
        b = heads(e.alternative, depth + 1);
      return a && b ? [...a, ...b] : undefined;
    }
    if (
      e instanceof A.AST_Binary &&
      (e.operator === "||" || e.operator === "??")
    ) {
      const a = heads(e.left, depth + 1),
        b = heads(e.right, depth + 1);
      return a && b ? [...a, ...b] : undefined;
    }
    if (
      (e instanceof A.AST_New || e instanceof A.AST_Call) &&
      e.expression instanceof A.AST_SymbolRef &&
      ["URL", "Request"].includes(e.expression.name)
    )
      return e.args[1] ? undefined : heads(e.args[0], depth + 1);
    if (
      e instanceof A.AST_Call &&
      e.expression instanceof A.AST_Dot &&
      e.expression.property === "toString"
    )
      return heads(e.expression.expression, depth + 1);
    if (e instanceof A.AST_SymbolRef) {
      const vs = defValues(e.thedef);
      if (!vs?.length) return;
      const out: string[] = [];
      for (const v of vs) {
        if (!("v" in v)) return;
        const h = heads(v.v, depth + 1);
        if (!h) return;
        out.push(...h);
      }
      return out;
    }
    if (e instanceof A.AST_Dot) {
      const os = objects(e.expression, 0);
      if (!os) return;
      const out: string[] = [];
      for (const o of os) {
        const p = o.properties.find((q: any) => q.key === e.property);
        if (!p) continue;
        const h = heads(p.value, depth + 1);
        if (!h) return;
        out.push(...h);
      }
      return out;
    }
  };
  // A fetch whose response is only read as bytes or status reads no text.
  const BINARY = new Set([
    "arrayBuffer",
    "blob",
    "ok",
    "status",
    "statusText",
    "headers",
    "body",
    "url",
    "redirected",
    "type",
    "bytes",
  ]);
  const readsNoText = (call: any): boolean => {
    const seen = new Set<any>();
    const refsSafe = (def: any): boolean =>
      !!def &&
      def.references.every((r: any) => {
        const p = parentOf(r);
        return (
          p instanceof A.AST_Dot && p.expression === r && BINARY.has(p.property)
        );
      });
    const flows = (n: any, depth: number): boolean => {
      if (depth > 8) return false;
      if (seen.has(n)) return true;
      seen.add(n);
      const p = parentOf(n);
      if (p instanceof A.AST_Await) return flows(p, depth + 1);
      if (p instanceof A.AST_VarDef && p.value === n)
        return refsSafe(p.name.thedef);
      if (p instanceof A.AST_Dot && p.expression === n) {
        if (p.property !== "then") return BINARY.has(p.property);
        const c = parentOf(p),
          cb = c?.args?.[0];
        if (!(c instanceof A.AST_Call) || !isLambda(cb)) return false;
        const a = cb.argnames[0];
        return !a || (a instanceof A.AST_SymbolFunarg && refsSafe(a.thedef));
      }
      if (p instanceof A.AST_SimpleStatement) return true;
      // The body of a wrapper like (url, init) => fetch(url, init): follow its callers.
      let fnNode: any;
      if (isLambda(p) && !Array.isArray(p.body) && p.body === n) fnNode = p;
      if (p instanceof A.AST_Return)
        for (let q = parentOf(p); q && !fnNode; q = parentOf(q))
          if (isLambda(q)) fnNode = q;
      if (!fnNode) return false;
      const lp = parentOf(fnNode);
      const holder =
        lp instanceof A.AST_Binary &&
        (lp.operator === "??" || lp.operator === "||")
          ? parentOf(lp)
          : lp;
      const def =
        holder instanceof A.AST_VarDef ? holder.name.thedef : undefined;
      if (!def) return false;
      return def.references.every((r: any) => {
        const c = parentOf(r);
        return (
          c instanceof A.AST_Call && c.expression === r && flows(c, depth + 1)
        );
      });
    };
    return flows(call, 0);
  };
  const fetchHeads = new Map<string, string[] | "any">();
  for (const u of units) {
    if (!tainted.has(u.file)) continue;
    u.tree.walk(
      new A.TreeWalker((n: any) => {
        const isFetch =
          n instanceof A.AST_Call &&
          ((n.expression instanceof A.AST_SymbolRef &&
            (n.expression.name === "fetch" ||
              n.expression.name === "import")) ||
            (n.expression instanceof A.AST_Dot &&
              n.expression.property === "fetch"));
        if (!isFetch || fetchHeads.get(u.file) === "any") return;
        quiet = true;
        let h: string[] | undefined;
        try {
          h = heads(n.args[0], 0) ?? (readsNoText(n) ? [] : undefined);
        } finally {
          quiet = false;
        }
        if (!h) {
          fetchHeads.set(u.file, "any");
          return;
        }
        const prior = fetchHeads.get(u.file);
        fetchHeads.set(u.file, [
          ...(prior === "any" ? [] : (prior ?? [])),
          ...h
            .map((x) => x.replace(/^https:\/\/assets\.local/, ""))
            .map((x) => (/^[a-z]+:/i.test(x) ? "\u0000external" : x)),
        ]);
      }),
    );
  }
  const anyReaders = [...fetchHeads]
    .filter(
      ([, h]) =>
        h === "any" ||
        h.some((x) => !x.startsWith("/") && x !== "\u0000external"),
    )
    .map(([g]) => g);
  const fetchesPath = (path: string) =>
    [...fetchHeads]
      .filter(
        ([, h]) =>
          h !== "any" &&
          h.some((x) => {
            const head = x.split("?")[0]!;
            return (
              head.length > 1 && head.startsWith("/") && path.startsWith(head)
            );
          }),
      )
      .map(([g]) => g);
  const jsonReaders = (stem: string) => {
    const re = new RegExp(
      `(^|[/"'\`=\\s])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}((\\.[0-9a-f]{8})?\\.json|["'\`])`,
    );
    const out = new Set<string>(anyReaders);
    // `includes` first: the regex can only match text that holds the stem.
    for (const g of files.keys()) {
      if (!/\.(js|mjs|ts|html)$/.test(g) || !files.get(g)!.includes(stem))
        continue;
      const code = codeOf(g);
      if (code.includes(stem) && re.test(code)) out.add(g);
      if (g.endsWith(".html")) {
        const markup = markupOf(g);
        if (markup.includes(stem) && re.test(markup))
          for (const p of pageScripts(g)) out.add(p);
      }
    }
    return [...out];
  };
  const publicPrefix = options.publicDir.replace(/\/?$/, "/");
  for (const [f, t] of files) {
    if (!f.endsWith(".json")) continue;
    const stem = basename(f)
      .replace(/\.json$/, "")
      .replace(/\.[0-9a-f]{8}$/, "");
    const readers = [
      ...jsonReaders(stem),
      ...(f.startsWith(publicPrefix)
        ? fetchesPath("/" + f.slice(publicPrefix.length))
        : []),
    ];
    const why = !readers.length
      ? "json (no reader)"
      : readers.some((g) => tainted.has(g))
        ? "json (tainted reader)"
        : undefined;
    if (why) for (const w of words(t)) reserve(w, why);
  }
  for (const js of jsonScripts) {
    const id = js.attrs.match(/\bid=["']?([\w-]+)/)?.[1];
    const type = js.attrs.match(/type=["']?([\w/+-]+)/)?.[1] ?? "";
    const mentions = (c: string) =>
      c.includes(type) || (!!id && c.includes(id));
    const readers = [...files.keys()].filter(
      (g) => /\.(js|mjs|html)$/.test(g) && mentions(codeOf(g)),
    );
    if (readers.some((g) => tainted.has(g)) || (readers.length && !id))
      for (const w of words(js.body)) reserve(w, "json script (read)");
  }

  // ---------- phase 5: markup, stylesheets, prose ----------
  for (const [f, t] of files) if (f.endsWith(".css")) scanCss(t, f, 0);
  for (const f of htmlFiles) {
    const t = files.get(f)!;
    for (const s of t.matchAll(/(<style[^>]*>)([\s\S]*?)<\/style>/g))
      scanCss(s[2]!, f, s.index! + s[1]!.length);
    // Script and style bodies blanked, so offsets stay the file's.
    const body = t.replace(/<(style|script)([^>]*)>[\s\S]*?<\/\1>/g, blank);
    if (textRead)
      for (const w of words(body.replace(/<[^>]*>/g, " ")))
        reserve(w, "page text read");
    for (const m of body.matchAll(
      /\s([\w:-]+)=(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
    )) {
      const attr = m[1]!,
        v = m[2] ?? m[3] ?? m[4] ?? "";
      const vstart =
        m.index! + m[0].length - v.length - (m[4] === undefined ? 1 : 0);
      if (attr === "class") scanClassValue(v, f, vstart, (i) => i);
      else if (allAttrsRead || attrsRead.has(attr) || /^on|^style$/.test(attr))
        for (const w of words(v)) reserve(w, `attr ${attr}`);
    }
  }
  const scanned = new Set<any>();
  for (const u of units) {
    const isTainted = tainted.has(u.file);
    const why = u.ts ? "worker string" : "client string";
    u.tree.walk(
      new A.TreeWalker((n: any) => {
        if (!(isChain(n) && isTop(n, u.parents))) return;
        const chain = chainOf(n);
        for (const l of chain.litAt) scanned.add(l.node);
        // Claimed pieces were counted where they were claimed; prose rules read the rest.
        const unclaimed = chain.litAt.filter((l) => !claimed.has(l.node));
        if (!unclaimed.length) return;
        let text = chain.text;
        for (const l of chain.litAt)
          if (claimed.has(l.node))
            text =
              text.slice(0, l.from) +
              blank(text.slice(l.from, l.to)) +
              text.slice(l.to);
        const p = u.parents.get(n);
        if (
          p instanceof A.AST_ObjectKeyVal &&
          /css|style/i.test(String(p.key))
        ) {
          for (const run of text.matchAll(/[^\u0000]+/g)) {
            const off = chain.at(run.index!);
            if (off !== undefined) scanCss(run[0], u.file, off);
          }
          return;
        }
        const rest = scanMarkup(text, u.file, chain.at);
        if (isTainted)
          for (const w of words(rest.replace(/\u0000/g, " "))) reserve(w, why);
        else if (rest.includes("{"))
          for (const m of rest.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g))
            reserve(m[1]!, why + " (css-shaped)");
      }),
    );
  }

  // The net under every rule above: a literal no chain reached (a node shape
  // the walk doesn't model, as tagged templates were until 2026-11-22) reserves
  // its words, so a blind spot costs names instead of breaking a page.
  for (const u of units)
    u.tree.walk(
      new A.TreeWalker((n: any) => {
        if (!(n instanceof A.AST_String || n instanceof A.AST_TemplateSegment))
          return;
        if (scanned.has(n) || claimed.has(n)) return;
        // A property key or an import path is a string node too; neither is text a page shows.
        const p = u.parents.get(n);
        if (
          p instanceof A.AST_Import ||
          p instanceof A.AST_Export ||
          p instanceof A.AST_ImportMeta
        )
          return;
        for (const w of words(litText(n))) reserve(w, "unscanned literal");
        misses.push(
          `${u.file} unscanned literal ${String(litText(n)).slice(0, 40)}`,
        );
      }),
    );

  const renameable = new Set<string>();
  const placed = new Map<string, number>();
  for (const p of positions) placed.set(p.name, (placed.get(p.name) ?? 0) + 1);
  for (const [n, c] of counts) {
    if (reserved.has(n) || placed.get(n) !== c) continue;
    if (
      [...prefixes].some((x) => n.startsWith(x)) ||
      [...suffixes].some((x) => n.endsWith(x)) ||
      [...substrings].some((x) => n.includes(x))
    )
      continue;
    renameable.add(n);
  }
  return {
    positions,
    counts,
    reserved,
    prefixes,
    suffixes,
    substrings,
    tainted,
    renameable,
    misses,
  };
}

/** Whether a new name is free: no class has it, nothing could become it, and no fragment rule catches it. */
export function nameIsFree(census: ClassCensus, name: string): boolean {
  if (census.counts.has(name) || census.reserved.has(name)) return false;
  for (const x of census.prefixes) if (name.startsWith(x)) return false;
  for (const x of census.suffixes) if (name.endsWith(x)) return false;
  for (const x of census.substrings) if (name.includes(x)) return false;
  return true;
}

/** Rewrite every recorded position of each mapped name. Files without one come back unchanged. */
export function applyClassNames(
  files: ReadonlyMap<string, string>,
  census: ClassCensus,
  map: ReadonlyMap<string, string>,
): Map<string, string> {
  for (const [from, to] of map) {
    if (!census.renameable.has(from))
      throw new Error(`classes: ${from} is not renameable`);
    if (!IS_NAME.test(to))
      throw new Error(`classes: ${to} is not a class name`);
  }
  const byFile = new Map<string, ClassPosition[]>();
  for (const p of census.positions)
    if (map.has(p.name)) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
  const out = new Map(files);
  for (const [file, ps] of byFile) {
    const text = files.get(file)!;
    ps.sort((a, b) => a.start - b.start);
    let result = "",
      at = 0;
    for (const p of ps) {
      // SAFETY: the census recorded this offset from this exact text.
      if (text.slice(p.start, p.start + p.name.length) !== p.name)
        throw new Error(`classes: ${file}:${p.start} does not hold ${p.name}`);
      if (p.start < at)
        throw new Error(
          `classes: ${file}:${p.start} overlaps the position before it`,
        );
      result += text.slice(at, p.start) + map.get(p.name);
      at = p.start + p.name.length;
    }
    out.set(file, result + text.slice(at));
  }
  return out;
}

/**
 * Prove a rename: the census of the renamed tree must hold the same positions
 * with each name mapped, the same reservations, and no class it didn't have.
 * `floor` is the fewest renamed names that counts as a working census, so a
 * collector that quietly stops matching fails rather than passing clean.
 */
export function assertClassIntegrity(
  before: ClassCensus,
  after: ClassCensus,
  map: ReadonlyMap<string, string>,
  floor: number,
): void {
  if (map.size < floor)
    throw new Error(
      `classes: only ${map.size} names renamed, below the floor of ${floor}`,
    );
  const expected = new Map<string, number>();
  for (const [n, c] of before.counts) {
    const to = map.get(n) ?? n;
    expected.set(to, (expected.get(to) ?? 0) + c);
  }
  const problems: string[] = [];
  for (const [n, c] of expected)
    if ((after.counts.get(n) ?? 0) !== c)
      problems.push(
        `${n}: ${c} positions expected, ${after.counts.get(n) ?? 0} found`,
      );
  for (const [n] of after.counts)
    if (!expected.has(n)) problems.push(`${n}: a class the tree didn't have`);
  for (const n of map.keys())
    if (after.counts.has(n))
      problems.push(`${n}: still present after the rename`);
  if (before.positions.length !== after.positions.length)
    problems.push(
      `${before.positions.length} positions before, ${after.positions.length} after`,
    );
  for (const [n, why] of before.reserved)
    if (!map.has(n) && !after.reserved.has(n))
      problems.push(`${n}: reserved before (${why}), not after`);
  if (problems.length)
    throw new Error(
      `classes: the rename changed more than names:\n  ${problems.slice(0, 20).join("\n  ")}`,
    );
}
