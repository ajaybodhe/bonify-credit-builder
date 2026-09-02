import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ALL_MODEL_VERSIONS,
  CURRENT_MODEL_VERSION,
  modelFor,
} from '../../src/modules/reliability/models/index.js';

/**
 * A model version is immutable once released.
 *
 * `score_snapshots` stores only `model_version` — no constants, no formula — so
 * that number has to be sufficient on its own to say how a past score was
 * produced. That holds only while a released version's file never changes.
 * Editing one silently rewrites the meaning of every score already served under
 * it, and nothing else in the system would notice.
 *
 * So: frozen versions are hashed here. Change the file, fail the build.
 *
 * ## If this test fails
 *
 * You edited a frozen model. Do not update the hash. Add the next version
 * instead — copy the file to `vN+1.ts`, make the change there, register it, and
 * point `CURRENT_MODEL_VERSION` at it. The old file stays forever.
 *
 * A version that is still being written is `frozen: false` and may change
 * freely. Flip it to `frozen: true` the moment it could have served a score.
 */

const MODELS_DIR = new URL('../../src/modules/reliability/models/', import.meta.url);

/**
 * SHA-256 of each frozen version's source, recorded at the moment it froze.
 *
 * Adding a line here is the release gate. Never update an existing one: a
 * changed digest means a released model was edited, which is the failure this
 * file exists to catch.
 */
const FROZEN_DIGESTS: Readonly<Record<number, string>> = {
  1: '62bd5abe66eeb576c85acd83c19c9f851766f8b654536ac53d5ca16fd67c8a28',
};

function digestOf(version: number): string {
  const source = readFileSync(new URL(`v${String(version)}.ts`, MODELS_DIR), 'utf8');
  return createHash('sha256').update(source).digest('hex');
}

describe('model version registry', () => {
  it('registers every version file present on disk', () => {
    const onDisk = readdirSync(MODELS_DIR)
      .filter((f) => /^v\d+\.ts$/.test(f))
      .map((f) => Number(/^v(\d+)\.ts$/.exec(f)?.[1]))
      .sort((a, b) => a - b);
    const registered = ALL_MODEL_VERSIONS.map((m) => m.version).sort((a, b) => a - b);
    // A file nobody registered is a version that cannot be looked up, so a
    // snapshot referencing it would be unexplainable.
    expect(registered).toEqual(onDisk);
  });

  it('can look up every registered version', () => {
    for (const m of ALL_MODEL_VERSIONS) {
      expect(modelFor(m.version).version).toBe(m.version);
    }
  });

  it('refuses to look up a version that does not exist', () => {
    expect(() => modelFor(9999)).toThrow(/must remain in/);
  });

  it('computes new scores with the highest version', () => {
    const highest = Math.max(...ALL_MODEL_VERSIONS.map((m) => m.version));
    expect(CURRENT_MODEL_VERSION).toBe(highest);
  });

  it('versions are numbered from 1 with no gaps', () => {
    const versions = ALL_MODEL_VERSIONS.map((m) => m.version).sort((a, b) => a - b);
    expect(versions).toEqual(versions.map((_, i) => i + 1));
  });
});

describe('frozen models are immutable', () => {
  /**
   * The guard itself. If you are reading this because it failed: add the next
   * version, do not update the digest.
   */
  it.each(ALL_MODEL_VERSIONS.filter((m) => m.frozen).map((m) => m.version))(
    'v%i is byte-identical to when it was frozen',
    (version) => {
      const expected = FROZEN_DIGESTS[version];
      expect(
        expected,
        `v${String(version)} is marked frozen but has no digest recorded. Add its ` +
          'SHA-256 to FROZEN_DIGESTS in the same commit that freezes it.',
      ).toBeDefined();
      expect(
        digestOf(version),
        `Model v${String(version)} has been modified. A released model may never change — ` +
          'every score already served under it would silently mean something else. ' +
          `Copy it to v${String(version + 1)}.ts, change that, register it, and point ` +
          'CURRENT_MODEL_VERSION at it.',
      ).toBe(expected);
    },
  );

  it('every frozen version has a recorded digest', () => {
    for (const m of ALL_MODEL_VERSIONS.filter((x) => x.frozen)) {
      expect(FROZEN_DIGESTS[m.version]).toBeDefined();
    }
  });

  /**
   * Records what freezing v1 will require, and fails the moment someone freezes
   * a version without recording its digest.
   */
  it('v1 is frozen and has a recorded digest', () => {
    // The guard the README, CLAUDE.md and the design doc all cite is only real
    // while this holds.
    expect(modelFor(1).frozen).toBe(true);
    expect(FROZEN_DIGESTS[1]).toMatch(/^[0-9a-f]{64}$/);
  });
});
