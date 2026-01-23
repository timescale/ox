import { RGBA, TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type { ReactNode } from 'react';

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
    >
      <box
        padding={1}
        flexDirection="column"
        minWidth={minWidth}
        maxWidth={maxWidth}
        backgroundColor="#151515"
      >
        <box
          marginLeft={2}
          marginRight={2}
          marginBottom={1}
          flexDirection="row"
        >
          <text flexGrow={1} flexShrink={1} attributes={TextAttributes.BOLD}>
            {title}
          </text>
          {onClose ? <text fg="#888888">esc</text> : null}
        </box>
        {children}
      </box>
    </box>
  );
}
