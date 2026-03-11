// ============================================================================
// Feedback Modal - Compose and submit product feedback from the TUI
// ============================================================================

import type { TextareaRenderable } from '@opentui/core';
import { useEffect, useRef, useState } from 'react';
import { sendFeedback } from '../services/feedback';
import { useTheme } from '../stores/themeStore';
import { ActionButton } from './ActionButton';
import { Modal } from './Modal';

export interface FeedbackModalProps {
  onClose: () => void;
  onSuccess: () => void;
  onError: (message: string) => void;
}

export function FeedbackModal({
  onClose,
  onSuccess,
  onError,
}: FeedbackModalProps) {
  const { theme } = useTheme();
  const textareaRef = useRef<TextareaRenderable>(null);
  const [sending, setSending] = useState(false);

  // Imperatively grab focus once the textarea is mounted.
  // The declarative `focused` prop alone can lose a race with other
  // focused elements when the suspend/unfocus cycle hasn't flushed yet.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = async () => {
    const text = textareaRef.current?.plainText.trim() ?? '';
    if (!text) return;

    setSending(true);
    const result = await sendFeedback(text);
    setSending(false);

    if (result.success) {
      onSuccess();
    } else {
      onError(result.error ?? 'Failed to send feedback.');
    }
    onClose();
  };

  return (
    <Modal title="Send Feedback" minWidth={50} maxWidth={70} onClose={onClose}>
      <box marginLeft={2} marginRight={2} marginBottom={1}>
        <text fg={theme.textMuted}>
          Share your thoughts, report a bug, or request a feature.
        </text>
      </box>
      <box
        marginLeft={2}
        marginRight={2}
        border
        borderStyle="single"
        borderColor={theme.textMuted}
      >
        <textarea
          ref={textareaRef}
          focused={!sending}
          placeholder="Type your feedback..."
          onSubmit={handleSubmit}
          keyBindings={[
            { name: 'return', ctrl: true, action: 'newline' },
            { name: 'return', meta: true, action: 'newline' },
            { name: 'return', shift: true, action: 'newline' },
            { name: 'return', action: 'submit' },
          ]}
          backgroundColor={theme.backgroundElement}
          focusedBackgroundColor={theme.backgroundElement}
          textColor={theme.text}
          focusedTextColor={theme.text}
          minHeight={3}
          maxHeight={8}
        />
      </box>
      <box flexDirection="row-reverse" marginTop={1} marginRight={2} gap={1}>
        <ActionButton
          label={sending ? 'sending...' : 'send'}
          keybind="enter"
          color={theme.primary}
          disabled={sending}
          onPress={handleSubmit}
        />
        <ActionButton
          label="cancel"
          keybind="esc"
          color={theme.textMuted}
          onPress={onClose}
        />
      </box>
    </Modal>
  );
}
