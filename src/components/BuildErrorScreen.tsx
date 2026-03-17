import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useRef } from 'react';
import { useRouterStore } from '../stores/routerStore.ts';
import { useTheme } from '../stores/themeStore.ts';
import { AnsiText } from './AnsiText.tsx';

export interface BuildErrorScreenProps {
  title: string;
  message: string;
  outputLines: string[];
}

export function BuildErrorScreen({
  title,
  message,
  outputLines,
}: BuildErrorScreenProps) {
  const { theme } = useTheme();
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);
  const titleLine = `\u2717 ${title}`;

  useKeyboard((key) => {
    if (key.name === 'escape' || key.name === 'return') {
      useRouterStore.getState().goToPrompt();
    } else if (key.name === 'up' || key.raw === 'k') {
      scrollboxRef.current?.scrollBy({ x: 0, y: -1 });
    } else if (key.name === 'down' || key.raw === 'j') {
      scrollboxRef.current?.scrollBy({ x: 0, y: 1 });
    } else if (key.raw === 'g') {
      scrollboxRef.current?.scrollTo({ x: 0, y: 0 });
    } else if (key.raw === 'G') {
      scrollboxRef.current?.scrollTo(Infinity);
    }
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Header */}
      <box
        flexDirection="column"
        flexShrink={0}
        paddingX={1}
        paddingTop={1}
        paddingBottom={0}
      >
        <box flexShrink={0}>
          <text fg={theme.error}>{titleLine}</text>
        </box>
        <box flexShrink={0}>
          <text fg={theme.textMuted} wrapMode="word">
            {message}
          </text>
        </box>
      </box>

      {/* Separator */}
      <box flexShrink={0} paddingX={1} paddingY={0}>
        <text fg={theme.borderSubtle}>{'\u2500'.repeat(60)}</text>
      </box>

      {/* Scrollable output */}
      {outputLines.length > 0 ? (
        <scrollbox
          ref={scrollboxRef}
          flexGrow={1}
          flexShrink={1}
          paddingX={1}
          stickyScroll
          stickyStart="bottom"
        >
          {outputLines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: log lines are append-only with no stable ID
            <text key={i} wrapMode="word">
              <AnsiText>{line || ' '}</AnsiText>
            </text>
          ))}
        </scrollbox>
      ) : (
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>No build output captured</text>
        </box>
      )}

      {/* Footer hint */}
      <box flexShrink={0} paddingX={1} paddingBottom={1} paddingTop={0}>
        <text fg={theme.textMuted}>
          Press Escape to go back{' '}
          {outputLines.length > 0
            ? ' \u2022 j/k to scroll \u2022 g/G to jump'
            : ''}
        </text>
      </box>
    </box>
  );
}
