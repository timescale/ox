import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';
import { type LogStream, streamContainerLogs } from '../services/docker';
import { useTheme } from '../stores/themeStore';
import { AnsiText } from './AnsiText';

export interface LogViewerProps {
  containerId: string;
  isInteractive: boolean;
  onError?: (error: string) => void;
}

export function LogViewer({
  containerId,
  isInteractive,
  onError,
}: LogViewerProps) {
  const { theme } = useTheme();
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);
  const streamRef = useRef<LogStream | null>(null);

  // Load initial logs and start streaming for running containers
  // Skip for interactive sessions since their logs are TUI state, not text
  useEffect(() => {
    if (isInteractive) {
      setLoading(false);
      return;
    }

    let mounted = true;

    async function loadLogs() {
      try {
        setLines([]);
        const stream = streamContainerLogs(containerId);
        streamRef.current = stream;
        setLoading(false);

        // Process stream in background
        (async () => {
          try {
            for await (const line of stream.lines) {
              if (!mounted) break;
              setLines((prev) => [...prev, line]);
            }
          } catch (err) {
            if (mounted && onError) {
              onError(`Log stream error: ${err}`);
            }
          }
        })();
      } catch (err) {
        if (mounted) {
          setLoading(false);
          if (onError) {
            onError(`Failed to load logs: ${err}`);
          }
        }
      }
    }

    loadLogs();

    return () => {
      mounted = false;
      if (streamRef.current) {
        streamRef.current.stop();
        streamRef.current = null;
      }
    };
  }, [containerId, isInteractive, onError]);

  useKeyboard((key) => {
    if (key.name === 'up' || key.raw === 'k') {
      scrollboxRef.current?.scrollBy({ x: 0, y: -1 });
    } else if (key.name === 'down' || key.raw === 'j') {
      scrollboxRef.current?.scrollBy({ x: 0, y: 1 });
    } else if (key.raw === 'g') {
      scrollboxRef.current?.scrollTo({ x: 0, y: 0 });
    } else if (key.raw === 'G') {
      scrollboxRef.current?.scrollTo(Infinity);
    }
  });

  if (loading) {
    return (
      <box flexGrow={1} alignItems="center" justifyContent="center">
        <text fg={theme.textMuted}>Loading logs...</text>
      </box>
    );
  }

  // Interactive sessions use a full TUI, so logs aren't meaningful text
  if (isInteractive) {
    return (
      <box flexGrow={1} alignItems="center" justifyContent="center">
        <text fg={theme.textMuted}>
          Logs not available for interactive sessions
        </text>
      </box>
    );
  }

  if (lines.length === 0) {
    return (
      <box flexGrow={1} alignItems="center" justifyContent="center">
        <text fg={theme.textMuted}>No logs available</text>
      </box>
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <scrollbox
        ref={scrollboxRef}
        flexGrow={1}
        flexShrink={1}
        stickyScroll
        stickyStart="bottom"
      >
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: log lines are append-only with no stable ID
          <text key={i} wrapMode="word">
            <AnsiText>{line || ' '}</AnsiText>
          </text>
        ))}
      </scrollbox>
    </box>
  );
}
