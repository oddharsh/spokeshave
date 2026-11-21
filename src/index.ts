// spokeshave: minify one file with every engine (and two chains of them), keep
// the candidate with the fewest brotli bytes that the oracle says behaves like
// the source, and fall back to oxc when nothing else qualifies.
//
// Brotli bytes decide because that is what a visitor downloads; raw size and
// brotli size disagree on about 1 file in 5 in the corpus this was built on.
import { brotliCompressSync, constants as zlib } from "node:zlib";
import { ENGINES } from "./engines.ts";
import type { EngineInput, EngineName, SourceKind } from "./engines.ts";
import { compare, parsesAsScript } from "./oracle.ts";
import type { Verdict } from "./oracle.ts";

export { ENGINES, engineVersions } from "./engines.ts";
export type { EngineName, SourceKind } from "./engines.ts";

// A candidate is a pipeline of engines, run left to right. The chains earn
// their place on measurement: on aadhar.sh's 27 scripts (2026-11-21), oxc then
// terser beat terser alone by 283 brotli bytes, and SWC then oxc beat SWC alone
// by 274, because oxc's mangler packs names tighter than the others.
export type Pipeline = readonly EngineName[];

export const DEFAULT_PIPELINES: readonly Pipeline[] = [
  ["oxc"],
  ["bun"],
  ["swc"],
  ["terser"],
  ["oxc", "terser"],
  ["swc", "oxc"],
];

export type Candidate = {
  pipeline: string;
  code: string | null;
  brotli: number | null;
  verdict:
    | Verdict
    | { kind: "engine-failed"; reason: string }
    | { kind: "not-checked" };
};

export type Result = {
  code: string;
  pipeline: string;
  candidates: Candidate[];
};

export type Options = {
  filename: string;
  // "module" for ES modules, "script" for classic scripts. A file with static
  // import/export is run as a module by the oracle either way.
  kind: SourceKind;
  // Rename top-level bindings. Defaults to true for modules, false for scripts.
  toplevel?: boolean;
  pipelines?: readonly Pipeline[];
  // Every candidate must keep these strings (marker tripwires, say).
  markers?: readonly string[];
};

export const brotliBytes = (code: string): number =>
  brotliCompressSync(Buffer.from(code), {
    params: {
      [zlib.BROTLI_PARAM_QUALITY]: 11,
      [zlib.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(code),
    },
  }).length;

const runPipeline = async (
  pipeline: Pipeline,
  base: EngineInput,
): Promise<string> => {
  let code = base.code;
  for (const name of pipeline)
    code = await ENGINES[name].run({ ...base, code });
  return code;
};

export const minify = async (
  source: string,
  options: Options,
): Promise<Result> => {
  const pipelines = options.pipelines ?? DEFAULT_PIPELINES;
  // An engine has to parse the file the way a browser will, so static
  // import/export makes it a module for parsing even when the caller says
  // script; `toplevel` still follows the caller.
  const kind: SourceKind =
    options.kind === "module" || !parsesAsScript(source) ? "module" : "script";
  const base: EngineInput = {
    filename: options.filename,
    code: source,
    kind,
    declared: options.kind,
    toplevel: options.toplevel ?? options.kind === "module",
  };
  const candidates: Candidate[] = [];
  for (const pipeline of pipelines) {
    const name = pipeline.join(">");
    let code: string;
    try {
      code = await runPipeline(pipeline, base);
    } catch (e) {
      candidates.push({
        pipeline: name,
        code: null,
        brotli: null,
        verdict: { kind: "engine-failed", reason: String(e).slice(0, 300) },
      });
      continue;
    }
    const lost = (options.markers ?? []).find((m) => !code.includes(m));
    if (lost !== undefined) {
      candidates.push({
        pipeline: name,
        code,
        brotli: brotliBytes(code),
        verdict: { kind: "engine-failed", reason: `lost marker ${lost}` },
      });
      continue;
    }
    candidates.push({
      pipeline: name,
      code,
      brotli: brotliBytes(code),
      verdict: { kind: "not-checked" },
    });
  }

  // Check candidates smallest first and stop at the first that passes, since
  // the oracle is the slow part. oxc is always checked, because it is the
  // fallback and a failing oxc means the oracle (or the source) needs a look.
  const order = candidates
    .filter((c) => c.code !== null && c.verdict.kind === "not-checked")
    .sort(
      (a, b) =>
        a.brotli! - b.brotli! ||
        Number(b.pipeline === "oxc") - Number(a.pipeline === "oxc"),
    );
  let chosen: Candidate | undefined;
  for (const candidate of order) {
    if (chosen !== undefined && candidate.pipeline !== "oxc") continue;
    candidate.verdict = await compare(
      { code: source, kind },
      { code: candidate.code!, kind },
    );
    if (chosen === undefined && candidate.verdict.kind === "same")
      chosen = candidate;
  }
  const oxc = candidates.find((c) => c.pipeline === "oxc");
  if (chosen === undefined) {
    if (oxc?.code == null)
      throw new Error(
        `${options.filename}: no candidate passed and oxc failed: ${JSON.stringify(oxc?.verdict)}`,
      );
    chosen = oxc;
  }
  return { code: chosen.code!, pipeline: chosen.pipeline, candidates };
};
