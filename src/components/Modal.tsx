import { RGBA, TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type { ReactNode } from 'react';
import { useTheme } from '../stores/themeStore.ts';

export interface ModalProps {
  title: string;
  children: ReactNode;
  minWidth?: number;
  maxWidth?: number;
  onClose?: () => void;
}

export function Modal({
  title,
  children,
  minWidth = 40,
  maxWidth = 60,
  onClose,
}: ModalProps) {
  const { theme } = useTheme();

  useKeyboard((key) => {
    if (key.name === 'escape') {
      onClose?.();
    }
  });

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      alignItems="center"
      justifyContent="center"
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
      onMouseDown={onClose}
    >
      <box
        padding={1}
        flexDirection="column"
        minWidth={minWidth}
        maxWidth={maxWidth}
        backgroundColor={theme.backgroundPanel}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <box
          marginLeft={2}
          marginRight={2}
          marginBottom={1}
          flexDirection="row"
        >
          <text
            flexGrow={1}
            flexShrink={1}
            attributes={TextAttributes.BOLD}
            fg={theme.text}
          >
            {title}
          </text>
          {onClose ? (
            <text fg={theme.textMuted} onMouseDown={onClose}>
              esc
            </text>
          ) : null}
        </box>
        {children}
      </box>
    </box>
  );
}
