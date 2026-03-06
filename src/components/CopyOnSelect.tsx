// ============================================================================
// CopyOnSelect - Wrapper that copies selected text to clipboard on mouse up
// ============================================================================

import { useRenderer } from '@opentui/react';
import { type ReactNode, useState } from 'react';
import { copyToClipboard } from '../services/clipboard';
import { log } from '../services/logger';
import { useTheme } from '../stores/themeStore';
import { Toast } from './Toast';

export interface CopyOnSelectProps {
  children: ReactNode;
}

/**
 * Wrapper component that enables copy-on-select behavior.
 * When the user selects text and releases the mouse button,
 * the selected text is automatically copied to the clipboard.
 */
export function CopyOnSelect({ children }: CopyOnSelectProps) {
  const renderer = useRenderer();
  const [showToast, setShowToast] = useState(false);
  const { theme } = useTheme();

  const handleMouseUp = async () => {
    const selection = renderer.getSelection();
    const text = selection?.getSelectedText();
    if (text && text.length > 0) {
      try {
        await copyToClipboard(text);
        setShowToast(true);
      } catch (err) {
        log.debug({ err }, 'Failed to copy selection to clipboard');
      }
      renderer.clearSelection();
    }
  };

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      onMouseUp={handleMouseUp}
      backgroundColor={theme.background}
    >
      {children}
      {showToast && (
        <Toast
          message="Copied to clipboard"
          type="info"
          duration={1500}
          onDismiss={() => setShowToast(false)}
        />
      )}
    </box>
  );
}
