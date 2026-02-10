import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileFromContainer, writeFileToContainer } from './dockerFiles';

// These tests require a running Docker daemon.
// They spin up a lightweight alpine container for the duration of the suite.
// Skip in CI where Docker is not available.

describe.skipIf(!!process.env.CI)('dockerFiles', () => {
  let containerId: string;

  beforeAll(async () => {
    const proc =
      await Bun.$`docker run -d --rm alpine:latest tail -f /dev/null`.quiet();
    containerId = proc.text().trim();
  });

  afterAll(async () => {
    if (containerId) {
      await Bun.$`docker kill ${containerId}`.quiet().catch(() => {});
    }
  });
  describe('writeFileToContainer + readFileFromContainer roundtrip', () => {
    test('writes and reads back a simple text file', async () => {
      const path = '/tmp/test-simple.txt';
      const content = 'hello world';

      await writeFileToContainer(containerId, path, content);
      const result = await readFileFromContainer(containerId, path);

      expect(result).toBe(content);
    });

    test('handles multi-line content', async () => {
      const path = '/tmp/test-multiline.txt';
      const content = 'line 1\nline 2\nline 3\n';

      await writeFileToContainer(containerId, path, content);
      const result = await readFileFromContainer(containerId, path);

      expect(result).toBe(content);
    });

    test('handles empty file', async () => {
      const path = '/tmp/test-empty.txt';
      const content = '';

      await writeFileToContainer(containerId, path, content);
      const result = await readFileFromContainer(containerId, path);

      expect(result).toBe(content);
    });

    test('handles special characters and unicode', async () => {
      const path = '/tmp/test-unicode.txt';
      const content =
        'café ☕ naïve résumé 日本語 🚀\n$PATH `backticks` "quotes"';

      await writeFileToContainer(containerId, path, content);
      const result = await readFileFromContainer(containerId, path);

      expect(result).toBe(content);
    });

    test('creates intermediate directories automatically', async () => {
      const path = '/tmp/nested/deep/dir/test.txt';
      const content = 'nested file content';

      await writeFileToContainer(containerId, path, content);
      const result = await readFileFromContainer(containerId, path);

      expect(result).toBe(content);
    });

    test('overwrites an existing file', async () => {
      const path = '/tmp/test-overwrite.txt';

      await writeFileToContainer(containerId, path, 'original');
      await writeFileToContainer(containerId, path, 'updated');
      const result = await readFileFromContainer(containerId, path);

      expect(result).toBe('updated');
    });

    test('handles large content', async () => {
      const path = '/tmp/test-large.txt';
      const content = 'x'.repeat(100_000);

      await writeFileToContainer(containerId, path, content);
      const result = await readFileFromContainer(containerId, path);

      expect(result).toBe(content);
    });
  });

  describe('readFileFromContainer error handling', () => {
    test('rejects when reading a nonexistent file', async () => {
      expect(
        readFileFromContainer(containerId, '/tmp/does-not-exist.txt'),
      ).rejects.toThrow();
    });

    test('rejects when reading from an invalid container', async () => {
      expect(
        readFileFromContainer('nonexistent-container-id', '/tmp/any.txt'),
      ).rejects.toThrow();
    });
  });

  describe('writeFileToContainer error handling', () => {
    test('rejects when writing to an invalid container', async () => {
      expect(
        writeFileToContainer(
          'nonexistent-container-id',
          '/tmp/any.txt',
          'content',
        ),
      ).rejects.toThrow();
    });
  });
});
