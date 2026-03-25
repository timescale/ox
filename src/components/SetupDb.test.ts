import { describe, expect, test } from 'bun:test';
import type { GhostDatabase } from '../services/ghost.ts';
import type { TigerService } from '../services/tiger.ts';
import {
  applySetupDbProviderSelection,
  buildSetupDbServiceOptions,
  getSetupDbInitialIndex,
} from './SetupDb.tsx';

describe('applySetupDbProviderSelection', () => {
  test('clears selected service when switching providers', () => {
    expect(
      applySetupDbProviderSelection(
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

  test('stores explicit none provider and clears service id', () => {
    expect(
      applySetupDbProviderSelection(
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

describe('buildSetupDbServiceOptions', () => {
  test('builds Tiger service options with none sentinel first', () => {
    const tigerServices = [
      {
        name: 'Primary',
        service_id: 'svc_123',
        metadata: { environment: 'prod' },
        region_code: 'us-east-1',
        status: 'running',
        paused: false,
      },
    ] as TigerService[];

    expect(buildSetupDbServiceOptions('tiger', tigerServices, null)).toEqual([
      {
        name: '(None)',
        description: "This project doesn't need database forks",
        value: '__null__',
      },
      {
        name: 'Primary',
        description: 'svc_123 - prod, us-east-1, running',
        value: 'svc_123',
      },
    ]);
  });

  test('builds Ghost database options with paused label', () => {
    const ghostDatabases = [
      {
        id: 'db_123',
        name: 'Fork Parent',
        status: 'available',
        region: 'us-east-1',
        paused: true,
      },
    ] as GhostDatabase[];

    expect(buildSetupDbServiceOptions('ghost', null, ghostDatabases)).toEqual([
      {
        name: '(None)',
        description: "This project doesn't need database forks",
        value: '__null__',
      },
      {
        name: 'Fork Parent',
        description: 'db_123 - available, us-east-1 (PAUSED)',
        value: 'db_123',
      },
    ]);
  });
});

describe('getSetupDbInitialIndex', () => {
  test('prefers the none option when selection is explicitly null', () => {
    expect(
      getSetupDbInitialIndex(null, [
        { name: '(None)', value: '__null__', description: '' },
        { name: 'Primary', value: 'svc_123', description: '' },
      ]),
    ).toBe(0);
  });

  test('falls back to the first option when selection is missing', () => {
    expect(
      getSetupDbInitialIndex('missing', [
        { name: '(None)', value: '__null__', description: '' },
        { name: 'Primary', value: 'svc_123', description: '' },
      ]),
    ).toBe(0);
  });
});
