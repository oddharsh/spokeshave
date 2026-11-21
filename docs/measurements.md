# Measurements

All on aadhar.sh's 27 client scripts at site commit 96a4a119 (2026-11-21), inputs = the build's
`.src.js` twins, brotli q11, Bun 1.4.4, oxc-minify 0.159.0, @swc/wasm 1.16.22 (byte-identical to @swc/core 1.16.22 on this corpus), terser 5.51.2.

## Bytes

|                                                       |                   brotli |
| ----------------------------------------------------- | -----------------------: |
| oxc alone (what the site shipped)                     |                  131,404 |
| spokeshave, smallest candidate that passes the oracle | 129,364 (-2,040, -1.55%) |

Winning pipeline by file: swc>oxc 12, oxc>terser 9, swc 4, bun 1, oxc 1.
Bun's output lost the marker on tooltip.js; Bun won only lens-markdown.js (5 B).

## Oracle

- False positives: 0 of 27 oxc outputs disagree with their source.
- Sensitivity: 36 of 213 seeded mutants of oxc output caught (17%): `===` to `!==` 12/72,
  `&&` to `||` 17/78, a string literal's first letter 7/63. Most island code sits behind DOM
  state the stubs never produce, so most mutants land in code that never runs.
  Steps: 13% (3 worlds) -> 13% (callback cap 400 -> 4,000) -> 17% (one-item lists).

## Time

Cold, per file, every candidate plus the oracle: 62 ms (dotfiles.js) to 788 ms (lens.js);
pretext.lib.js 25.9 s, because its trace hits the effect cap in every world.

## Browser-level check (aadhar.sh, 2026-11-21)

aadhar.sh's `tools/check-minify-diff.ts` loads all 77 manifest pages in headless Chrome, with the
clock, the page's Math.random and the Worker's Math.random fixed. It walks each page through load,
Ctrl-K, typing, Escape and clicks on up to 15 visible controls, and saves the DOM after every
step plus the console, uncaught errors and requests. Two more records of the oxc build are the
noise control: a reading on which the oxc records disagree (a measured timing, a server timestamp,
fresh crypto keys, an animation frame) is left out.

| comparison                           | pages that differ | readings compared | left out as noise |
| ------------------------------------ | ----------------: | ----------------: | ----------------: |
| oxc vs oxc, 1 control (false alarms) |           2 of 77 |               938 |                31 |
| spokeshave vs oxc, 2 controls        |           0 of 77 |               936 |                43 |

Both false alarms are timing: a requestAnimationFrame dot at 160px vs 148px, and a "rested 1 ms"
vs "0 ms" readout. One control is not enough, so the site runs two.

Sensitivity: 32 of 55 seeded mutants of the oxc build's assets caught (58%), against 17% for the
vm oracle. `===` to `!==` 16/28, `&&` to `||` 9/15, a string literal 7/12. Every mutant of lens,
photos-view, md-to-html and serendipity was missed: their pages render from data the local
harness doesn't have (empty KV, R2 and D1), or need input the walk doesn't type.
