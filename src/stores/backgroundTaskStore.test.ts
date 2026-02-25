import { afterEach, describe, expect, test } from 'bun:test';
import { useBackgroundTaskStore } from './backgroundTaskStore';

describe('backgroundTaskStore', () => {
  afterEach(() => {
    useBackgroundTaskStore.getState().clear();
    useBackgroundTaskStore.getState().setShuttingDown(false);
  });

  test('enqueue adds a task and runs it', async () => {
    const { enqueue } = useBackgroundTaskStore.getState();
    let ran = false;
    const id = enqueue('test task', async () => {
      ran = true;
    });
    expect(id).toBeTruthy();
    await useBackgroundTaskStore.getState().waitForAll();
    expect(ran).toBe(true);
    const task = useBackgroundTaskStore
      .getState()
      .tasks.find((t) => t.id === id);
    expect(task?.status).toBe('completed');
  });

  test('failed task has error status and message', async () => {
    const { enqueue } = useBackgroundTaskStore.getState();
    const id = enqueue('fail task', async () => {
      throw new Error('boom');
    });
    await useBackgroundTaskStore.getState().waitForAll();
    const task = useBackgroundTaskStore
      .getState()
      .tasks.find((t) => t.id === id);
    expect(task?.status).toBe('failed');
    expect(task?.error).toBe('boom');
  });

  test('pendingCount reflects running tasks', async () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });

    const { enqueue } = useBackgroundTaskStore.getState();
    enqueue('slow task', () => promise);

    expect(useBackgroundTaskStore.getState().pendingCount).toBe(1);
    resolve();
    await useBackgroundTaskStore.getState().waitForAll();
    expect(useBackgroundTaskStore.getState().pendingCount).toBe(0);
  });

  test('waitForAll resolves when all tasks complete', async () => {
    let resolve1!: () => void;
    let resolve2!: () => void;
    const p1 = new Promise<void>((r) => {
      resolve1 = r;
    });
    const p2 = new Promise<void>((r) => {
      resolve2 = r;
    });

    const { enqueue } = useBackgroundTaskStore.getState();
    enqueue('task 1', () => p1);
    enqueue('task 2', () => p2);

    expect(useBackgroundTaskStore.getState().pendingCount).toBe(2);

    resolve1();
    resolve2();
    await useBackgroundTaskStore.getState().waitForAll();
    expect(useBackgroundTaskStore.getState().pendingCount).toBe(0);
  });

  test('clear removes completed and failed tasks', async () => {
    const { enqueue } = useBackgroundTaskStore.getState();
    enqueue('ok', async () => {});
    enqueue('bad', async () => {
      throw new Error('x');
    });
    await useBackgroundTaskStore.getState().waitForAll();
    useBackgroundTaskStore.getState().clear();
    expect(useBackgroundTaskStore.getState().tasks).toHaveLength(0);
  });

  test('waitForAll resolves when tasks already completed', async () => {
    const { enqueue } = useBackgroundTaskStore.getState();
    enqueue('fast task', async () => {});
    // Wait for the microtask to complete the task
    await new Promise((r) => setTimeout(r, 10));
    expect(useBackgroundTaskStore.getState().pendingCount).toBe(0);
    // waitForAll should resolve immediately even though task already finished
    await useBackgroundTaskStore.getState().waitForAll();
    expect(useBackgroundTaskStore.getState().pendingCount).toBe(0);
  });

  test('shuttingDown flag', () => {
    const { setShuttingDown } = useBackgroundTaskStore.getState();
    expect(useBackgroundTaskStore.getState().shuttingDown).toBe(false);
    setShuttingDown(true);
    expect(useBackgroundTaskStore.getState().shuttingDown).toBe(true);
  });
});
