// ============================================================================
// Cloud Snapshot Slug & Hash Tests
// ============================================================================

import { describe, expect, test } from 'bun:test';
import { CLOUD_BASE_STEPS, computeCloudBaseHash } from './cloudBaseSteps.ts';
import {
  getAgentSnapshotSlug,
  getBaseSnapshotSlug,
  getProjectSetupSnapshotSlug,
} from './cloudSnapshot.ts';

// ============================================================================
// computeCloudBaseHash
// ============================================================================

describe('computeCloudBaseHash', () => {
  test('returns a 12-character hex string', () => {
    const hash = computeCloudBaseHash();
    expect(hash).toHaveLength(12);
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  test('is stable across repeated calls', () => {
    const hash1 = computeCloudBaseHash();
    const hash2 = computeCloudBaseHash();
    expect(hash1).toBe(hash2);
  });
});

// ============================================================================
// CLOUD_BASE_STEPS
// ============================================================================

describe('CLOUD_BASE_STEPS', () => {
  test('has at least 10 steps', () => {
    expect(CLOUD_BASE_STEPS.length).toBeGreaterThanOrEqual(10);
  });

  test('every step has required fields (label, message, command)', () => {
    for (const step of CLOUD_BASE_STEPS) {
      expect(typeof step.label).toBe('string');
      expect(step.label.length).toBeGreaterThan(0);
      expect(typeof step.message).toBe('string');
      expect(step.message.length).toBeGreaterThan(0);
      expect(typeof step.command).toBe('string');
      expect(step.command.length).toBeGreaterThan(0);
    }
  });

  test('sudo is boolean or undefined for each step', () => {
    for (const step of CLOUD_BASE_STEPS) {
      expect(step.sudo === undefined || typeof step.sudo === 'boolean').toBe(
        true,
      );
    }
  });
});

// ============================================================================
// getBaseSnapshotSlug
// ============================================================================

describe('getBaseSnapshotSlug', () => {
  test('is at most 32 characters', () => {
    const slug = getBaseSnapshotSlug();
    expect(slug.length).toBeLessThanOrEqual(32);
  });

  test('contains the content hash', () => {
    const slug = getBaseSnapshotSlug();
    const hash = computeCloudBaseHash();
    expect(slug).toContain(hash);
  });

  test('does not contain the package version (digit-dash-digit-dash-digit pattern)', () => {
    const slug = getBaseSnapshotSlug();
    // A version like "0.17.0" becomes "0-17-0" after sanitization.
    // The slug should NOT contain a version pattern — it should use
    // the content hash instead.
    expect(slug).not.toMatch(/\d+-\d+-\d+/);
  });

  test('does not end with a hyphen', () => {
    const slug = getBaseSnapshotSlug();
    expect(slug).not.toMatch(/-$/);
  });

  test('is stable across repeated calls', () => {
    const slug1 = getBaseSnapshotSlug();
    const slug2 = getBaseSnapshotSlug();
    expect(slug1).toBe(slug2);
  });
});

// ============================================================================
// getProjectSetupSnapshotSlug
// ============================================================================

describe('getProjectSetupSnapshotSlug', () => {
  test('starts with oxl- prefix', () => {
    const slug = getProjectSetupSnapshotSlug('basehash1234', 'my script');
    expect(slug.startsWith('oxl-')).toBe(true);
  });

  test('is at most 32 chars', () => {
    const slug = getProjectSetupSnapshotSlug(
      'basehash1234',
      'a very long script content',
    );
    expect(slug.length).toBeLessThanOrEqual(32);
  });

  test('changes when script changes', () => {
    const s1 = getProjectSetupSnapshotSlug('base123', 'script-a');
    const s2 = getProjectSetupSnapshotSlug('base123', 'script-b');
    expect(s1).not.toBe(s2);
  });

  test('does not end with hyphen', () => {
    const slug = getProjectSetupSnapshotSlug('base123', 'test');
    expect(slug.endsWith('-')).toBe(false);
  });
});

// ============================================================================
// getAgentSnapshotSlug
// ============================================================================

describe('getAgentSnapshotSlug', () => {
  const agents = ['claude', 'opencode', 'codex'] as const;

  for (const agent of agents) {
    test(`${agent}: is at most 32 characters`, () => {
      const slug = getAgentSnapshotSlug(agent);
      expect(slug.length).toBeLessThanOrEqual(32);
    });

    test(`${agent}: contains agent name`, () => {
      const slug = getAgentSnapshotSlug(agent);
      expect(slug).toContain(agent);
    });

    test(`${agent}: contains base hash prefix (first 6 chars)`, () => {
      const slug = getAgentSnapshotSlug(agent);
      const baseHash = computeCloudBaseHash();
      const prefix = baseHash.slice(0, 6);
      expect(slug).toContain(prefix);
    });

    test(`${agent}: does not end with a hyphen`, () => {
      const slug = getAgentSnapshotSlug(agent);
      expect(slug).not.toMatch(/-$/);
    });

    test(`${agent}: is stable across repeated calls`, () => {
      const slug1 = getAgentSnapshotSlug(agent);
      const slug2 = getAgentSnapshotSlug(agent);
      expect(slug1).toBe(slug2);
    });
  }

  test('different agents produce different slugs', () => {
    const slugs = agents.map((a) => getAgentSnapshotSlug(a));
    const unique = new Set(slugs);
    expect(unique.size).toBe(agents.length);
  });

  test('uses setupHash when provided', () => {
    const slug1 = getAgentSnapshotSlug('claude');
    const slug2 = getAgentSnapshotSlug('claude', 'custom-setup-hash');
    expect(slug1).not.toBe(slug2);
  });

  test('is at most 32 chars with setupHash', () => {
    const slug = getAgentSnapshotSlug(
      'claude',
      'a-very-long-setup-hash-string',
    );
    expect(slug.length).toBeLessThanOrEqual(32);
  });
});
