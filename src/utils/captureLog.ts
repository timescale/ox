/**
 * Capture all console.log output produced by `fn` and return it as a string.
 * Temporarily replaces console.log, records each call as a single line
 * (arguments joined by a space), then restores console.log.
 */
export function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(' '));
  try {
    fn();
  } finally {
    console.log = origLog;
  }
  return lines.join('\n');
}
