import { describe, expect, test } from 'bun:test';
import { toVolumeArgs } from './docker';

describe('toVolumeArgs', () => {
  test('returns empty array for empty input', () => {
    expect(toVolumeArgs([])).toEqual([]);
  });

  test('flattens single volume to -v flag pair', () => {
    expect(toVolumeArgs(['/host:/container'])).toEqual([
      '-v',
      '/host:/container',
    ]);
  });

  test('flattens multiple volumes to alternating -v and path', () => {
    expect(toVolumeArgs(['/a:/b', '/c:/d'])).toEqual([
      '-v',
      '/a:/b',
      '-v',
      '/c:/d',
    ]);
  });
});
