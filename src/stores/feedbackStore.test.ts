import { afterEach, describe, expect, test } from 'bun:test';
import { useFeedbackStore } from './feedbackStore.ts';

describe('feedbackStore', () => {
  afterEach(() => {
    useFeedbackStore.getState().close();
  });

  test('starts closed', () => {
    expect(useFeedbackStore.getState().isOpen).toBe(false);
  });

  test('open() sets isOpen to true', () => {
    useFeedbackStore.getState().open();
    expect(useFeedbackStore.getState().isOpen).toBe(true);
  });

  test('close() sets isOpen to false', () => {
    useFeedbackStore.getState().open();
    useFeedbackStore.getState().close();
    expect(useFeedbackStore.getState().isOpen).toBe(false);
  });
});
