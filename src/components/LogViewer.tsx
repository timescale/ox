import type { ScrollBoxRenderable } from '@opentui/core';
import { flushSync, useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getContainerLogs,
  type LogStream,
  streamContainerLogs,
} from '../services/docker';
import { AnsiText } from './AnsiText';

export interface LogViewerProps {
  containerId: string;
  isRunning: boolean;
  isInteractive: boolean;
  onError?: (error: string) => void;
}

export function LogViewer({
  containerId,
  isRunning,
  isInteractive,
  onError,
}: LogViewerProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [following, setFollowing] = useState(true);
  const [loading, setLoading] = useState(true);
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);
  const streamRef = useRef<LogStream | null>(null);

  // Scroll to bottom
  const scrollToBottom = useCallback(() => {
    if (scrollboxRef.current) {
      const contentHeight = lines.length;
      const viewportHeight = scrollboxRef.current.viewport?.height ?? 10;
      scrollboxRef.current.scrollTo({
        x: 0,
        y: Math.max(0, contentHeight - viewportHeight),
      });
    }
  }, [lines.length]);

  // Scroll up/down by one line
  const scrollBy = useCallback((delta: number) => {
    if (scrollboxRef.current) {
      scrollboxRef.current.scrollBy({ x: 0, y: delta });
    }
  }, []);

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
        // Get initial logs
        const initialLogs = await getContainerLogs(containerId, 1000);
        if (!mounted) return;

        const initialLines = initialLogs.split('\n');
        setLines(initialLines);
        setLoading(false);

        // If running, start streaming
        if (isRunning) {
          const stream = streamContainerLogs(containerId);
          streamRef.current = stream;

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
        }
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
  }, [containerId, isRunning, isInteractive, onError]);

  // Auto-scroll when following and new lines arrive
  useEffect(() => {
    if (following) {
      scrollToBottom();
    }
  }, [following, scrollToBottom]);

  // Keyboard navigation
  useKeyboard((key) => {
    if (key.name === 'up' || key.raw === 'k') {
      flushSync(() => setFollowing(false));
      scrollBy(-1);
    } else if (key.name === 'down' || key.raw === 'j') {
      scrollBy(1);
    } else if (key.raw === 'g') {
      flushSync(() => setFollowing(false));
      if (scrollboxRef.current) {
        scrollboxRef.current.scrollTo({ x: 0, y: 0 });
      }
    } else if (key.raw === 'G') {
      flushSync(() => setFollowing(true));
      scrollToBottom();
    }
  });

  if (loading) {
    return (
      <box flexGrow={1} alignItems="center" justifyContent="center">
        <text fg="#888888">Loading logs...</text>
      </box>
    );
  }

  // Interactive sessions use a full TUI, so logs aren't meaningful text
  if (isInteractive) {
    return (
      <box flexGrow={1} alignItems="center" justifyContent="center">
        <text fg="#888888">Logs not available for interactive sessions</text>
      </box>
    );
  }

  if (lines.length === 0) {
    return (
      <box flexGrow={1} alignItems="center" justifyContent="center">
        <text fg="#888888">No logs available</text>
      </box>
    );
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <scrollbox ref={scrollboxRef} flexGrow={1} flexShrink={1}>
        {lines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: log lines are append-only with no stable ID
          <text key={i} wrapMode="word">
            <AnsiText>{line || ' '}</AnsiText>
          </text>
        ))}
      </scrollbox>
      {following && (
        <box position="absolute" bottom={0} right={1}>
          <text fg="#51cf66">[F]</text>
        </box>
      )}
    </box>
  );
}
