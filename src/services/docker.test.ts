import { describe, expect, test } from 'bun:test';
import { HASHED_SANDBOX_DOCKER_IMAGE } from './docker';

describe('docker service', () => {
  describe('HASHED_SANDBOX_DOCKER_IMAGE', () => {
    test('returns a valid image tag', () => {
      const tag = HASHED_SANDBOX_DOCKER_IMAGE;
      expect(tag).toBeDefined();
      expect(typeof tag).toBe('string');
    });

    test('tag starts with hermes-sandbox', () => {
      const tag = HASHED_SANDBOX_DOCKER_IMAGE;
      expect(tag.startsWith('hermes-sandbox:')).toBe(true);
    });

    test('tag includes md5 hash', () => {
      const tag = HASHED_SANDBOX_DOCKER_IMAGE;
      expect(tag).toMatch(/hermes-sandbox:md5-[a-f0-9]{12}/);
    });

    test('returns consistent value', () => {
      const tag1 = HASHED_SANDBOX_DOCKER_IMAGE;
      const tag2 = HASHED_SANDBOX_DOCKER_IMAGE;
      expect(tag1).toBe(tag2);
    });
  });
});
