import { describe, expect, test } from 'bun:test';
import { somePromise } from './promise.ts';

describe('somePromise', () => {
  test('resolves true as soon as any promise resolves true', async () => {
    let slowResolved = false;

    const result = await somePromise([
      new Promise((resolve) => {
        setTimeout(() => resolve(false), 30);
      }),
      new Promise((resolve) => {
        setTimeout(() => resolve(true), 5);
      }),
      new Promise((resolve) => {
        setTimeout(() => {
          slowResolved = true;
          resolve(false);
        }, 50);
      }),
    ]);

    expect(result).toBe(true);
    expect(slowResolved).toBe(false);
  });

  test('resolves false after all promises resolve false', async () => {
    const result = await somePromise([
      Promise.resolve(false),
      new Promise((resolve) => {
        setTimeout(() => resolve(false), 5);
      }),
    ]);

    expect(result).toBe(false);
  });

  test('resolves false for an empty list', async () => {
    await expect(somePromise([])).resolves.toBe(false);
  });
});
