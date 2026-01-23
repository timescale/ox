import type { MouseEvent, TextareaRenderable } from '@opentui/core';
import { useRef, useState } from 'react';
import { Modal } from './Modal';

export interface PromptModalProps {
  title: string;
  message: string;
  placeholder?: string;
  onSubmit: (prompt: string) => void;
  onCancel: () => void;
}

export function PromptModal({
  title,
  message,
  placeholder,
  onSubmit,
  onCancel,
}: PromptModalProps) {
  const ref = useRef<TextareaRenderable>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title={title} minWidth={80} maxWidth={80} onClose={onCancel}>
      <box paddingLeft={2} paddingRight={2}>
        <text marginBottom={1}>{message}</text>
        <box padding={1} backgroundColor="#222">
          <textarea
            ref={ref}
            focused
            placeholder={placeholder ?? 'Enter prompt...'}
            onSubmit={() => {
              const trimmed = ref.current?.plainText.trim() || '';
              if (!trimmed) {
                setError('Prompt is required.');
                return;
              }
              onSubmit(trimmed);
            }}
            onContentChange={(e) => {
              if (error) setError(null);
            }}
            onMouseDown={(r: MouseEvent) => r.target?.focus()}
            keyBindings={[
              { name: 'return', ctrl: true, action: 'newline' },
              { name: 'return', meta: true, action: 'newline' },
              { name: 'return', shift: true, action: 'newline' },
              { name: 'return', action: 'submit' },
            ]}
            backgroundColor="#222"
            focusedBackgroundColor="#222"
            textColor="#fff"
            focusedTextColor="#fff"
            minHeight={1}
            maxHeight={5}
            flexWrap="wrap"
          />
        </box>
        {error && (
          <text fg="#ff6b6b" marginTop={1}>
            {error}
          </text>
        )}
      </box>
    </Modal>
  );
}
