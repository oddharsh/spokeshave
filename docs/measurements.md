# Measurements

All on aadhar.sh's 27 client scripts at site commit 96a4a119 (2026-11-21), inputs = the build's
`.src.js` twins, brotli q11, Bun 1.4.4, oxc-minify 0.159.0, @swc/core 1.16.22, terser 5.51.2.

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
