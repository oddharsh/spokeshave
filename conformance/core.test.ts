import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spokeshave } from "../src/bun-plugin.ts";
import { ENGINES, minify, runPipeline } from "../src/index.ts";
import type { Pipeline } from "../src/index.ts";
import { compare } from "../src/oracle.ts";

// A guard-then-wire island, the shape aadhar.sh's nav.js has.
const island = `(() => {
  if (window.__booted) return;
  window.__booted = true;
  document.addEventListener("click", (e) => {
    if (e.target.closest(".start")) document.body.classList.toggle("open");
  });
  window.Island = { version: 3, open: () => document.body.classList.add("open") };
})();`;

test("the oracle passes a file against itself", async () => {
  expect(
    await compare(
      { code: island, kind: "script" },
      { code: island, kind: "script" },
    ),
  ).toMatchObject({ kind: "same" });
});

test("the oracle catches a flipped flag", async () => {
  const flipped = island.replace(
    "window.__booted = true",
    "window.__booted = false",
  );
  expect(
    await compare(
      { code: island, kind: "script" },
      { code: flipped, kind: "script" },
    ),
  ).toMatchObject({
    kind: "different",
    world: "fresh-window",
    source: "set window.__booted=true",
  });
});

test("the oracle catches a bug inside a callback it has to fire", async () => {
  const wrong = island.replace(`toggle("open")`, `toggle("shut")`);
  expect(
    await compare(
      { code: island, kind: "script" },
      { code: wrong, kind: "script" },
    ),
  ).toMatchObject({ kind: "different" });
});

// Pinned from the first corpus run: Bun's bundler treats a classic script as a
// module and drops a top-level var that is really a global.
test("the oracle rejects a dropped global, and minify falls back from it", async () => {
  const source = "var SITE_VERSION = 7; window.ready = SITE_VERSION + 1;";
  const bun = await ENGINES.bun.run({
    filename: "a.js",
    code: source,
    kind: "script",
    declared: "script",
    toplevel: false,
  });
  expect(bun).not.toContain("SITE_VERSION");
  expect(
    await compare(
      { code: source, kind: "script" },
      { code: bun, kind: "script" },
    ),
  ).toMatchObject({ kind: "different" });
  const result = await minify(source, {
    filename: "a.js",
    kind: "script",
    pipelines: [["bun"], ["oxc"]],
  });
  expect(result.pipeline).toBe("oxc");
  expect(result.code).toContain("SITE_VERSION");
});

test("minify keeps the smallest passing candidate", async () => {
  const result = await minify(island, {
    filename: "island.js",
    kind: "script",
  });
  const passing = result.candidates.filter((c) => c.verdict.kind === "same");
  expect(passing.map((c) => c.pipeline)).toContain(result.pipeline);
  const chosen = result.candidates.find((c) => c.pipeline === result.pipeline)!;
  for (const c of result.candidates)
    if (c.brotli !== null && c.verdict.kind === "same")
      expect(chosen.brotli!).toBeLessThanOrEqual(c.brotli);
});

test("the Bun plugin minifies what Bun wrote, and it still runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spokeshave-"));
  writeFileSync(
    join(dir, "entry.ts"),
    "export function area(width: number, height: number) { const product = width * height; return product; }\nexport const label = (n: number) => `area ${area(n, n)}`;\n",
  );
  const result = await Bun.build({
    entrypoints: [join(dir, "entry.ts")],
    outdir: join(dir, "dist"),
    minify: false,
    format: "esm",
    plugins: [spokeshave()],
  });
  expect(result.success).toBe(true);
  const out = readFileSync(join(dir, "dist", "entry.js"), "utf8");
  expect(out).not.toContain("product");
  const mod = await import(join(dir, "dist", "entry.js"));
  expect(mod.label(3)).toBe("area 9");
});

test("the Bun plugin refuses minify: true", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spokeshave-"));
  writeFileSync(join(dir, "entry.ts"), "export const x = 1;\n");
  let message = "";
  try {
    await Bun.build({
      entrypoints: [join(dir, "entry.ts")],
      outdir: join(dir, "dist"),
      minify: true,
      plugins: [spokeshave()],
    });
  } catch (e) {
    message = String(e);
  }
  expect(message).toContain("set minify: false");
});

test("runPipeline replays a pick byte for byte", async () => {
  const options = { filename: "island.js", kind: "script" as const };
  const result = await minify(island, options);
  expect(
    await runPipeline(result.pipeline.split(">") as Pipeline, island, options),
  ).toBe(result.code);
});
