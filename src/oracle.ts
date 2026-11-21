// The oracle: does a minified file do the same things to the outside world as
// its source?
//
// "The outside world" is every global the file did not define itself. The
// oracle gives each one a recording stub, runs the source and the candidate in
// fresh node:vm contexts, then fires every callback either run handed to a stub
// (event listeners, timers, observers), and compares the two effect traces:
// calls with their arguments, property writes, deletes, thrown error classes,
// and the globals the file left behind. Reads are not recorded, because a
// minifier may legally drop a read whose value is unused.
//
// A stub answers every question with another stub, so code walks deep into
// paths a page would take with real DOM. Three answers are fixed so that walks
// end: `length` is 0, iterators are empty, and a path more than MAX_DEPTH
// segments deep reads as undefined (so `while (el = el.parentElement)` stops).
// `then` reads as undefined, so `await stub` resolves instead of recursing.
//
// Names never enter the trace, since a minifier renames locals. Paths are built
// from property names, call order and argument positions, which survive.
import vm from "node:vm";

export type Effect = string;

export type Trace = { effects: Effect[]; truncated: boolean };

export type OracleInput = { code: string; kind: "script" | "module" };

export type Verdict =
  | { kind: "same"; effects: number }
  | { kind: "different"; world: string; at: number; source: Effect | undefined; candidate: Effect | undefined }
  | { kind: "source-failed"; world: string; reason: string };

const MAX_DEPTH = 12;
const MAX_EFFECTS = 60_000;
const MAX_CALLBACKS = 4_000;
const RUN_TIMEOUT_MS = 500;

// Identifier-like tokens from both texts; each one that is not already a
// global of a fresh context gets a stub. Over-supplying is harmless because a
// local declaration shadows a global of the same name.
const freeNameCandidates = (texts: string[]): Set<string> => {
  const names = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) names.add(m[0]);
  return names;
};

// Mulberry32, so Math.random agrees between the two runs.
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const KEYWORDS = new Set(
  "await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return static super switch this throw true try typeof var void while with yield async of get set undefined NaN Infinity eval arguments globalThis".split(
    " ",
  ),
);

type Recorder = {
  effects: Effect[];
  callbacks: Array<{ fn: Function; path: string }>;
  truncated: boolean;
};

const record = (rec: Recorder, effect: Effect) => {
  if (rec.effects.length < MAX_EFFECTS) rec.effects.push(effect);
  else rec.truncated = true;
};

const STUB_PATH = Symbol("spokeshave.stubPath");

// A world decides the answers the stubs give where the source could branch
// either way. Code guards on things like `if (window.__booted) return` (true
// under deep stubs) and `if (!el) return` (false under deep stubs), so each
// file runs in every world and a candidate has to agree in all of them.
export type World = { name: string; emptyWindow: boolean; callsReturnNull: boolean; oneItemLists: boolean };

export const WORLDS: readonly World[] = [
  { name: "deep", emptyWindow: false, callsReturnNull: false, oneItemLists: false },
  { name: "fresh-window", emptyWindow: true, callsReturnNull: false, oneItemLists: false },
  { name: "fresh-window-one-item", emptyWindow: true, callsReturnNull: false, oneItemLists: true },
  { name: "fresh-window-null-calls", emptyWindow: true, callsReturnNull: true, oneItemLists: false },
];

// Property names the code assigns somewhere (`.x = `). On a fresh page those
// are unset, so the fresh-window world reads them on window and document as
// undefined while platform APIs like window.setTimeout stay stubs.
const assignedNames = (texts: string[]): Set<string> => {
  const names = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(/\.([A-Za-z_$][\w$]*)\s*(?:=(?!=)|\|\|=|\?\?=)/g)) names.add(m[1]!);
  return names;
};

