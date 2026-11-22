// The compression-aware renamer: rename the bindings in already-minified code
// to whatever names make it smallest in brotli, and prove the result is the
// same program.
//
// Minifiers pick names by frequency, which is right for raw bytes. Brotli
// cares instead about repeats: `e=>e.x` written the same way in six closures
// compresses better than six spellings of it. On aadhar.sh's 26 own scripts
// (2026-11-21) this took the committed picks from 95,536 to 95,025 B brotli
// (-511 B, -0.53%) in about 3 minutes. A wider search found -572 B in 16.
//
// Two searches run in turn, each accepting a change only when q11 shrinks:
//   1. Swap two names everywhere in the file. That is a bijection on names,
//      so it is legal whenever both names belong only to renameable bindings.
//   2. Rename one binding at a time, trying names that other bindings carry
//      in the same 4-character context. A rename to m is legal when no other
//      binding named m is declared in, or referenced from, any scope that
//      declares or references this one (terser's scope.enclosed lists those).
//
// Every result must pass alphaEquivalent, which re-analyses both texts and
// compares them with each binding named by its first occurrence. A rename that
// let one binding capture another's reference fails it. Before block scopes
// were part of the legality check, 5 of 26 files failed it, so it is not
// decorative.
//
// Scope analysis comes from terser, whose parser and scope code live in files
// its package exports do not list. They are loaded by path next to terser's
// entry point; conformance/rename.test.ts fails if they move.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, constants as zlib } from "node:zlib";

const lib = join(dirname(fileURLToPath(import.meta.resolve("terser"))), "lib");
const { parse } = await import(pathToFileURL(join(lib, "parse.js")).href);
const ast = await import(pathToFileURL(join(lib, "ast.js")).href);
await import(pathToFileURL(join(lib, "scope.js")).href);
const { AST_Scope, AST_Symbol, AST_ObjectKeyVal, AST_NameMapping, TreeWalker } =
  ast;

const RESERVED = new Set(
  "do if in for let new try var case else enum eval null this true void with await break catch class const false super throw while yield delete export import public return static switch typeof default extends finally package private continue debugger function arguments interface protected implements instanceof undefined NaN Infinity async of get set".split(
    " ",
  ),
);

type Occurrence = { start: number; end: number; shorthand: string | null };
// `any` here is terser's internal AST and scope objects, which ship no types.
type Binding = {
  def: any;
  original: string;
  name: string;
  occurrences: Occurrence[];
  scopes: Set<any>;
  renameable: boolean;
};

export type RenameOptions = {
  module: boolean;
  toplevel: boolean;
  // A binding with an occurrence right after one of these strings keeps its
  // name. aadhar.sh passes ["--"]: its build reads every `--name` token in
  // the staged tree as a taken CSS custom-property name, so a decremented
  // variable renamed from `n` to `e` (`--n` to `--e`) shifted every CSS name
  // on the site.
  pinAfter?: readonly string[];
};

// A rename map: [binding ordinal, new name] pairs, the ordinal being the
// binding's position when bindings are sorted by first occurrence. It is what
// a caller stores to replay a search without running it again.
export type RenameMap = Array<[number, string]>;

const brotli = (code: string, quality: number) =>
  brotliCompressSync(Buffer.from(code), {
    params: { [zlib.BROTLI_PARAM_QUALITY]: quality },
  }).length;

