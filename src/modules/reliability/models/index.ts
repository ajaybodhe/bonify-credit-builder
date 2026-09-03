import type { ScoringInput, ScoringResult } from '../scoring.js';
import * as v1 from './v1.js';

/**
 * Every version stays here forever, so `model_version` is a pointer into this
 * table. `frozen` is the release gate: the file is hashed by
 * tests/unit/model-versions.test.ts and any edit fails the build.
 */
export interface ModelVersion {
  readonly version: number;
  readonly frozen: boolean;
  readonly compute: (input: ScoringInput) => ScoringResult;
}

const REGISTRY: Readonly<Record<number, ModelVersion>> = {
  [v1.VERSION]: {
    version: v1.VERSION,
    // Frozen: any change, constant or logic, is v2 registered beside it.
    frozen: true,
    compute: v1.computeReliabilityIndex,
  },
};

export const CURRENT_MODEL_VERSION = v1.VERSION;

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
