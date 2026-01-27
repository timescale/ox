import { describe, expect, test } from 'bun:test';
import { getDockerImageTag, getOpencodeAuthMount } from './docker';

describe('docker service', () => {
  describe('getDockerImageTag', () => {
    test('returns a valid image tag', () => {
      const tag = getDockerImageTag();
      expect(tag).toBeDefined();
      expect(typeof tag).toBe('string');
    });

    test('tag starts with hermes-sandbox', () => {
      const tag = getDockerImageTag();
      expect(tag.startsWith('hermes-sandbox:')).toBe(true);
    });

    test('tag includes md5 hash', () => {
      const tag = getDockerImageTag();
      expect(tag).toMatch(/hermes-sandbox:md5-[a-f0-9]{12}/);
    });

    test('returns consistent value', () => {
      const tag1 = getDockerImageTag();
      const tag2 = getDockerImageTag();
      expect(tag1).toBe(tag2);
    });
  });

  describe('getOpencodeAuthMount', () => {
    test('returns valid OpencodeAuthMount structure', async () => {
      const mount = await getOpencodeAuthMount();

      expect(typeof mount.exists).toBe('boolean');
      expect(Array.isArray(mount.volumeArgs)).toBe(true);
      expect(typeof mount.setupScript).toBe('string');
    });

    test('volumeArgs is empty when auth does not exist', async () => {
      const mount = await getOpencodeAuthMount();

      // If auth doesn't exist, volumeArgs should be empty
      if (!mount.exists) {
        expect(mount.volumeArgs).toHaveLength(0);
        expect(mount.setupScript).toBe('');
      }
    });

    test('volumeArgs has correct format when auth exists', async () => {
      const mount = await getOpencodeAuthMount();

      if (mount.exists) {
        // Should have -v and the mount path
        expect(mount.volumeArgs).toHaveLength(2);
        expect(mount.volumeArgs[0]).toBe('-v');
        expect(mount.volumeArgs[1]).toContain(':');
        expect(mount.volumeArgs[1]).toContain(':ro');
      }
    });

    test('setupScript contains mkdir and cp when auth exists', async () => {
      const mount = await getOpencodeAuthMount();

      if (mount.exists) {
        expect(mount.setupScript).toContain('mkdir -p');
        expect(mount.setupScript).toContain('cp');
        expect(mount.setupScript).toContain('auth.json');
      }
    });
  });
});
