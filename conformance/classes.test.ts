import { expect, test } from "bun:test";
import {
  applyClassNames,
  assertClassIntegrity,
  censusClasses,
  nameIsFree,
} from "../src/classes.ts";

const census = (files: Record<string, string>) =>
  censusClasses(new Map(Object.entries(files)), { publicDir: "public" });
const renameable = (files: Record<string, string>) =>
  [...census(files).renameable].sort();

test("a class used only in markup, a stylesheet and classList is renameable", () => {
  const files = {
    "public/a.html": '<div class="card wide"><p class=note>x</p></div>',
    "public/a.css": ".card{color:red}.card.wide>.note{margin:0}",
    "public/a.js": 'document.body.classList.add("wide");',
  };
  expect(renameable(files)).toEqual(["card", "note", "wide"]);
  const c = census(files);
  expect(c.counts.get("card")).toBe(3);
  expect(c.counts.get("wide")).toBe(3);
});

test("the rename rewrites every position and the census of the result agrees", () => {
  const files = new Map(
    Object.entries({
      "public/a.html": '<div class="card wide"><p class=note>x</p></div>',
      "public/a.css": ".card{color:red}.card.wide>.note{margin:0}",
      "public/a.js": 'document.body.classList.add("wide");',
    }),
  );
  const before = censusClasses(files, { publicDir: "public" });
  const map = new Map([
    ["card", "a"],
    ["wide", "b"],
    ["note", "c"],
  ]);
  const out = applyClassNames(files, before, map);
  expect(out.get("public/a.html")).toBe(
    '<div class="a b"><p class=c>x</p></div>',
  );
  expect(out.get("public/a.css")).toBe(".a{color:red}.a.b>.c{margin:0}");
  expect(out.get("public/a.js")).toBe('document.body.classList.add("b");');
  assertClassIntegrity(
    before,
    censusClasses(out, { publicDir: "public" }),
    map,
    3,
  );
});

test("a ternary of literals into className is traced; a parameter from nowhere taints", () => {
  const traced = renameable({
    "public/a.css": ".on{}.off{}",
    "public/a.js":
      'const el = document.body; el.className = Math.random() > 0.5 ? "on" : "off";',
  });
  expect(traced).toEqual(["off", "on"]);
  // An untraced value taints the file, and its prose reserves "on".
  const c = census({
    "public/a.css": ".on{}.off{}",
    "public/a.js":
      'export function set(el, v) { el.className = v; } const label = "on";',
  });
  expect(c.tainted.has("public/a.js")).toBe(true);
  expect(c.reserved.get("on")).toBe("client string");
  expect(c.renameable.has("off")).toBe(true);
});

test("an interpolation inside class= reserves the prefix it extends", () => {
  const c = census({
    "public/a.css": ".tab-a{}.tab-b{}.other{}",
    "src/w.ts":
      'export const tab = (k: "a" | "b") => `<i class="tab-${k} other">`;',
  });
  expect(c.prefixes.has("tab-")).toBe(true);
  expect([...c.renameable].sort()).toEqual(["other"]);
});

test("TypeScript positions are the source's own offsets", () => {
  const files = new Map(
    Object.entries({
      "public/a.css": ".hero{}",
      "src/w.ts":
        'type T = { x: number };\nexport const page = (t: T): string => `<h1 class="hero">${t.x}</h1>`;',
    }),
  );
  const before = censusClasses(files, { publicDir: "public" });
  const out = applyClassNames(files, before, new Map([["hero", "h"]]));
  expect(out.get("src/w.ts")).toBe(
    'type T = { x: number };\nexport const page = (t: T): string => `<h1 class="h">${t.x}</h1>`;',
  );
});

test("a literal stored in a binding read outside the sink is dual-use", () => {
  const c = census({
    "public/a.css": ".busy{}",
    "public/a.js":
      'const s = "busy"; document.body.className = s; console.log(s === "busy");',
  });
  expect(c.reserved.get("busy")).toBe("dual-use");
  const free = census({
    "public/a.css": ".busy{}",
    "public/a.js": 'const s = "busy"; document.body.className = s;',
  });
  expect(free.renameable.has("busy")).toBe(true);
});

