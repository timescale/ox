import { type Option, OptionsModal } from './OptionsModal';

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
  const options: Option[] = [
    {
      key: 'enter',
      name: confirmLabel,
      description: 'remove the container',
      onSelect: onConfirm,
      color: confirmColor,
    },
    {
      key: 'escape',
      name: 'Cancel',
      onSelect: onCancel,
      color: '#888888',
    },
  ];
  return (
    <OptionsModal
      title={title}
      message={message}
      minWidth={40}
      maxWidth={60}
      options={options}
      onCancel={onCancel}
    >
      {detail && (
        <text fg="#888888" marginTop={1} marginLeft={2} marginRight={2}>
          {detail}
        </text>
      )}
    </OptionsModal>
  );
}
