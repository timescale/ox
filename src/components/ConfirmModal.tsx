import { useKeyboard } from '@opentui/react';

export interface ConfirmModalProps {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  confirmColor?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  title,
  message,
  detail,
  confirmLabel,
  confirmColor = '#51cf66',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  useKeyboard((key) => {
    if (key.name === 'escape') {
      onCancel();
    } else if (key.name === 'return') {
      onConfirm();
    }
  });

  return (
    <box
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <box
        title={title}
        style={{
          border: true,
          borderStyle: 'single',
          padding: 2,
          paddingLeft: 3,
          paddingRight: 3,
          flexDirection: 'column',
          minWidth: 40,
          maxWidth: 60,
        }}
      >
        <text style={{ marginBottom: 1 }}>{message}</text>
        {detail && (
          <text style={{ fg: '#888888', marginBottom: 1 }}>{detail}</text>
        )}
        <box style={{ marginTop: 1, justifyContent: 'flex-end', gap: 2 }}>
          <text>
            [<span fg={confirmColor}>Enter</span>] {confirmLabel}
          </text>
          <text>
            [<span fg="#888888">Esc</span>] Cancel
          </text>
        </box>
      </box>
    </box>
  );
}