function analyse(code: string, options: RenameOptions) {
  // A file with static import/export parses only as a module, whatever the
  // caller called it; `toplevel` still follows the caller.
  let module = options.module;
  let tree: any;
  try {
    tree = parse(code, { module });
  } catch (e) {
    if (module) throw e;
    module = true;
    tree = parse(code, { module });
  }
  tree.figure_out_scope({ module });
  const byDef = new Map<any, Binding>();
  const globals = new Set<string>();
  const scopes: any[] = [];
  const walker: any = new TreeWalker((node: any) => {
    if (node instanceof AST_Scope) scopes.push(node);
    // let/const/class blocks carry their scope as a property, not a child node.
    if (node.block_scope) scopes.push(node.block_scope);
    if (
      !(node instanceof AST_Symbol) ||
      typeof node.name !== "string" ||
      !node.start
    )
      return;
    const def = node.definition?.();
    if (!def) return;
    const name: string = node.name;
    if (def.undeclared) globals.add(name);
    let binding = byDef.get(def);
    if (binding === undefined) {
      const renameable =
        !def.undeclared &&
        !(def.global && !options.toplevel) &&
        !def.scope?.pinned?.() &&
        !def.export;
      binding = {
        def,
        original: name,
        name,
        occurrences: [],
        scopes: new Set(),
        renameable,
      };
      byDef.set(def, binding);
    }
    const parent = walker.parent();
    const start: number = node.start.pos;
    // terser's token endpos is not an end offset; the name's length is, and a
    // name spelled with escapes fails this check and stays put.
    if (
      parent instanceof AST_NameMapping ||
      code.slice(start, start + name.length) !== name ||
      options.pinAfter?.some((before) => code.endsWith(before, start))
    ) {
      binding.renameable = false;
      return;
    }
    const shorthand =
      parent instanceof AST_ObjectKeyVal &&
      parent.start.pos === start &&
      parent.key === name
        ? name
        : null;
    binding.occurrences.push({ start, end: start + name.length, shorthand });
  });
  tree.walk(walker);
  for (const scope of scopes) {
    for (const def of scope.enclosed ?? []) byDef.get(def)?.scopes.add(scope);
    for (const def of scope.variables?.values?.() ?? [])
      byDef.get(def)?.scopes.add(scope);
  }
  for (const binding of byDef.values())
    if (binding.def.scope) binding.scopes.add(binding.def.scope);
  const all = [...byDef.values()];
  const live = all
    .filter((b) => b.renameable && b.occurrences.length > 0)
    .sort((a, b) => a.occurrences[0]!.start - b.occurrences[0]!.start);
  return { all, live, globals };
}

function render(code: string, bindings: Binding[]): string {
  const edits: Array<Occurrence & { to: string }> = [];
  for (const b of bindings)
    if (b.renameable && b.name !== b.original)
      for (const o of b.occurrences) edits.push({ ...o, to: b.name });
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const edit of edits) {
    out +=
      code.slice(at, edit.start) +
      (edit.shorthand ? `${edit.shorthand}:${edit.to}` : edit.to);
    at = edit.end;
  }
  return out + code.slice(at);
}

// Same program up to the names of its bindings.
export function alphaEquivalent(
  a: string,
  b: string,
  options: RenameOptions,
): boolean {
  const canonical = (code: string) => {
    const { all, live } = analyse(code, options);
    live.forEach((binding, i) => (binding.name = `$${i}$`));
    return render(code, all);
  };
  try {
    return canonical(a) === canonical(b);
  } catch {
    return false;
  }
}

// Replay a stored search. Throws if the map does not fit this code, or if the
// result is not alpha-equivalent to it.
export function applyRenames(
  code: string,
  map: RenameMap,
  options: RenameOptions,
): string {
  const { all, live } = analyse(code, options);
  for (const [ordinal, name] of map) {
    const binding = live[ordinal];
    if (binding === undefined)
      throw new Error(
        `rename map names binding ${ordinal}, and this code has ${live.length}`,
      );
    binding.name = name;
  }
  const out = render(code, all);
  if (!alphaEquivalent(code, out, options))
    throw new Error("rename map does not keep this code the same program");
  return out;
}

