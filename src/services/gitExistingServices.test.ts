import { describe, expect, mock, test } from 'bun:test';

const listGhostDatabases = mock(async () => [{ name: 'existing-ghost-db' }]);

mock.module('./ghost', () => ({
  getGhostConfigFiles: mock(async () => []),
  listGhostDatabases,
  runGhostInDocker: mock(async () => {
    throw new Error('runGhostInDocker should not be called in this test');
  }),
}));

describe('getExistingServices', () => {
  test('skips Ghost database lookup when provider is ghost', async () => {
    const { getExistingServices } = await import('./git.ts');

    const services = await getExistingServices('ghost');

    expect(services).toEqual([]);
    expect(listGhostDatabases).not.toHaveBeenCalled();
  });
});
