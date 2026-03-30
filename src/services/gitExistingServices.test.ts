import { describe, expect, mock, test } from 'bun:test';

// Mock the ghost module to ensure no Docker-based Ghost calls are made.
// git.ts short-circuits for Ghost provider, so none of these should be invoked.
mock.module('./ghost', () => ({
  getGhostConfigFiles: mock(async () => []),
  listGhostDatabases: mock(async () => {
    throw new Error('listGhostDatabases should not be called');
  }),
  runGhostInDocker: mock(async () => {
    throw new Error('runGhostInDocker should not be called');
  }),
}));

describe('getExistingServices', () => {
  test('returns empty array without calling Ghost when provider is ghost', async () => {
    const { getExistingServices } = await import('./git.ts');

    const services = await getExistingServices('ghost');

    // Ghost provider short-circuits to avoid Docker image resolution
    expect(services).toEqual([]);
  });
});
