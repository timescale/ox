import { afterEach, describe, expect, test } from 'bun:test';
import { useToastStore } from './toastStore.ts';

describe('toastStore', () => {
  afterEach(() => {
    useToastStore.getState().dismiss();
  });

  test('show sets the current toast', () => {
    const { show } = useToastStore.getState();
    show('Hello', 'success');
    const { current } = useToastStore.getState();
    expect(current).not.toBeNull();
    expect(current?.message).toBe('Hello');
    expect(current?.type).toBe('success');
  });

  test('show replaces existing toast', () => {
    const { show } = useToastStore.getState();
    show('First', 'info');
    show('Second', 'error');
    const { current } = useToastStore.getState();
    expect(current?.message).toBe('Second');
  });

  test('dismiss clears the current toast', () => {
    const { show, dismiss } = useToastStore.getState();
    show('Hello', 'success');
    dismiss();
    expect(useToastStore.getState().current).toBeNull();
  });

  test('show accepts optional duration', () => {
    const { show } = useToastStore.getState();
    show('Custom', 'warning', 5000);
    expect(useToastStore.getState().current?.duration).toBe(5000);
  });
});
