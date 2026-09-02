import type { ScoringInput, ScoringResult } from '../scoring.js';
import * as v1 from './v1.js';

/**
 * Registry of model versions.
 *
 * Every version ever used to serve a score stays here forever. Scoring runs
 * `CURRENT`; recomputing a past score looks up the version recorded on its
 * snapshot and runs that. Nothing about the model is stored in the database —
 * `model_version` is a pointer into this table.
 *
 * `frozen` records whether a version has been released. A frozen version's file
 * is hashed by `tests/unit/model-versions.test.ts` and any edit fails the
 * build; an unfrozen one is still being written and may change freely. Freezing
 * is the release gate: flip it the moment a version can have served a score.
 */
export interface ModelVersion {
  readonly version: number;
  readonly frozen: boolean;
  readonly compute: (input: ScoringInput) => ScoringResult;
}

const REGISTRY: Readonly<Record<number, ModelVersion>> = {
  [v1.VERSION]: {
    version: v1.VERSION,
    // Frozen: this file may never be edited again. Any change — a constant or
    // a line of logic — is v2, registered beside it.
    frozen: true,
    compute: v1.computeReliabilityIndex,
  },
};

/** The version new scores are computed with. */
export const CURRENT_MODEL_VERSION = v1.VERSION;

/** Looks up a version, for recomputing a score from its snapshot. */
export function modelFor(version: number): ModelVersion {
  const model = REGISTRY[version];
  if (!model) {
    throw new Error(
      `No implementation for model version ${String(version)}. A version that ever ` +
        'served a score must remain in src/modules/reliability/models/ forever, or ' +
        'its snapshots become unexplainable.',
    );
  }
  return model;
}

export const ALL_MODEL_VERSIONS: readonly ModelVersion[] = Object.values(REGISTRY);
