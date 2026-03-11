// ============================================================================
// Feedback Service - Send user feedback to Slack via incoming webhook
// ============================================================================

import packageJson from '../../package.json' with { type: 'json' };
import { getOrCreateDistinctId, track } from './analytics';
import { log } from './logger';

// ============================================================================
// Constants
// ============================================================================

// Build-time constant injected via `bun build --define`.
// Falls back to empty string when building from source without the secret.
declare const __OX_FEEDBACK_WEBHOOK_URL__: string;

const FETCH_TIMEOUT_MS = 10_000;

// ============================================================================
// Public API
// ============================================================================

export interface FeedbackResult {
  success: boolean;
  error?: string;
}

/**
 * Resolve the Slack webhook URL.
 * Priority: env var > build-time constant > undefined.
 */
export function getFeedbackWebhookUrl(): string | undefined {
  const envUrl = process.env.OX_FEEDBACK_WEBHOOK_URL;
  if (envUrl) return envUrl;

  // Build-time define: the bundler replaces the identifier with a string literal.
  // When building from source the declare above gives us `undefined` at runtime,
  // so we guard with typeof + truthiness.
  try {
    if (
      typeof __OX_FEEDBACK_WEBHOOK_URL__ === 'string' &&
      __OX_FEEDBACK_WEBHOOK_URL__
    ) {
      return __OX_FEEDBACK_WEBHOOK_URL__;
    }
  } catch {
    // ReferenceError when running from source without --define
  }

  return undefined;
}

/**
 * Send feedback to Slack. Fire-and-forget safe: never throws.
 */
export async function sendFeedback(message: string): Promise<FeedbackResult> {
  track('feedback_submitted', { message });
  try {
    const url = getFeedbackWebhookUrl();
    if (!url) {
      return {
        success: false,
        error: 'Feedback is not configured in this build.',
      };
    }

    const trimmed = message.trim();
    if (!trimmed) {
      return { success: false, error: 'Feedback message is empty.' };
    }

    const payload = {
      text: [
        `> ${trimmed.replace(/\n/g, '\n> ')}`,
        `_v${packageJson.version} \u00b7 ${process.platform}/${process.arch} \u00b7 ${new Date().toISOString()}_`,
        `_${await getOrCreateDistinctId()}_`,
      ].join('\n'),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      log.debug(
        { status: response.status },
        'Feedback webhook returned non-OK status',
      );
      return {
        success: false,
        error: 'Failed to send feedback. Please try again later.',
      };
    }

    return { success: true };
  } catch (err) {
    log.debug({ err }, 'Failed to send feedback');
    return {
      success: false,
      error: 'Failed to send feedback. Please try again later.',
    };
  }
}