const makeStubs = (rec: Recorder, world: World, assigned: Set<string>) => {
  const callCounts = new Map<string, number>();
  const stubs = new Map<string, unknown>();

  const describe = (value: unknown, depth = 0): string => {
    if (value === null) return "null";
    const type = typeof value;
    if (type === "undefined") return "undefined";
    if (type === "number") return Object.is(value, -0) ? "-0" : String(value);
    if (type === "string") return JSON.stringify(value);
    if (type === "boolean" || type === "bigint") return String(value);
    if (type === "symbol") return "symbol";
    if (type === "function") {
      const path = (value as { [STUB_PATH]?: string })[STUB_PATH];
      return path === undefined ? "fn" : `stub:${path}`;
    }
    const path = (value as { [STUB_PATH]?: string })[STUB_PATH];
    if (path !== undefined) return `stub:${path}`;
    if (depth >= 2) return "obj";
    if (Array.isArray(value)) return `[${value.map((v) => describe(v, depth + 1)).join(",")}]`;
    let keys: string[];
    try {
      keys = Object.keys(value as object).sort();
    } catch {
      return "obj";
    }
    return `{${keys.map((k) => `${k}:${describe((value as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
  };

  const queueCallbacks = (path: string, args: unknown[]) => {
    args.forEach((arg, i) => {
      if (typeof arg === "function" && (arg as { [STUB_PATH]?: string })[STUB_PATH] === undefined && rec.callbacks.length < MAX_CALLBACKS) {
        rec.callbacks.push({ fn: arg as Function, path: `${path}#arg${i}` });
      }
    });
  };

  // An island publishes its API as `window.X = { mount, run }`; the functions
  // inside a written value are what other code would call, so they get fired too.
  const queueFunctionsIn = (path: string, value: unknown, depth: number) => {
    if (typeof value === "function") {
      queueCallbacks(path, [value]);
      return;
    }
    if (value === null || typeof value !== "object" || depth >= 2 || (value as { [STUB_PATH]?: string })[STUB_PATH] !== undefined) return;
    for (const key of Object.keys(value).sort()) queueFunctionsIn(`${path}.${key}`, (value as Record<string, unknown>)[key], depth + 1);
  };

  const stub = (path: string, depth: number): unknown => {
    const existing = stubs.get(path);
    if (existing !== undefined) return existing;
    const written = new Map<PropertyKey, unknown>();
    const target = function () {} as unknown as object;
    const call = (args: unknown[], verb: string) => {
      const n = callCounts.get(path) ?? 0;
      callCounts.set(path, n + 1);
      record(rec, `${verb} ${path}(${args.map((a) => describe(a)).join(",")})`);
      queueCallbacks(`${path}@${n}`, args);
      return world.callsReturnNull ? null : stub(`${path}@${n}()`, depth + 1);
    };
    const proxy = new Proxy(target, {
      get(_t, prop) {
        if (prop === STUB_PATH) return path;
        if (written.has(prop)) return written.get(prop);
        if (prop === Symbol.toPrimitive) return (hint: string) => (hint === "number" ? 0 : `[${path}]`);
        if (prop === Symbol.iterator) return world.oneItemLists ? function* () { yield stub(`${path}[0]`, depth + 1); } : function* () {};
        if (prop === Symbol.asyncIterator) return async function* () {};
        if (typeof prop === "symbol") return undefined;
        if (prop === "then") return undefined;
        if (prop === "length") return world.oneItemLists && depth < MAX_DEPTH - 2 ? 1 : 0;
        if (prop === "0" && world.oneItemLists) return stub(`${path}[0]`, depth + 1);
        if (prop === "toString" || prop === "valueOf") return () => `[${path}]`;
        if (prop === "toJSON") return () => `[${path}]`;
        if (depth >= MAX_DEPTH) return undefined;
        if (world.emptyWindow && (path === "window" || path === "document") && assigned.has(prop)) return undefined;
        return stub(`${path}.${prop}`, depth + 1);
      },
      set(_t, prop, value) {
        record(rec, `set ${path}.${String(prop)}=${describe(value)}`);
        queueFunctionsIn(`${path}.${String(prop)}`, value, 0);
        written.set(prop, value);
        return true;
      },
      deleteProperty(_t, prop) {
        record(rec, `delete ${path}.${String(prop)}`);
        written.delete(prop);
        return true;
      },
      has: () => true,
      defineProperty(_t, prop, desc) {
        record(rec, `define ${path}.${String(prop)}=${describe(desc.value)}`);
        written.set(prop, desc.value);
        return true;
      },
      getOwnPropertyDescriptor: () => undefined,
      ownKeys: () => ["prototype"],
      apply: (_t, _this, args) => call(args, "call"),
      construct: (_t, args) => call(args, "new") as object,
    });
    stubs.set(path, proxy);
    return proxy;
  };

  return { stub, describe };
};

// Static import/export only parse in a module, whatever the caller called the
// file, so the run follows the syntax.
export const parsesAsScript = (code: string): boolean => {
  try {
    new vm.Script(code);
    return true;
  } catch {
    return false;
  }
};

const errorName = (e: unknown): string => {
  if (e !== null && typeof e === "object" && "constructor" in e) return String((e as { constructor: { name?: string } }).constructor?.name ?? "Error");
  return typeof e;
};

const run = async (input: OracleInput, names: Set<string>, assigned: Set<string>, seed: number, world: World): Promise<Trace & { globals: string }> => {
  const rec: Recorder = { effects: [], callbacks: [], truncated: false };
  const { stub, describe } = makeStubs(rec, world, assigned);
  const context = vm.createContext({});
  const builtins = new Set(vm.runInContext("Object.getOwnPropertyNames(globalThis)", context) as string[]);
  const stubbed = new Set<string>();
  for (const name of names) {
    if (builtins.has(name) || KEYWORDS.has(name)) continue;
    context[name] = stub(name, 0);
    stubbed.add(name);
  }
  // `window`, `self` and `globalThis` writes are all writes to the page's
  // global, so they share one stub path.
  context.window = context.self = stub("window", 0);
  const random = seeded(seed);
  vm.runInContext("Math.random = __r; delete globalThis.__r; const RealDate = Date; globalThis.Date = class Date extends RealDate { constructor(...args) { if (args.length === 0) super(1767225600000); else super(...args); } static now() { return 1767225600000; } };", Object.assign(context, { __r: random }));

  const before = new Set(vm.runInContext("Object.getOwnPropertyNames(globalThis)", context) as string[]);
  try {
    if (input.kind === "module" || !parsesAsScript(input.code)) {
      const mod = new vm.SourceTextModule(input.code, { context });
      await mod.link(async (specifier) => {
        record(rec, `import ${specifier}`);
        const synthetic = new vm.SyntheticModule(["default"], function () {
          this.setExport("default", stub(`import:${specifier}`, 0));
        }, { context });
        return synthetic;
      });
      await mod.evaluate({ timeout: RUN_TIMEOUT_MS });
      const ns = mod.namespace as Record<string, unknown>;
      for (const key of Object.keys(ns).sort()) {
        const value = ns[key];
        record(rec, `export ${key}:${typeof value}`);
        if (typeof value === "function") rec.callbacks.push({ fn: value as Function, path: `export:${key}` });
      }
    } else {
      new vm.Script(input.code).runInContext(context, { timeout: RUN_TIMEOUT_MS });
    }
  } catch (e) {
    record(rec, `throw ${errorName(e)}`); if (process.env.SPOKESHAVE_DEBUG) console.error(e);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Fire callbacks in the order the run registered them; a callback may
  // register more, and the queue cap bounds the total.
  for (let i = 0; i < rec.callbacks.length && i < MAX_CALLBACKS; i++) {
    const { fn, path } = rec.callbacks[i]!;
    record(rec, `fire ${path}`);
    try {
      // Called through the context so the vm timeout bounds a callback that loops.
      Object.assign(context, { __spokeshave_cb: [fn, stub(`this:${path}`, 0), stub(`event:${path}`, 0), stub(`arg1:${path}`, 0)] });
      const result = vm.runInContext("__spokeshave_cb[0].call(__spokeshave_cb[1], __spokeshave_cb[2], __spokeshave_cb[3])", context, { timeout: RUN_TIMEOUT_MS });
      if (result instanceof Promise || (result && typeof (result as { then?: unknown }).then === "function")) {
        await Promise.race([Promise.resolve(result).then(
          (v) => record(rec, `resolve ${describe(v)}`),
          (e) => record(rec, `reject ${errorName(e)}`),
        ), new Promise((resolve) => setTimeout(resolve, 50))]);
      } else {
        record(rec, `return ${describe(result)}`);
      }
    } catch (e) {
      record(rec, `throw ${errorName(e)}`);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 0));

  const after = vm.runInContext("Object.getOwnPropertyNames(globalThis)", context) as string[];
  const created = after.filter((n) => !before.has(n)).sort();
  const changed = [...stubbed].filter((n) => context[n] !== stub(n, 0)).sort();
  const globals = [...created, ...changed].map((n) => `${n}:${describe(context[n])}`).join(";");
  if (process.env.SPOKESHAVE_TRACE) console.error(world.name, process.env.SPOKESHAVE_TRACE === "all" ? rec.effects : rec.effects.slice(0, 40));
  return { effects: rec.effects, truncated: rec.truncated, globals };
};

// Compare a candidate against its source. The seed makes Math.random agree;
// running each side twice with the same seed and requiring the source to agree
// with itself catches nondeterminism the stubs did not cover (a real timer
// race, say), which would otherwise read as a minifier bug.
export const compare = async (source: OracleInput, candidate: OracleInput, seed = 1, worlds: readonly World[] = WORLDS): Promise<Verdict> => {
  const names = freeNameCandidates([source.code, candidate.code]);
  const assigned = assignedNames([source.code, candidate.code]);
  let effects = 0;
  for (const world of worlds) {
    const a = await run(source, names, assigned, seed, world);
    const a2 = await run(source, names, assigned, seed, world);
    if (a.effects.join("\n") !== a2.effects.join("\n") || a.globals !== a2.globals) return { kind: "source-failed", world: world.name, reason: "the source trace changes between two seeded runs" };
    const b = await run(candidate, names, assigned, seed, world);
    const sourceEffects = [...a.effects, `globals ${a.globals}`];
    const candidateEffects = [...b.effects, `globals ${b.globals}`];
    const n = Math.max(sourceEffects.length, candidateEffects.length);
    for (let i = 0; i < n; i++) {
      if (sourceEffects[i] !== candidateEffects[i]) return { kind: "different", world: world.name, at: i, source: sourceEffects[i], candidate: candidateEffects[i] };
    }
    effects += sourceEffects.length;
  }
  return { kind: "same", effects };
};
