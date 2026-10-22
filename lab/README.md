# lab/ — off-path work

Real, tested code that the app does not use. It lives outside `mobile/` so it cannot be
imported by a screen and so its dependencies are not autolinked into the APK.

| Path | What it is |
|---|---|
| `src/core/vectors.ts` | int8 vector decoding and cosine scoring |
| `src/core/feed.ts` | candidate generation and MMR diversification |
| `src/core/seeds.ts` | seed selection for a feed |
| `src/core/integrity.ts` | artifact checksum verification |
| `src/platform/bundle.ts` | the static-bundle loader (SQLite + zstd) |
| `tests/` | cross-checks of the above against the Python reference implementation |
| `harness/run.ts`, `run_harness.py` | end-to-end bundle harness |

## Why it is here rather than deleted

It is a complete, verified on-device recommendation pipeline: rank with int8-quantised
embeddings, diversify with MMR, explore. It was switched off deliberately — with 300 papers
from a single day and no usage data, a "recommended" feed would be a guess dressed up as a
feature. It becomes worth turning on once the app knows what people actually read.

## Why it moved out of `mobile/`

`mobile/src` is supposed to contain only shipping code. These modules were unreachable and
never bundled, but `bundle.ts` imports `expo-sqlite`, `expo-file-system`, `fzstd` and
`js-sha256` — and a declared native dependency is compiled into the APK whether or not
anything calls it. `expo-sqlite` alone is 76 MB on disk. Moving the code let the app drop
those dependencies.

`mobile/tests/architecture.test.ts` keeps it that way: it fails if a screen imports from
`src/core` or `src/platform/bundle`, or if any relative import from a screen stops resolving.

## Running it

```bash
cd lab
npm install
npm test
```

`tests/integrity.test.ts` expects the artifacts produced by the bundle builder (`dist/`), so
those tests only fully exercise once a bundle has been built.
