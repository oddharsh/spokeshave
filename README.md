# spokeshave

Minify each JavaScript file with oxc, Bun, SWC and terser (plus two chains of them), and keep the output with the fewest brotli bytes that still does what the source does.

On [aadhar.sh](https://aadhar.sh)'s 27 client scripts it ships 129,364 brotli bytes where oxc alone shipped 131,404: 2,040 B smaller (1.55%). No single engine wins: SWC then oxc took 12 files, oxc then terser 9, SWC 4, Bun 1 and oxc 1.

```ts
import { minify } from "spokeshave";

const { code, pipeline } = await minify(source, {
  filename: "nav.js",
  kind: "script",
});
```

## How it picks up upstream improvements

spokeshave writes no transforms of its own. Each engine is an exact pin, and every build runs all of them on every file. When oxc, Bun, SWC or terser ships a better pass, the next pin bump re-judges every file, and the improvement ships wherever it now wins. A pass spokeshave doesn't own can't go stale inside spokeshave.

The two chains exist because oxc renames tighter than the others: SWC's compressor followed by oxc's mangler beat SWC alone by 274 B on the corpus, and oxc followed by terser beat terser alone by 283 B.

Brotli bytes decide, since that's what a visitor downloads.

## The oracle

A smaller output only counts if it behaves like the source. `spokeshave/oracle` runs the source and each candidate in fresh `node:vm` contexts, with every global the file reads replaced by a recording stub. It fires every callback either run registered, and compares the two effect traces: calls and their arguments, property writes, thrown error classes, and the globals the file leaves behind. Each file runs in 4 worlds that answer guards differently (`if (window.__booted) return` versus `if (!el) return`).

Be clear-eyed about what this catches. On the corpus, it rejects 0 of 27 oxc outputs (no false alarms), but it catches only 36 of 213 seeded bugs planted in oxc's output (17%). Most browser code runs only behind real DOM state, which stubs never produce. [docs/measurements.md](docs/measurements.md) has the breakdown, and what a browser-level check found.

So treat the built-in oracle as a floor, and check a new pick in a real browser before shipping it. aadhar.sh does that with `tools/check-minify-diff.ts`, which walks all 77 of its pages in Chrome for both builds. spokeshave's picks matched oxc on all 77, and the same walk caught 58% of planted bugs.

For the same reason, aadhar.sh doesn't run the portfolio in its deploy build. It commits each file's pick (source hash, engine versions, pipeline) and replays it with `runPipeline`, so CI builds stay fast and every machine produces the same bytes.

## Bun plugin

```ts
import { spokeshave } from "spokeshave/bun";

await Bun.build({
  entrypoints: ["src/app.ts"],
  outdir: "dist",
  minify: false,
  plugins: [spokeshave()],
});
```

Bun's plugin API has no hook that rewrites an output in memory (`onEnd` gets read-only artifacts), so the plugin needs `outdir` and rewrites the files Bun wrote. It refuses `minify: true` and source maps.

## Limits

- Slow. Cold, each file takes 62 to 788 ms; a 95 KB vendored library took 26 s, because its trace hits the effect cap in every world. Cache by input.
- No source maps.
- Bun has no single-file minify API, so the Bun engine goes through the bundler with every import external. On a classic script that can drop top-level declarations that are really globals; the oracle rejects those outputs.
- Measured only on one site's code, on macOS with Bun 1.4.4.

## Layout

| path                   | holds                                                                     |
| ---------------------- | ------------------------------------------------------------------------- |
| `src/engines.ts`       | the four engines behind one signature                                     |
| `src/index.ts`         | the portfolio: run every pipeline, check smallest first, fall back to oxc |
| `src/oracle.ts`        | the effect-trace differential                                             |
| `src/bun-plugin.ts`    | the Bun.build adapter                                                     |
| `conformance/`         | tests, including the pinned cases the corpus turned up                    |
| `docs/measurements.md` | every number in this file, with its date and versions                     |

MIT.
