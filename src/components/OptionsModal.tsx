import { useKeyboard } from '@opentui/react';
import { type ReactNode, useState } from 'react';
import { Modal } from './Modal';

export interface Option {
  key?: string;
  name: string;
  description?: string;
  onSelect: () => void;
  color?: string;
}

export interface OptionsModalProps {
  title: string;
  message: string;
  options: Option[];
  onCancel: () => void;
  minWidth?: number;
  maxWidth?: number;
  children?: ReactNode;
}

export function OptionsModal({
  title,
  message,
  options,
  onCancel,
  minWidth,
  maxWidth,
  children,
}: OptionsModalProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  useKeyboard((key) => {
    if (key.name === 'up') {
      setSelectedIndex((prev) => (prev === 0 ? options.length - 1 : prev - 1));
      key.stopPropagation();
      key.preventDefault();
      return;
    }
    if (key.name === 'down') {
      setSelectedIndex((prev) => (prev === options.length - 1 ? 0 : prev + 1));
      key.stopPropagation();
      key.preventDefault();
      return;
    }
    if (key.name === 'return') {
      options[selectedIndex]?.onSelect();
      return;
    }
    for (const option of options) {
      if (key.raw === option.key || key.name === option.key) {
        option.onSelect();
        return;
      }
    }
  });

  return (
    <Modal
      title={title}
      minWidth={minWidth}
      maxWidth={maxWidth}
      onClose={onCancel}
    >
      <text fg="#ddd" marginLeft={2} marginRight={2}>
        {message}
      </text>
      {children}
      <box marginTop={1} justifyContent="flex-end">
        {options.map((option, index) => {
          const sel = index === selectedIndex;
          return (
            <box
              key={option.name}
              paddingLeft={2}
              paddingRight={2}
              backgroundColor={sel ? '#FBB283' : undefined}
            >
              <text fg={sel ? '#0B0A0A' : '#eee'}>
                {option.key ? (
                  <>
                    [
                    <span fg={sel ? undefined : option.color}>
                      {option.key}
                    </span>
                    ]{' '}
                  </>
                ) : null}
                {option.name}
                {option.description ? (
                  <span fg={sel ? '#222' : '#888'}>
                    {' '}
                    - {option.description}
                  </span>
                ) : null}
              </text>
            </box>
          );
        })}
      </box>
    </Modal>
  );
}
