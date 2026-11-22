# Research: what to build into one minifier

The goal is one minimal-dependency minifier, a fork of oxc's (`oxc-spokeshave`, branch `spokeshave/core`), that matches or beats the portfolio spokeshave runs today. Every other minifier is research material, not a runtime dependency. This file records what each one taught, measured on aadhar.sh's 27 client scripts (brotli q11, 2026-11-22).

## How a rule earns its place

1. **Ablation.** Turn one rule off in an engine, see how much the best-of total grows. That ranks rules from scratch.
2. **Residual.** Run each engine's syntax rules over the fork's output, re-minify with the fork, keep a file only if it shrinks. That shows what is still left.
3. **Shape.** Pretty-print both and diff by lines. Name the transform, then find why the fork refuses it. Twice the reason was a gap in the fork's walker, not a missing transform.
4. **Port.** One rule per step, gated by spokeshave's vm oracle on all outputs, two identical runs, and a new oxc test that fails with the rule switched off.

Two controls caught wrong attributions. With every listed rule off, SWC still compresses (its ungated passes did the work, not `reduce_vars`). Running the fork twice gives identical output, so a second pass is not the source either.

## What each source taught

| Source                      | Residual on the fork, own files | What it pointed at                                                    |
| --------------------------- | ------------------------------: | --------------------------------------------------------------------- |
| SWC                         |               -296 B (was -373) | ungated passes; lazy init `a\|\|(a=b,a)`; moving helpers into callers |
| terser                      |                -58 B (was -104) | `reduce_vars`/`evaluate` cluster; most of it now ported               |
| esbuild                     |                 -12 B (was -53) | little left                                                           |
| Bun                         |                 -51 B (was -98) | helpers moved into exported functions (rule 8)                        |
| all of them, pretext.lib.js |                          -695 B | vendored, already minified code; not yet diffed                       |

## Rules ported so far

| Rule  | Change                                                                                                         |    Bytes |
| ----- | -------------------------------------------------------------------------------------------------------------- | -------: |
| 1     | single-use function declarations move into their reference                                                     |     -468 |
| 3     | single-use `let`/`const` closures move too; arrows that read `this`, `arguments`, `super` or `new.target` stay |      -13 |
| 4     | `a\|\|(a=b,a)` becomes `a\|\|=b` for a local `a`                                                               |      -26 |
| 7     | a closure moves into a later declarator of its own statement                                                   |      -69 |
| 8     | references inside `export function` and `export default` are found                                             |      -91 |
| tried | for-initializer moves (+10), literal-first `2*x` (+83), single-use primitives (0)                              | reverted |

The fork stands at 130,870 B against npm oxc's 131,537 (-667) and the portfolio's 128,862.

## Beyond syntax: what types and the whole program add

Ranked by how much they could matter here:

1. **Type-checked property renaming.** Rename properties the type checker proves are internal; leave anything from `lib.dom`, a `.d.ts`, or a JSON boundary alone. tsrs, oxc's Rust port of TypeScript 7, exposes `getTypeAtLocation` and `getSymbolAtLocation` through a Node API modeled on TS 7.1 (https://raw.githubusercontent.com/oxc-project/tsrs/main/docs/NODE_API.md). Published wins shrink a lot after compression: TS-Minify reports 20% raw but 6-8% gzip (https://github.com/angular/ts-minify). Our own text-level estimate in October, with a crude reserved list, was -0.87% and unsafe; the typed version is the safe form of that number. Risk: `as unknown as T` casts lose the trace.
2. **Ambiguation for brotli.** Closure's AmbiguateProperties gives unrelated properties the same short names because disambiguation "makes the gzipped code bigger" (https://github.com/google/closure-compiler/wiki/Type-Based-Property-Renaming). For brotli, the naming policy matters as much as the renaming. It pairs with spokeshave's compression-aware renamer.
3. **Opt-in property mangling.** esbuild and Bun's `--mangle-props` with a reserved list and a committed mangle cache: no types, a naming convention instead (https://github.com/oven-sh/bun/commit/dd327b0148fa967aa1a601232ea305b0df9f80a0). The cheap first version of idea 1.
4. **Cross-module constant inlining, then fold again,** as esbuild does for enums (https://github.com/evanw/esbuild/blob/main/CHANGELOG-2024.md). Needs every module at once; the islands share few constants, so measure before building.
5. **Closure ADVANCED as a ceiling,** run once through tsickle or tscc (https://github.com/theseanl/tscc), to see what a whole-program, type-driven compiler gets on these files.

Not worth pursuing: Bun's AOT emits machine code and never prints JS back (https://bun.com/docs/compiler/internals), though its Link step's fixpoint over function summaries (https://bun.com/bun-aot-how) is the right algorithm for dead-method removal. stc is abandoned (https://stc.dudy.dev). Ezno "does not currently support enough features to check existing projects" (https://github.com/kaleidawave/ezno). TypeScript 7.0 shipped without an API; 7.1 restored one.

## Next, in order

1. Diff pretext.lib.js against SWC: the largest single residual (695 B).
2. Keep porting SWC's ungated passes on own files (296 B left), one shape at a time.
3. Prototype typed property renaming on the islands with tsrs, oracle-checked in Chrome, since it is the only lever measured above 1%.