function swapNames(
  code: string,
  all: Binding[],
  live: Binding[],
  state: { size: number; quality: number },
) {
  const pinned = new Set(all.filter((b) => !b.renameable).map((b) => b.name));
  const frequency = new Map<string, number>();
  for (const b of live)
    if (!pinned.has(b.name))
      frequency.set(
        b.name,
        (frequency.get(b.name) ?? 0) + b.occurrences.length,
      );
  const pool = [...frequency.keys()]
    .sort((x, y) => frequency.get(y)! - frequency.get(x)! || (x < y ? -1 : 1))
    .slice(0, 60);
  const swap = (x: string, y: string) => {
    for (const b of live) b.name = b.name === x ? y : b.name === y ? x : b.name;
  };
  for (let pass = 0; pass < 2; pass++) {
    let improved = false;
    for (let i = 0; i < pool.length; i++)
      for (let j = i + 1; j < pool.length; j++) {
        swap(pool[i]!, pool[j]!);
        const size = brotli(render(code, all), state.quality);
        if (size < state.size) {
          state.size = size;
          improved = true;
        } else swap(pool[i]!, pool[j]!);
      }
    if (!improved) return;
  }
}

function renameEach(
  code: string,
  all: Binding[],
  live: Binding[],
  globals: Set<string>,
  state: { size: number; quality: number },
) {
  const byScope = new Map<any, Binding[]>();
  for (const b of all)
    for (const s of b.scopes)
      (byScope.get(s) ?? byScope.set(s, []).get(s)!).push(b);
  const legal = (b: Binding, m: string) => {
    if (RESERVED.has(m) || globals.has(m)) return false;
    for (const scope of b.scopes)
      for (const other of byScope.get(scope) ?? [])
        if (other !== b && other.name === m) return false;
    return true;
  };
  const keyOf = (o: Occurrence) =>
    `${code.slice(Math.max(0, o.start - 4), o.start)}|${code.slice(o.end, o.end + 4)}`;
  const context = new Map<string, Map<string, number>>();
  for (const b of live)
    for (const o of b.occurrences) {
      const names =
        context.get(keyOf(o)) ??
        context.set(keyOf(o), new Map()).get(keyOf(o))!;
      names.set(b.name, (names.get(b.name) ?? 0) + 1);
    }
  const common = [...new Set(live.map((b) => b.name))]
    .filter((n) => !globals.has(n) && !RESERVED.has(n))
    .slice(0, 4);
  const order = [...live].sort(
    (a, b) =>
      b.occurrences.length - a.occurrences.length ||
      a.occurrences[0]!.start - b.occurrences[0]!.start,
  );
  let evaluations = 0;
  for (let pass = 0; pass < 2 && evaluations < 4000; pass++) {
    let improved = false;
    for (const b of order) {
      if (evaluations >= 4000) break;
      const score = new Map<string, number>();
      for (const o of b.occurrences)
        for (const [n, c] of context.get(keyOf(o)) ?? [])
          if (n !== b.name) score.set(n, (score.get(n) ?? 0) + c);
      const ranked = [...score]
        .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
        .map(([n]) => n);
      const candidates = [
        ...new Set([...ranked.slice(0, 6), ...common]),
      ].filter((n) => n !== b.name);
      const was = b.name;
      let best = was;
      for (const m of candidates) {
        if (!legal(b, m)) continue;
        b.name = m;
        evaluations++;
        const size = brotli(render(code, all), state.quality);
        if (size < state.size) {
          state.size = size;
          best = m;
        }
      }
      b.name = best;
      if (best !== was) improved = true;
    }
    if (!improved) return;
  }
}

export type RenameResult = {
  code: string;
  map: RenameMap;
  before: number;
  after: number;
};

// Search for a smaller naming. Returns the input unchanged (and an empty map)
// when nothing beats it at q11.
export function renameForBrotli(
  code: string,
  options: RenameOptions,
): RenameResult {
  const { all, live, globals } = analyse(code, options);
  // Large files score with q9 during the search to bound its time; the result
  // is judged at q11 either way.
  const state = { quality: code.length > 40_000 ? 9 : 11, size: 0 };
  state.size = brotli(code, state.quality);
  swapNames(code, all, live, state);
  renameEach(code, all, live, globals, state);
  const out = render(code, all);
  const before = brotli(code, 11);
  const after = brotli(out, 11);
  if (after >= before || !alphaEquivalent(code, out, options))
    return { code, map: [], before, after: before };
  const map: RenameMap = live.flatMap((b, i): RenameMap =>
    b.name === b.original ? [] : [[i, b.name]],
  );
  return { code: out, map, before, after };
}
