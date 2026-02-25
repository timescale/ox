import { describe, expect, test } from 'bun:test';
import {
  buildHermesLabels,
  formatCpuPercent,
  formatMemUsage,
  resolveSandboxImage,
  toVolumeArgs,
} from './docker';

describe('formatCpuPercent', () => {
  test('formats values under 10 with one decimal place', () => {
    expect(formatCpuPercent(0)).toBe('0.0%');
    expect(formatCpuPercent(1.5)).toBe('1.5%');
    expect(formatCpuPercent(9.99)).toBe('10.0%');
    expect(formatCpuPercent(9.94)).toBe('9.9%');
  });

  test('rounds values 10 and above to integers', () => {
    expect(formatCpuPercent(10)).toBe('10%');
    expect(formatCpuPercent(12.3)).toBe('12%');
    expect(formatCpuPercent(99.9)).toBe('100%');
    expect(formatCpuPercent(100)).toBe('100%');
  });
});

describe('formatMemUsage', () => {
  test('shortens GiB to G', () => {
    expect(formatMemUsage('256MiB / 8GiB')).toBe('256M / 8G');
  });

  test('shortens MiB to M', () => {
    expect(formatMemUsage('512MiB / 1024MiB')).toBe('512M / 1024M');
  });

  test('shortens KiB to K', () => {
    expect(formatMemUsage('100KiB / 512MiB')).toBe('100K / 512M');
  });

  test('shortens TiB to T', () => {
    expect(formatMemUsage('1TiB / 2TiB')).toBe('1T / 2T');
  });

  test('returns only usage portion when short=true', () => {
    expect(formatMemUsage('256MiB / 8GiB', true)).toBe('256M');
  });

  test('handles input without slash', () => {
    expect(formatMemUsage('256MiB')).toBe('256M');
  });

  test('handles empty parts gracefully', () => {
    expect(formatMemUsage('/ 8GiB')).toBe(' / 8G');
  });
});

describe('toVolumeArgs', () => {
  test('returns empty array for empty input', () => {
    expect(toVolumeArgs([])).toEqual([]);
  });

  test('flattens single volume to -v flag pair', () => {
    expect(toVolumeArgs(['/host:/container'])).toEqual([
      '-v',
      '/host:/container',
    ]);
  });

  test('flattens multiple volumes to alternating -v and path', () => {
    expect(toVolumeArgs(['/a:/b', '/c:/d'])).toEqual([
      '-v',
      '/a:/b',
      '-v',
      '/c:/d',
    ]);
  });
});

describe('buildHermesLabels', () => {
  test('sets required labels', () => {
    const labels = buildHermesLabels({
      name: 'my-session',
      branch: 'feature-x',
      agent: 'opencode',
    });
    expect(labels['hermes.managed']).toBe('true');
    expect(labels['hermes.name']).toBe('my-session');
    expect(labels['hermes.branch']).toBe('feature-x');
    expect(labels['hermes.agent']).toBe('opencode');
    expect(labels['hermes.exec-type']).toBe('agent');
    expect(labels['hermes.repo']).toBe('local');
    expect(labels['hermes.created']).toBeDefined();
  });

  test('includes optional labels when provided', () => {
    const labels = buildHermesLabels({
      name: 'test',
      branch: 'main',
      agent: 'claude',
      prompt: 'do something',
      interactive: true,
      model: 'sonnet',
      mount: '/tmp/repo',
    });
    expect(labels['hermes.prompt']).toBe('do something');
    expect(labels['hermes.interactive']).toBe('true');
    expect(labels['hermes.model']).toBe('sonnet');
    expect(labels['hermes.mount']).toBe('/tmp/repo');
  });

  test('omits optional labels when not provided', () => {
    const labels = buildHermesLabels({
      name: 'test',
      branch: 'main',
      agent: 'opencode',
    });
    expect(labels['hermes.prompt']).toBeUndefined();
    expect(labels['hermes.interactive']).toBeUndefined();
    expect(labels['hermes.model']).toBeUndefined();
    expect(labels['hermes.mount']).toBeUndefined();
    expect(labels['hermes.resumed-from']).toBeUndefined();
    expect(labels['hermes.resume-image']).toBeUndefined();
  });

  test('sets exec-type to shell when specified', () => {
    const labels = buildHermesLabels({
      name: 'test',
      branch: 'main',
      agent: 'opencode',
      execType: 'shell',
    });
    expect(labels['hermes.exec-type']).toBe('shell');
  });

  test('sets no-git label when noGit is true', () => {
    const labels = buildHermesLabels({
      name: 'test',
      branch: 'main',
      agent: 'opencode',
      noGit: true,
    });
    expect(labels['hermes.no-git']).toBe('true');
  });

  test('includes resume labels when provided', () => {
    const labels = buildHermesLabels({
      name: 'test',
      branch: 'main',
      agent: 'opencode',
      resumedFrom: 'hermes-old-session',
      resumeImage: 'hermes-resume:abc123',
    });
    expect(labels['hermes.resumed-from']).toBe('hermes-old-session');
    expect(labels['hermes.resume-image']).toBe('hermes-resume:abc123');
  });
});

describe('docker service', () => {
  describe('resolveSandboxImage', () => {
    test('returns a valid image config', async () => {
      // Pass empty config to avoid reading from filesystem
      const config = await resolveSandboxImage({});
      expect(config).toBeDefined();
      expect(config.image).toBeDefined();
      expect(typeof config.image).toBe('string');
      expect(typeof config.needsBuild).toBe('boolean');
    });

    test('returns GHCR image by default (no config)', async () => {
      // With no config, should return GHCR sandbox-slim image
      const config = await resolveSandboxImage({});
      expect(config.needsBuild).toBe(false);
      expect(config.image).toMatch(/ghcr\.io\/timescale\/hermes\/sandbox-slim/);
    });

    test('returns consistent values for same config', async () => {
      const config1 = await resolveSandboxImage({});
      const config2 = await resolveSandboxImage({});
      expect(config1.image).toBe(config2.image);
      expect(config1.needsBuild).toBe(config2.needsBuild);
    });

    test('always returns version-tagged image (not :latest)', async () => {
      const config = await resolveSandboxImage({});
      // Should contain a version tag, not :latest
      expect(config.image).not.toContain(':latest');
      expect(config.image).toMatch(/sandbox-slim:\d+\.\d+\.\d+/);
    });
  });
});
