---
name: scoring-model
description: Change, extend, or debug the Reliability Index scoring model. Use when touching src/modules/reliability/scoring.ts, adjusting point mappings or MODEL constants, adding a scoring signal, explaining why a score came out a certain way, or writing drivers. Covers the A/B/C/D component breakdown, versioning, and reproducibility rules.
---

# Working on the scoring model

## The model in one place

Final score = `clamp(A + B + C + D, 0, 100)`.

|     | Component                      | Range   | Where                                                      |
| --- | ------------------------------ | ------- | ---------------------------------------------------------- |
| A   | Income regularity              | 0…25    | `months_with_income / 6 × 25`                              |
| B   | Income coverage ratio          | 0…25    | piecewise-linear curve, `MODEL.incomeCoverage.breakpoints` |
| C   | Essential payments consistency | 0…25    | `category-months present / (6 × essential categories)`     |
| D   | Resilience adjustments         | −20…+25 | savings, negative-balance days, late fees, high-risk share |

Bands: `LOW 0–49`, `MEDIUM 50–74`, `HIGH 75–100`.

Full rationale for every constant: `docs/scoring-model.md`.

## Non-negotiables

1. **`scoring.ts` is pure.** Transactions in, score out. No database handle, no
   `Date.now()`, no network call. Everything the model needs arrives in
   `ScoringInput`. This is what makes a score reproducible from a stored
   snapshot months later.
2. **Every tunable lives in `MODEL`.** No magic numbers inside a formula. A
   model change should read as a diff of named constants.
3. **The whole category dictionary is passed in** via `ScoringInput`, resolved
   dynamically from the Banking API — not two hand-picked lists. Component A
   needs `income` codes and D's late-fee term needs `fees` codes, so anything
   less leaves category questions unanswerable from the input alone.
   Hardcoding membership silently breaks C's denominator when upstream adds a
   category.
4. **Bump `MODEL_VERSION` on any behavioural change**, and say what changed in
   `docs/scoring-model.md`. Every `score_snapshots` row stores the version, so
   a past decision stays explainable after the model moves on.
5. **The score must be deterministic and clamped.** Same input, same integer,
   always in 0…100. Both are asserted in `tests/unit/scoring.test.ts`.
6. **The model version comes from the code, never the environment**, and every
   version ever released stays in `models/` forever. A snapshot stores only the
   version number, so deleting a file makes its scores unexplainable.
7. **Scoring only ever sees a fully covered window.** The coverage gate refuses
   earlier, so the model never has to reason about partial data.
8. **Own-account transfers are classified before scoring** and passed in: a
   credit into savings is saving, never income. Without it, component A reads a
   monthly transfer as a second income.

## Adding a new signal

1. Add its constants to `MODEL` under the component it belongs to.
2. Add the raw measurement to `ScoreComponents` so it lands in the persisted
   breakdown, not just the final number.
3. Emit a driver string for it when it moves the score.
4. Copy `models/vN.ts` to `vN+1.ts`, make the change there, register it in
   `models/index.ts`, and point `CURRENT_MODEL_VERSION` at it. Never edit a
   frozen version — `tests/unit/model-versions.test.ts` hashes them and fails
   the build.
5. Document the intent, the mapping, and the **bias risk** in
   `docs/scoring-model.md` — for a credit-adjacent score that section is part
   of the deliverable, not an afterthought.
6. Add a table-driven case to `tests/unit/scoring.test.ts`.

## Writing drivers

`drivers` is what an analyst reads instead of the code. Rules:

- One driver per component that materially moved the score, ordered by impact.
- State the evidence, not the arithmetic: `"Income present in 5/6 months"`,
  not `"A = 20.83"`.
- Include penalties too. A score is not explained if only the good news is
  listed.
- Never phrase a driver as a judgement about the person. `"54 days with a
negative running balance"` — not `"poor money management"`.

## Debugging "why did this score change?"

The audit trail is `score_snapshots`. Each row carries the window, the model
version, the metrics, the per-component breakdown, and `input_hash` — a
fingerprint of the transaction set.

- Same `input_hash`, same version, different score → a bug. The model is not
  deterministic.
- Same `input_hash`, different version → an intended model change; the diff is
  in `docs/scoring-model.md`.
- Different `input_hash` → the underlying data moved. Check `sync_runs` for a
  `partial` or `failed` run, and for late-arriving backdated transactions.
