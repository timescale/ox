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
  test('lists Ghost database names when provider is ghost', async () => {
    const { getExistingServices } = await import('./git.ts');

    const services = await getExistingServices('ghost');

    expect(services).toEqual(['existing-ghost-db']);
    expect(listGhostDatabases).toHaveBeenCalledTimes(1);
  });
});
