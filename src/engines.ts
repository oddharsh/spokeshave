// The four minifiers spokeshave runs, each behind the same signature, so a
// candidate is a list of engine names and the portfolio never special-cases one.
//
// Every engine is an exact pin in package.json. Upstream improvements arrive
// the day a pin moves: the portfolio re-runs every engine on every file and
// keeps whichever output is smallest and still passes the oracle, so nothing
// here has to know what changed upstream.
//
// SWC runs as @swc/wasm rather than the native @swc/core. On 2026-11-21 the
// native binding failed to load in Cloudflare Workers Builds (Linux x64, Bun
// 1.4.6 canary) while it loaded on GitHub's Ubuntu runner; the WebAssembly
// build has no platform package to resolve. Its output was byte-identical to
// @swc/core 1.16.22 on all 27 aadhar.sh scripts, at 180 ms against 77 ms.
import { minify as swcMinify } from "@swc/wasm";
import { minifySync as oxcMinify } from "oxc-minify";
import type { MinifyOptions as OxcOptions } from "oxc-minify";
import { minify as terserMinify } from "terser";

export type SourceKind = "script" | "module";

export type EngineInput = {
  filename: string;
  code: string;
  // How the file parses: a file with static import/export is a module.
  kind: SourceKind;
  // What the caller called it. oxc keeps the caller's mode, so a caller that
  // already shipped oxc output gets the same bytes back from the oxc candidate.
  declared: SourceKind;
  // Rename top-level bindings. Safe for a module; for a classic script the
  // top level is the global object, so other scripts may read those names.
  toplevel: boolean;
};

export type EngineName = "oxc" | "bun" | "swc" | "terser";

export type Engine = {
  name: EngineName;
  run: (input: EngineInput) => Promise<string>;
};

// oxc options start from the ones aadhar.sh shipped with before spokeshave
// (tools/lib/oxc-minify-options.ts there); the conservative treeshake block is
// a claim that the inputs talk to each other through globals.
export const oxcOptions = (input: EngineInput): OxcOptions => ({
  module: input.declared === "module",
  compress: {
    target: "esnext",
    dropDebugger: true,
    unused: true,
    joinVars: true,
    sequences: true,
    treeshake: {
      annotations: true,
      propertyReadSideEffects: "always",
      propertyWriteSideEffects: true,
      unknownGlobalSideEffects: true,
      invalidImportSideEffects: true,
    },
  },
  mangle: { toplevel: input.toplevel },
  codegen: { removeWhitespace: true, legalComments: "none" },
});

const oxc: Engine = {
  name: "oxc",
  run: async (input) => {
    const result = oxcMinify(input.filename, input.code, oxcOptions(input));
    if (result.errors.length > 0)
      throw new Error(`oxc: ${result.errors.map((e) => e.message).join("; ")}`);
    return result.code;
  },
};

// Bun has no single-file minify API (Bun.minify is undefined as of 1.4.4), so
// this goes through the bundler with every import external. The bundler always
// treats its input as a module, so on a classic script it can drop top-level
// declarations that are really globals. The oracle compares the globals a run
// leaves behind, which is what rejects those outputs.
const bun: Engine = {
  name: "bun",
  run: async (input) => {
    const path = `/spokeshave-virtual/${input.filename.replace(/[^\w.-]/g, "_")}`;
    const result = await Bun.build({
      entrypoints: [path],
      files: { [path]: input.code },
      minify: true,
      external: ["*"],
      format: "esm",
      target: "browser",
    });
    const [output] = result.outputs;
    if (!result.success || output === undefined)
      throw new Error(`bun: ${result.logs.map(String).join("; ")}`);
    return (await output.text()).trimEnd();
  },
};

const swc: Engine = {
  name: "swc",
  run: async (input) => {
    const result = await swcMinify(input.code, {
      module: input.kind === "module",
      ecma: 2022,
      compress: { passes: 2, ecma: 2022, toplevel: input.toplevel },
      mangle: { toplevel: input.toplevel },
      format: { comments: false },
    });
    return result.code;
  },
};

const terser: Engine = {
  name: "terser",
  run: async (input) => {
    const result = await terserMinify(input.code, {
      module: input.kind === "module",
      ecma: 2020,
      compress: { passes: 2, ecma: 2020, toplevel: input.toplevel },
      mangle: { toplevel: input.toplevel },
      format: { comments: false },
    });
    if (result.code === undefined) throw new Error("terser: no output");
    return result.code;
  },
};

export const ENGINES: Record<EngineName, Engine> = { oxc, bun, swc, terser };

// Which pinned version of each engine is running, for cache keys and reports.
export const engineVersions = async (): Promise<Record<EngineName, string>> => {
  const read = async (pkg: string) =>
    (await import(`${pkg}/package.json`, { with: { type: "json" } })).default
      .version as string;
  return {
    oxc: await read("oxc-minify"),
    bun: Bun.version,
    swc: await read("@swc/wasm"),
    terser: await read("terser"),
  };
};
