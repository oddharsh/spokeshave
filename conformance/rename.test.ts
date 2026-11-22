import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ENGINES } from "../src/engines.ts";
import {
  alphaEquivalent,
  applyRenames,
  renameForBrotli,
} from "../src/rename.ts";

const script = { module: false, toplevel: false };

test("terser's parser and scope files are where the renamer loads them", () => {
  // The renamer reaches past terser's package exports; a terser release that
  // moves these files breaks it here first.
  const pkg = Bun.fileURLToPath(import.meta.resolve("terser"));
  for (const file of ["parse.js", "ast.js", "scope.js"])
    expect(
      readFileSync(pkg.replace(/main\.js$/, `lib/${file}`), "utf8").length,
    ).toBeGreaterThan(1000);
});

test("alphaEquivalent passes a legal rename and fails a capture", () => {
  const source = "function f(a){var b=1;return function(c){return a+b+c}}";
  expect(
    alphaEquivalent(
      source,
      "function f(a){var b=1;return function(d){return a+b+d}}",
      script,
    ),
  ).toBe(true);
  expect(
    alphaEquivalent(
      source,
      "function f(a){var b=1;return function(b){return a+b+b}}",
      script,
    ),
  ).toBe(false);
});

// Pinned from the prototype: terser keeps let/const block scopes on a property,
// and a legality check that missed them gave two bindings in one block the
// same name. renameForBrotli refuses any result alphaEquivalent rejects, so a
// legality bug like that one costs bytes rather than correctness; this pins
// that the program still runs the same.
test("two let bindings in one block never take the same name", () => {
  const source =
    "function f(x){if(x){let a=x+1,b=x+2;return [a,b,a,b,a+b]}return 0}";
  const result = renameForBrotli(source, script);
  expect(alphaEquivalent(source, result.code, script)).toBe(true);
  expect(new Function(`${result.code};return f(3)`)()).toEqual([4, 5, 4, 5, 9]);
});

test("a search's map replays to the same bytes, and a map that doesn't fit throws", async () => {
  const island = readFileSync(
    new URL("./fixtures/island.js", import.meta.url),
    "utf8",
  );
  const source = await ENGINES.oxc.run({
    filename: "island.js",
    code: island,
    kind: "script",
    declared: "script",
    toplevel: false,
  });
  const result = renameForBrotli(source, script);
  expect(result.after).toBeLessThan(result.before);
  expect(result.map.length).toBeGreaterThan(0);
  expect(applyRenames(source, result.map, script)).toBe(result.code);
  expect(() => applyRenames(source, [[100_000, "q"]], script)).toThrow(
    "names binding 100000",
  );
});

test("names that are globals or exports stay put", () => {
  const source = "var keep=1;window.x=function(e){return e+keep}";
  const result = renameForBrotli(source, script);
  expect(result.code).toContain("keep");
  expect(result.code).toContain("window.x");
});

test("pinAfter keeps a binding's name wherever it follows the given string", () => {
  const source = "function f(n,t,e){for(;--n;)t+=e*e*e*e;return t+e+e}";
  const pinned = renameForBrotli(source, { ...script, pinAfter: ["--"] });
  expect(pinned.code).toContain("--n");
  expect(alphaEquivalent(source, pinned.code, script)).toBe(true);
});
