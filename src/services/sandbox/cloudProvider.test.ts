import { describe, expect, test } from 'bun:test';
import {
  buildCloudDockerStartCommand,
  isSandboxTerminatedError,
  resolveCloudLifecycleScripts,
} from './cloudProvider.ts';

describe('isSandboxTerminatedError', () => {
  test('detects SANDBOX_ALREADY_TERMINATED code', () => {
    const err = { code: 'SANDBOX_ALREADY_TERMINATED', message: 'terminated' };
    expect(isSandboxTerminatedError(err)).toBe(true);
  });

  test('detects SANDBOX_NOT_FOUND code', () => {
    const err = { code: 'SANDBOX_NOT_FOUND', message: 'not found' };
    expect(isSandboxTerminatedError(err)).toBe(true);
  });

  test('detects by message fallback', () => {
    const err = new Error('The requested sandbox has already been terminated.');
    expect(isSandboxTerminatedError(err)).toBe(true);
  });

  test('returns false for unrelated errors', () => {
    expect(isSandboxTerminatedError(new Error('network timeout'))).toBe(false);
    expect(isSandboxTerminatedError(null)).toBe(false);
    expect(isSandboxTerminatedError(undefined)).toBe(false);
  });

  test('returns false for numeric code (not string)', () => {
    const err = { code: 404, message: 'not found' };
    expect(isSandboxTerminatedError(err)).toBe(false);
  });
});

describe('buildCloudDockerStartCommand', () => {
  test('returns undefined when dockerInSandbox is disabled', () => {
    expect(buildCloudDockerStartCommand({})).toBeUndefined();
  });

  test('returns guarded start-docker command when dockerInSandbox is enabled', () => {
    const cmd = buildCloudDockerStartCommand({ dockerInSandbox: true });
    expect(cmd).toContain('/usr/local/bin/start-docker.sh');
    // Should guard with command -v so resume works on older snapshots
    expect(cmd).toContain('command -v');
  });
});

describe('resolveCloudLifecycleScripts', () => {
  test('falls back to config initScript and rootInitScript', () => {
    expect(
      resolveCloudLifecycleScripts(
        {},
        {
          dockerInSandbox: true,
          rootInitScript: 'apt-get update',
          initScript: './bun i',
        },
      ),
    ).toEqual({
      cloudDockerStart:
        'command -v /usr/local/bin/start-docker.sh >/dev/null 2>&1 && /usr/local/bin/start-docker.sh',
      rootInitScript: 'apt-get update',
      initScript: './bun i',
    });
  });

  test('prefers explicit option scripts over config values', () => {
    expect(
      resolveCloudLifecycleScripts(
        {
          rootInitScript: 'sudo something',
          initScript: 'npm install',
        },
        {
          dockerInSandbox: false,
          rootInitScript: 'apt-get update',
          initScript: './bun i',
        },
      ),
    ).toEqual({
      cloudDockerStart: undefined,
      rootInitScript: 'sudo something',
      initScript: 'npm install',
    });
  });

  test('returns undefined scripts when neither options nor config set them', () => {
    expect(resolveCloudLifecycleScripts({}, {})).toEqual({
      cloudDockerStart: undefined,
      rootInitScript: undefined,
      initScript: undefined,
    });
  });
});
