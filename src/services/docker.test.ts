import { describe, expect, test } from 'bun:test';
import { resolveSandboxImage } from './docker';

describe('docker service', () => {
  describe('resolveSandboxImage', () => {
    test('returns a valid image config', async () => {
      const config = await resolveSandboxImage();
      expect(config).toBeDefined();
      expect(config.image).toBeDefined();
      expect(typeof config.image).toBe('string');
      expect(typeof config.needsBuild).toBe('boolean');
    });

    test('returns GHCR image by default (no config)', async () => {
      // With no config, should return GHCR sandbox-slim image
      const config = await resolveSandboxImage();
      expect(config.needsBuild).toBe(false);
      expect(config.image).toMatch(/ghcr\.io\/timescale\/hermes\/sandbox-slim/);
    });

    test('returns consistent values for same config', async () => {
      const config1 = await resolveSandboxImage();
      const config2 = await resolveSandboxImage();
      expect(config1.image).toBe(config2.image);
      expect(config1.needsBuild).toBe(config2.needsBuild);
    });
  });
});
