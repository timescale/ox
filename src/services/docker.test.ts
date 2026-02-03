import { describe, expect, test } from 'bun:test';
import { HASHED_SANDBOX_DOCKER_IMAGE, SANDBOX_DOCKERFILE } from './docker';

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

  describe('SANDBOX_DOCKERFILE - minimal image', () => {
    test('dockerfile is defined and non-empty', () => {
      expect(SANDBOX_DOCKERFILE).toBeDefined();
      expect(typeof SANDBOX_DOCKERFILE).toBe('string');
      expect(SANDBOX_DOCKERFILE.length).toBeGreaterThan(0);
    });

    test('uses Ubuntu 24.04 base', () => {
      expect(SANDBOX_DOCKERFILE).toContain('FROM ubuntu:24.04');
    });

    test('describes itself as minimal', () => {
      expect(SANDBOX_DOCKERFILE).toContain('Minimal');
    });

    // Essential tools that SHOULD be included
    describe('includes essential tools', () => {
      test('includes build-essential', () => {
        expect(SANDBOX_DOCKERFILE).toContain('build-essential');
      });

      test('includes git', () => {
        expect(SANDBOX_DOCKERFILE).toContain('git');
      });

      test('includes Node.js', () => {
        expect(SANDBOX_DOCKERFILE).toContain('nodejs');
      });

      test('includes Bun', () => {
        expect(SANDBOX_DOCKERFILE).toContain('bun.sh/install');
      });

      test('includes Python', () => {
        expect(SANDBOX_DOCKERFILE).toContain('python3');
      });

      test('includes PostgreSQL client', () => {
        expect(SANDBOX_DOCKERFILE).toContain('postgresql-client');
      });

      test('includes GitHub CLI', () => {
        expect(SANDBOX_DOCKERFILE).toContain('gh');
      });

      test('includes Claude Code', () => {
        expect(SANDBOX_DOCKERFILE).toContain('claude.ai/install.sh');
      });

      test('includes OpenCode', () => {
        expect(SANDBOX_DOCKERFILE).toContain('opencode.ai/install');
      });

      test('includes Tiger CLI', () => {
        expect(SANDBOX_DOCKERFILE).toContain('cli.tigerdata.com');
      });
    });

    // Tools that should NOT be in the minimal image
    describe('excludes non-essential tools (minimal image)', () => {
      test('does not include Go installation', () => {
        // Should not have go.dev download or GO_VERSION
        expect(SANDBOX_DOCKERFILE).not.toContain('go.dev/dl');
        expect(SANDBOX_DOCKERFILE).not.toContain('GO_VERSION');
      });

      test('does not include Docker installation', () => {
        // Should not have docker.com download
        expect(SANDBOX_DOCKERFILE).not.toContain('download.docker.com');
        expect(SANDBOX_DOCKERFILE).not.toContain('docker-ce');
      });

      test('does not include ngrok installation', () => {
        expect(SANDBOX_DOCKERFILE).not.toContain('ngrok');
      });

      test('does not include PostgreSQL server (only client)', () => {
        // Should have client but not server
        expect(SANDBOX_DOCKERFILE).toContain('postgresql-client-18');
        expect(SANDBOX_DOCKERFILE).not.toMatch(/postgresql-18[^-]/);
        expect(SANDBOX_DOCKERFILE).not.toContain('postgresql-doc');
      });

      test('does not include SLIM build arg (no conditional builds)', () => {
        expect(SANDBOX_DOCKERFILE).not.toContain('ARG SLIM');
        expect(SANDBOX_DOCKERFILE).not.toContain('SLIM=true');
        expect(SANDBOX_DOCKERFILE).not.toContain('SLIM=false');
      });

      test('does not include lazy-loading scripts', () => {
        expect(SANDBOX_DOCKERFILE).not.toContain('hermes-tool-install');
        expect(SANDBOX_DOCKERFILE).not.toContain('.hermes-tools');
      });
    });

    // Security and best practices
    describe('security and best practices', () => {
      test('creates non-root user', () => {
        expect(SANDBOX_DOCKERFILE).toContain('useradd');
        expect(SANDBOX_DOCKERFILE).toContain('USER');
      });

      test('cleans up apt lists after install', () => {
        expect(SANDBOX_DOCKERFILE).toContain('rm -rf /var/lib/apt/lists/*');
      });

      test('sets working directory', () => {
        expect(SANDBOX_DOCKERFILE).toContain('WORKDIR /work');
      });
    });
  });
});
