import { describe, expect, test } from 'bun:test';

import {
  applyDbProviderSelection,
  formatDatabaseSummary,
  getConfigWizardSteps,
} from './config';

describe('getConfigWizardSteps', () => {
  test('includes db-provider and provider-specific service step ordering', () => {
    expect(
      getConfigWizardSteps({
        sandboxProvider: 'cloud',
        dbServiceProvider: 'ghost',
      }),
    ).toEqual([
      'docker',
      'sandbox-provider',
      'cloud-region',
      'cloud-setup',
      'agent',
      'model',
      'db-provider',
      'service',
      'agent-auth-check',
      'gh-auth-check',
    ]);
  });

  test('skips service step when no database provider is selected', () => {
    expect(getConfigWizardSteps({ dbServiceProvider: null })).toEqual([
      'docker',
      'sandbox-provider',
      'agent',
      'model',
      'db-provider',
      'agent-auth-check',
      'gh-auth-check',
    ]);
  });
});

describe('applyDbProviderSelection', () => {
  test('clears the selected database when switching providers', () => {
    expect(
      applyDbProviderSelection(
        {
          dbServiceProvider: 'tiger',
          dbServiceId: 'svc_123',
        },
        'ghost',
      ),
    ).toEqual({
      dbServiceProvider: 'ghost',
      dbServiceId: undefined,
    });
  });

  test('sets explicit none provider and clears service id', () => {
    expect(
      applyDbProviderSelection(
        {
          dbServiceProvider: 'ghost',
          dbServiceId: 'db_123',
        },
        null,
      ),
    ).toEqual({
      dbServiceProvider: null,
      dbServiceId: null,
    });
  });
});

describe('formatDatabaseSummary', () => {
  test('formats no provider summary', () => {
    expect(formatDatabaseSummary({})).toBe(
      'Database: (None) - forks will be skipped by default',
    );
  });

  test('formats provider with no selected service', () => {
    expect(
      formatDatabaseSummary({
        dbServiceProvider: 'ghost',
        dbServiceId: null,
      }),
    ).toBe('Database: ghost (no service selected)');
  });

  test('formats provider with selected service id', () => {
    expect(
      formatDatabaseSummary({
        dbServiceProvider: 'tiger',
        dbServiceId: 'svc_123',
      }),
    ).toBe('Database: tiger - svc_123');
  });
});
