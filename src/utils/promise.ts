/**
 * Like `Array.some()` but for promises. Resolves `true` as soon as any
 * promise yields a truthy value (short-circuiting without waiting for the
 * rest), or `false` if every promise resolves falsy. Rejects immediately
 * if any promise rejects.
 *
 * Returns `false` for an empty array (vacuous truth of "none matched").
 */
export const somePromise = async (
  promises: Promise<unknown>[],
): Promise<boolean> => {
  if (promises.length === 0) {
    return false;
  }

  return new Promise((resolve, reject) => {
    let remaining = promises.length;
    let settled = false;

    for (const promise of promises) {
      void promise.then(
        (result) => {
          if (settled) {
            return;
          }

          if (result) {
            settled = true;
            resolve(true);
            return;
          }

          remaining -= 1;
          if (remaining === 0) {
            settled = true;
            resolve(false);
          }
        },
        (error) => {
          if (settled) {
            return;
          }

          settled = true;
          reject(error);
        },
      );
    }
  });
};
