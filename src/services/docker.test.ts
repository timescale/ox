import { describe, expect, test } from 'bun:test';
import BASE_DOCKERFILE from '../../sandbox/base.Dockerfile' with {
  type: 'text',
};
import {
  buildDockerSandboxRootInitScript,
  buildOxLabels,
  computeAgentOverlayHash,
  computeDockerfileHash,
  computeProjectSetupHash,
  extractTagHash,
  formatCpuPercent,
  formatMemUsage,
  getAgentOverlayTag,
  getDockerSandboxSetupTag,
  getProjectSetupTag,
  resolveDockerSandboxPrivilege,
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

describe('buildOxLabels', () => {
  test('sets required labels', () => {
    const labels = buildOxLabels({
      name: 'my-session',
      branch: 'feature-x',
      agent: 'opencode',
    });
    expect(labels['ox.managed']).toBe('true');
    expect(labels['ox.name']).toBe('my-session');
    expect(labels['ox.branch']).toBe('feature-x');
    expect(labels['ox.agent']).toBe('opencode');
    expect(labels['ox.exec-type']).toBe('agent');
    expect(labels['ox.repo']).toBe('local');
    expect(labels['ox.created']).toBeDefined();
  });

  test('includes optional labels when provided', () => {
    const labels = buildOxLabels({
      name: 'test',
      branch: 'main',
      agent: 'claude',
      prompt: 'do something',
      interactive: true,
      model: 'sonnet',
      mount: '/tmp/repo',
    });
    expect(labels['ox.prompt']).toBe('do something');
    expect(labels['ox.interactive']).toBe('true');
    expect(labels['ox.model']).toBe('sonnet');
    expect(labels['ox.mount']).toBe('/tmp/repo');
  });

  test('omits optional labels when not provided', () => {
    const labels = buildOxLabels({
      name: 'test',
      branch: 'main',
      agent: 'opencode',
    });
    expect(labels['ox.prompt']).toBeUndefined();
    expect(labels['ox.interactive']).toBeUndefined();
    expect(labels['ox.model']).toBeUndefined();
    expect(labels['ox.mount']).toBeUndefined();
    expect(labels['ox.resumed-from']).toBeUndefined();
    expect(labels['ox.resume-image']).toBeUndefined();
  });

  test('sets exec-type to shell when specified', () => {
    const labels = buildOxLabels({
      name: 'test',
      branch: 'main',
      agent: 'opencode',
      execType: 'shell',
    });
    expect(labels['ox.exec-type']).toBe('shell');
  });

  test('sets no-git label when noGit is true', () => {
    const labels = buildOxLabels({
      name: 'test',
      branch: 'main',
      agent: 'opencode',
      noGit: true,
    });
    expect(labels['ox.no-git']).toBe('true');
  });

  test('includes resume labels when provided', () => {
    const labels = buildOxLabels({
      name: 'test',
      branch: 'main',
      agent: 'opencode',
      resumedFrom: 'ox-old-session',
      resumeImage: 'ox-resume:abc123',
    });
    expect(labels['ox.resumed-from']).toBe('ox-old-session');
    expect(labels['ox.resume-image']).toBe('ox-resume:abc123');
  });
});

describe('extractTagHash', () => {
  test('extracts hash from md5- prefix', () => {
    expect(extractTagHash('ox-sandbox:md5-abc123def456')).toBe('abc123def456');
  });

  test('extracts hash from GHCR image', () => {
    expect(extractTagHash('ghcr.io/timescale/ox/sandbox:abc123def456')).toBe(
      'abc123def456',
    );
  });

  test('extracts hash from dkr- tag', () => {
    expect(extractTagHash('ox-sandbox:dkr-abc123-def456789012')).toBe(
      'abc123-def456789012',
    );
  });

  test('extracts hash from psl- tag', () => {
    expect(extractTagHash('ox-sandbox:psl-abc123-def456789012')).toBe(
      'abc123-def456789012',
    );
  });

  test('extracts hash from a- agent tag', () => {
    expect(extractTagHash('ox-sandbox:a-claude-abc123-def456789012')).toBe(
      'claude-abc123-def456789012',
    );
  });

  test('handles tag-only input', () => {
    expect(extractTagHash('md5-abc123def456')).toBe('abc123def456');
  });
});

describe('computeProjectSetupHash', () => {
  test('produces 12-char hex string', () => {
    const hash = computeProjectSetupHash('basehash1234', 'apt install python3');
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });

  test('changes when script changes', () => {
    const h1 = computeProjectSetupHash('base123', 'script-a');
    const h2 = computeProjectSetupHash('base123', 'script-b');
    expect(h1).not.toBe(h2);
  });

  test('changes when base hash changes', () => {
    const h1 = computeProjectSetupHash('base-a', 'same-script');
    const h2 = computeProjectSetupHash('base-b', 'same-script');
    expect(h1).not.toBe(h2);
  });
});

describe('getProjectSetupTag', () => {
  test('returns psl- prefixed tag with parent6 and hash12', () => {
    const tag = getProjectSetupTag('ox-sandbox:md5-abc123def456', 'my-script');
    expect(tag).toMatch(/^ox-sandbox:psl-abc123-[a-f0-9]{12}$/);
  });

  test('normalizes GHCR base image to local ox-sandbox prefix', () => {
    const tag = getProjectSetupTag(
      'ghcr.io/timescale/ox/sandbox:abc123def456',
      'my-script',
    );
    expect(tag).toMatch(/^ox-sandbox:psl-abc123-[a-f0-9]{12}$/);
  });

  test('produces same hash regardless of base image prefix', () => {
    const local = getProjectSetupTag(
      'ox-sandbox:md5-abc123def456',
      'my-script',
    );
    const ghcr = getProjectSetupTag(
      'ghcr.io/timescale/ox/sandbox:abc123def456',
      'my-script',
    );
    expect(local).toBe(ghcr);
  });

  test('parent6 changes when built on dkr layer vs base', () => {
    const onBase = getProjectSetupTag(
      'ox-sandbox:md5-abc123def456',
      'my-script',
    );
    const onDkr = getProjectSetupTag(
      'ox-sandbox:dkr-abc123-999999999999',
      'my-script',
    );
    // Different parent → different parent6 prefix and different hash
    expect(onBase).not.toBe(onDkr);
  });
});

describe('getDockerSandboxSetupTag', () => {
  test('returns dkr- prefixed tag with parent6 and hash12', () => {
    const tag = getDockerSandboxSetupTag('ox-sandbox:md5-abc123def456');
    expect(tag).toMatch(/^ox-sandbox:dkr-abc123-[a-f0-9]{12}$/);
  });

  test('normalizes GHCR base image to local ox-sandbox prefix', () => {
    const tag = getDockerSandboxSetupTag(
      'ghcr.io/timescale/ox/sandbox:abc123def456',
    );
    expect(tag).toMatch(/^ox-sandbox:dkr-abc123-[a-f0-9]{12}$/);
  });
});

describe('computeAgentOverlayHash', () => {
  test('produces 12-char hex string', () => {
    const hash = computeAgentOverlayHash('basehash1234', 'claude');
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });

  test('changes when parent hash changes', () => {
    const h1 = computeAgentOverlayHash('parent-a', 'claude');
    const h2 = computeAgentOverlayHash('parent-b', 'claude');
    expect(h1).not.toBe(h2);
  });

  test('changes when agent changes', () => {
    const h1 = computeAgentOverlayHash('same-parent', 'claude');
    const h2 = computeAgentOverlayHash('same-parent', 'opencode');
    expect(h1).not.toBe(h2);
  });
});

describe('getAgentOverlayTag', () => {
  test('returns a- prefixed tag with agent, parent6, and hash12', () => {
    const tag = getAgentOverlayTag('ox-sandbox:md5-abc123def456', 'claude');
    expect(tag).toMatch(/^ox-sandbox:a-claude-abc123-[a-f0-9]{12}$/);
  });

  test('parent6 reflects dkr layer when built on dkr base', () => {
    const tag = getAgentOverlayTag(
      'ox-sandbox:dkr-abc123-def456789012',
      'claude',
    );
    // parent hash is 'abc123-def456789012', first 6 chars = 'abc123'
    expect(tag).toMatch(/^ox-sandbox:a-claude-abc123-[a-f0-9]{12}$/);
  });
});

describe('buildDockerSandboxRootInitScript', () => {
  test('returns undefined when dockerInSandbox is disabled and no rootInitScript exists', () => {
    expect(buildDockerSandboxRootInitScript({})).toBeUndefined();
  });

  test('returns dockerd startup script when dockerInSandbox is enabled', () => {
    const script = buildDockerSandboxRootInitScript({ dockerInSandbox: true });
    expect(script).toContain('dockerd --host=unix:///var/run/docker.sock');
    expect(script).toContain('--storage-driver=fuse-overlayfs');
  });

  test('prepends dockerd startup before user rootInitScript', () => {
    const script = buildDockerSandboxRootInitScript({
      dockerInSandbox: true,
      rootInitScript: 'apt-get update',
    });
    expect(script).toContain('apt-get update');
    expect(script?.indexOf('dockerd')).toBeLessThan(
      script?.indexOf('apt-get update') ?? 0,
    );
  });
});

describe('resolveDockerSandboxPrivilege', () => {
  test('defaults to false when dockerInSandbox is disabled', () => {
    expect(resolveDockerSandboxPrivilege({})).toEqual({
      privileged: false,
      warning: undefined,
    });
  });

  test('enables privileged when dockerInSandbox is enabled and privileged is unset', () => {
    expect(resolveDockerSandboxPrivilege({ dockerInSandbox: true })).toEqual({
      privileged: true,
      warning: undefined,
    });
  });

  test('warns and respects explicit privileged false', () => {
    expect(
      resolveDockerSandboxPrivilege({
        dockerInSandbox: true,
        privileged: false,
      }),
    ).toEqual({
      privileged: false,
      warning: expect.stringContaining('privileged: false'),
    });
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
      // With no config, should return GHCR sandbox image with content hash
      const config = await resolveSandboxImage({});
      expect(config.needsBuild).toBe(false);
      expect(config.image).toMatch(
        /ghcr\.io\/timescale\/ox\/sandbox:[a-f0-9]{12}/,
      );
    });

    test('returns consistent values for same config', async () => {
      const config1 = await resolveSandboxImage({});
      const config2 = await resolveSandboxImage({});
      expect(config1.image).toBe(config2.image);
      expect(config1.needsBuild).toBe(config2.needsBuild);
    });

    test('returns content-hash-tagged image (not :latest or version)', async () => {
      const config = await resolveSandboxImage({});
      const hash = computeDockerfileHash(BASE_DOCKERFILE);
      expect(config.image).not.toContain(':latest');
      expect(config.image).toBe(`ghcr.io/timescale/ox/sandbox:${hash}`);
    });
  });
});
