// ============================================================================
// Cloud Base Snapshot Build Steps
// ============================================================================
//
// This module loads the cloud base snapshot build steps from a YAML file and
// provides a content hash for determining snapshot slugs.  The hash changes
// only when the actual setup commands change, not on every ox release.
//
// See ensureCloudSnapshot() in cloudSnapshot.ts for execution logic.
// ============================================================================

import { YAML } from 'bun';
// Import YAML as text — Bun's bundler embeds this in the binary
import CLOUD_BASE_STEPS_YAML from '../../../sandbox/cloud-base-steps.yaml' with {
  type: 'text',
};

/**
 * A single step in the cloud base snapshot build process.
 *
 * @property label  - Short identifier used in logs and exec wrappers.
 * @property message - Human-readable progress message shown in the UI.
 * @property detail  - Optional secondary detail shown in the UI.
 * @property command - The shell command string to execute.
 * @property sudo    - If true, the command is executed as root via sudo.
 */
export interface CloudBuildStep {
  label: string;
  message: string;
  detail?: string;
  command: string;
  sudo?: boolean;
  group?: 'docker';
}

export interface CloudBaseStepOptions {
  dockerInSandbox?: boolean;
}

/**
 * All base cloud snapshot build steps, in execution order.
 *
 * Loaded from `sandbox/cloud-base-steps.yaml` so that the build steps are
 * declarative and easy to review in a single file.  The content hash of the
 * commands determines the snapshot slug, avoiding unnecessary rebuilds.
 *
 */
export const CLOUD_BASE_STEPS: readonly CloudBuildStep[] = YAML.parse(
  CLOUD_BASE_STEPS_YAML,
) as CloudBuildStep[];

export function getCloudBaseSteps(
  options: CloudBaseStepOptions = {},
): readonly CloudBuildStep[] {
  return CLOUD_BASE_STEPS.filter(
    (step) => step.group !== 'docker' || options.dockerInSandbox,
  );
}

/**
 * Compute a content hash of the base cloud snapshot build steps.
 *
 * The hash is derived from:
 * - **command**: The shell command string for each step.
 * - **sudo flag**: Whether the step runs as root (true vs false/undefined).
 *
 * The hash deliberately does NOT include:
 * - **label**: UI-only identifier for logging; changing it shouldn't trigger a rebuild.
 * - **message**: UI-only progress text; purely cosmetic.
 * - **detail**: UI-only secondary description; purely cosmetic.
 *
 * Note: `sudo: undefined` and `sudo: false` are treated identically — neither
 * appends the "sudo" marker to the hash.  This means adding an explicit
 * `sudo: false` to a step that previously omitted the field will NOT change
 * the hash.
 *
 * @returns A 12-character hex string (MD5 prefix).
 */
export function computeCloudBaseHash(
  options: CloudBaseStepOptions = {},
): string {
  const hasher = new Bun.CryptoHasher('md5');
  for (const step of getCloudBaseSteps(options)) {
    hasher.update(step.command);
    if (step.sudo) hasher.update('sudo');
  }
  return hasher.digest('hex').slice(0, 12);
}
