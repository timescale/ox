// ============================================================================
// Completion Notifications
// ============================================================================

/**
 * Send a terminal bell character to alert the user.
 * The bell (BEL, \x07) causes most terminal emulators to produce an audible
 * or visual alert.
 */
export function sendBell(): void {
  process.stdout.write('\x07');
}

/**
 * Send a native OS notification if a supported tool is available.
 * Silently fails if no notification tool is found or if it errors.
 *
 * - macOS: uses `osascript`
 * - Linux: uses `notify-send` (libnotify)
 */
export async function sendNativeNotification(
  title: string,
  body: string,
): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
      await Bun.$`osascript -e ${script}`.quiet();
    } else if (process.platform === 'linux') {
      await Bun.$`notify-send ${title} ${body}`.quiet();
    }
  } catch {
    // Silently ignore — notification tools may not be installed
  }
}

/**
 * Notify the user that a session has completed or failed.
 * Sends a terminal bell and a native OS notification (fire-and-forget).
 */
export function notifySessionComplete(name: string, success: boolean): void {
  sendBell();
  const title = `Ox session ${success ? 'completed' : 'failed'}`;
  const body = `"${name}" ${success ? 'completed successfully' : 'failed'}`;
  sendNativeNotification(title, body).catch(() => {});
}
