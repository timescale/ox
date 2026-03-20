export class AbortError extends Error {
  constructor(message = 'Aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AbortError();
  }
}

export function onAbort(
  signal: AbortSignal | undefined,
  fn: () => void,
): () => void {
  if (!signal) {
    return () => {};
  }

  if (signal.aborted) {
    fn();
    return () => {};
  }

  signal.addEventListener('abort', fn, { once: true });
  return () => signal.removeEventListener('abort', fn);
}

export async function raceAbort<T>(
  signal: AbortSignal | undefined,
  promise: Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    // `once: true` on the abort listener auto-removes it, so no manual
    // cleanup is needed inside the handler — only in the resolve/reject paths.
    const cleanup = onAbort(signal, () => reject(new AbortError()));

    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

export function isAbortError(err: unknown): err is AbortError {
  return (
    err instanceof AbortError ||
    (err instanceof Error && err.name === 'AbortError')
  );
}
