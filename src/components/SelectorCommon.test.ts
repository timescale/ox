import { describe, expect, test } from 'bun:test';
import type { ScrollBoxRenderable } from '@opentui/core';
import {
  getOptionValue,
  LINES_PER_ITEM,
  MAX_VISIBLE_HEIGHT,
  scrollToIndex,
} from './SelectorCommon';

describe('SelectorCommon constants', () => {
  test('LINES_PER_ITEM is defined', () => {
    expect(LINES_PER_ITEM).toBe(2);
  });

  test('MAX_VISIBLE_HEIGHT is defined', () => {
    expect(MAX_VISIBLE_HEIGHT).toBe(20);
  });
});

describe('getOptionValue', () => {
  test('returns string value as-is', () => {
    const option = { name: 'Test', value: 'test-value', description: '' };
    expect(getOptionValue(option)).toBe('test-value');
  });

  test('returns null for __null__ sentinel value', () => {
    const option = { name: 'None', value: '__null__', description: '' };
    expect(getOptionValue(option)).toBe(null);
  });

  test('returns empty string value', () => {
    const option = { name: 'Empty', value: '', description: '' };
    expect(getOptionValue(option)).toBe('');
  });

  test('handles option with complex value', () => {
    const option = {
      name: 'Complex',
      value: 'path/to/something',
      description: 'desc',
    };
    expect(getOptionValue(option)).toBe('path/to/something');
  });
});

describe('scrollToIndex', () => {
  test('does nothing when scrollbox is null', () => {
    // Should not throw
    scrollToIndex(null, 5);
  });

  test('calculates correct scroll position for index 0', () => {
    let scrolledTo: { x: number; y: number } | undefined;
    const mockScrollbox = {
      viewport: { height: MAX_VISIBLE_HEIGHT },
      scrollTo: (pos: { x: number; y: number }) => {
        scrolledTo = pos;
      },
    } as unknown as ScrollBoxRenderable;

    scrollToIndex(mockScrollbox, 0);

    // For index 0, itemY = 0, targetScrollY should be 0
    expect(scrolledTo).toBeDefined();
    expect(scrolledTo?.x).toBe(0);
    expect(scrolledTo?.y).toBe(0);
  });

  test('calculates correct scroll position for middle index', () => {
    let scrolledTo: { x: number; y: number } | undefined;
    const mockScrollbox = {
      viewport: { height: 20 },
      scrollTo: (pos: { x: number; y: number }) => {
        scrolledTo = pos;
      },
    } as unknown as ScrollBoxRenderable;

    scrollToIndex(mockScrollbox, 10);

    // For index 10:
    // itemY = 10 * 2 = 20
    // targetScrollY = max(0, 20 - floor(20/2) + 2/2) = max(0, 20 - 10 + 1) = 11
    expect(scrolledTo).toBeDefined();
    expect(scrolledTo?.x).toBe(0);
    expect(scrolledTo?.y).toBe(11);
  });

  test('uses MAX_VISIBLE_HEIGHT when viewport is undefined', () => {
    let scrolledTo: { x: number; y: number } | undefined;
    const mockScrollbox = {
      viewport: null,
      scrollTo: (pos: { x: number; y: number }) => {
        scrolledTo = pos;
      },
    } as unknown as ScrollBoxRenderable;

    scrollToIndex(mockScrollbox, 5);

    // Should use MAX_VISIBLE_HEIGHT (20) as fallback
    // itemY = 5 * 2 = 10
    // targetScrollY = max(0, 10 - floor(20/2) + 1) = max(0, 10 - 10 + 1) = 1
    expect(scrolledTo).toBeDefined();
    expect(scrolledTo?.x).toBe(0);
    expect(scrolledTo?.y).toBe(1);
  });

  test('never scrolls to negative position', () => {
    let scrolledTo: { x: number; y: number } | undefined;
    const mockScrollbox = {
      viewport: { height: 100 }, // Very large viewport
      scrollTo: (pos: { x: number; y: number }) => {
        scrolledTo = pos;
      },
    } as unknown as ScrollBoxRenderable;

    scrollToIndex(mockScrollbox, 0);

    // Even with large viewport, y should never be negative
    expect(scrolledTo).toBeDefined();
    expect(scrolledTo?.y).toBeGreaterThanOrEqual(0);
  });
});