test("JSON reserves its words only when a tainted script reads it", () => {
  const files = {
    "public/a.css": ".panel{}",
    "public/a.html": '<div class="panel"></div>',
    "public/data.json": '{"kind":"panel"}',
  };
  // Nothing reads data.json: its words are reserved, since a reader can't be ruled out.
  expect(census(files).reserved.get("panel")).toBe("json (no reader)");
  // An untainted reader: the JSON can't reach a class through it.
  expect(
    census({
      ...files,
      "public/r.js":
        'fetch("/data.json").then((r) => r.json()).then((d) => console.log(d.kind));',
    }).renameable.has("panel"),
  ).toBe(true);
  // A tainted reader keeps them reserved.
  const tainted = census({
    ...files,
    "public/r.js":
      'fetch("/data.json").then((r) => r.json()).then((d) => { document.body.className = d.kind; });',
  });
  expect(tainted.reserved.get("panel")).toBe("json (tainted reader)");
});

test("selector interpolations inside [attr=...] or after # name no class", () => {
  const c = census({
    "public/a.css": ".dev{}",
    "public/a.js":
      'const id = location.hash; document.querySelector(`.dev[data-id="${id}"]`); document.querySelector(`#${id}`);',
  });
  expect(c.tainted.size).toBe(0);
  expect(c.renameable.has("dev")).toBe(true);
});

test("a CSS-shaped string in an untainted file reserves its classes", () => {
  const c = census({
    "public/a.css": ".x{}",
    "public/a.html": '<i class="x"></i>',
    "src/w.ts":
      'export const css = ".x{color:red}"; export const sheet = (s: string) => s;',
  });
  expect(c.reserved.get("x")).toBe("worker string (css-shaped)");
});

test("nameIsFree refuses taken names and fragment rules", () => {
  const c = census({
    "public/a.css": ".tab-a{}.q{}",
    "src/w.ts": 'export const tab = (k: string) => `<i class="tab-${k}">`;',
  });
  expect(nameIsFree(c, "q")).toBe(false);
  expect(nameIsFree(c, "tab-z")).toBe(false);
  expect(nameIsFree(c, "z")).toBe(true);
});

test("the integrity check fails a rename that misses a position", () => {
  const files = new Map(
    Object.entries({
      "public/a.html": '<div class="card"></div>',
      "public/a.css": ".card{}",
    }),
  );
  const before = censusClasses(files, { publicDir: "public" });
  const map = new Map([["card", "a"]]);
  const out = applyClassNames(files, before, map);
  out.set("public/a.css", ".card{}"); // the stylesheet's rename is lost
  expect(() =>
    assertClassIntegrity(
      before,
      censusClasses(out, { publicDir: "public" }),
      map,
      1,
    ),
  ).toThrow("the rename changed more than names");
});

test("a tagged template's class attributes are class positions", () => {
  // aadhar.sh's Worker builds markup with html`...`; until 2026-11-22 the walk
  // skipped tagged templates, so `axp-histnav` there kept its authored name
  // while the client looked for the short one and drew a second copy.
  const files = new Map(
    Object.entries({
      "public/a.css": ".histnav{}",
      "src/w.ts":
        'const html = (s: TemplateStringsArray) => s.join("");\nexport const NAV = html`<span class="histnav"></span>`;',
    }),
  );
  const before = censusClasses(files, { publicDir: "public" });
  expect(before.counts.get("histnav")).toBe(2);
  const out = applyClassNames(files, before, new Map([["histnav", "h"]]));
  expect(out.get("src/w.ts")).toBe(
    'const html = (s: TemplateStringsArray) => s.join("");\nexport const NAV = html`<span class="h"></span>`;',
  );
});
