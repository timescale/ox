import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useMemo, useRef, useState } from 'react';
import { parseUnifiedDiff } from '../services/diffParser';
import type { ContainerDiffResult } from '../services/docker';
import { useTheme } from '../stores/themeStore';
import { AnsiText } from './AnsiText';

export interface DiffViewerProps {
  diffData: ContainerDiffResult;
  /** Called when the selected file changes (null = all files) */
  onSelectedFileChange?: (filePath: string | null) => void;
}

type DiffTab = 'diff' | 'files' | 'commits';

export function DiffViewer({
  diffData,
  onSelectedFileChange,
}: DiffViewerProps) {
  const { theme } = useTheme();
  const [activeTab, setActiveTab] = useState<DiffTab>('diff');
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);
  const [selectedFileIndex, setSelectedFileIndex] = useState<number | null>(
    null,
  );

  // Parse diff into per-file chunks
  const fileDiffs = useMemo(
    () => parseUnifiedDiff(diffData.diff),
    [diffData.diff],
  );

  // Derive summary counts
  const commitCount = diffData.log
    ? diffData.log.split('\n').filter((l) => l.trim()).length
    : 0;
  const statLines = diffData.stat
    ? diffData.stat.split('\n').filter((l) => l.trim())
    : [];
  // Last line of stat is the summary (e.g. "3 files changed, 10 insertions(+)")
  const fileCount =
    statLines.length > 1 ? statLines.length - 1 : statLines.length;

  const selectFile = (index: number | null) => {
    setSelectedFileIndex(index);
    const path = index !== null ? (fileDiffs[index]?.path ?? null) : null;
    onSelectedFileChange?.(path);
  };

  useKeyboard((key) => {
    // Tab switching
    if (key.raw === '1') {
      setActiveTab('diff');
      scrollboxRef.current?.scrollTo({ x: 0, y: 0 });
    } else if (key.raw === '2') {
      setActiveTab('files');
      scrollboxRef.current?.scrollTo({ x: 0, y: 0 });
    } else if (key.raw === '3') {
      setActiveTab('commits');
      scrollboxRef.current?.scrollTo({ x: 0, y: 0 });
    }

    // File navigation
    if (key.raw === 'n' && fileDiffs.length > 0) {
      const nextIndex =
        selectedFileIndex === null
          ? 0
          : Math.min(selectedFileIndex + 1, fileDiffs.length - 1);
      selectFile(nextIndex);
      setActiveTab('diff');
      scrollboxRef.current?.scrollTo({ x: 0, y: 0 });
    } else if (key.raw === 'p' && fileDiffs.length > 0) {
      const prevIndex =
        selectedFileIndex === null
          ? fileDiffs.length - 1
          : Math.max(selectedFileIndex - 1, 0);
      selectFile(prevIndex);
      setActiveTab('diff');
      scrollboxRef.current?.scrollTo({ x: 0, y: 0 });
    } else if (key.raw === 'a') {
      selectFile(null);
      setActiveTab('diff');
      scrollboxRef.current?.scrollTo({ x: 0, y: 0 });
    }

    // Scrolling
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

  const tabLabel = (tab: DiffTab, label: string) => {
    const isActive = activeTab === tab;
    return (
      <text fg={isActive ? theme.primary : theme.textMuted} wrapMode="none">
        {label}
      </text>
    );
  };

  // Get the diff content to display (filtered by file or full)
  const diffContent =
    selectedFileIndex !== null
      ? fileDiffs[selectedFileIndex]?.diff
      : diffData.diff;

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Agent Summary */}
      {diffData.summary && (
        <box
          flexDirection="column"
          marginBottom={1}
          maxHeight={6}
          overflow="hidden"
        >
          <text fg={theme.text} wrapMode="word">
            {diffData.summary}
          </text>
        </box>
      )}

      {/* Header */}
      <box flexDirection="row" gap={2} height={1} overflow="hidden">
        <text fg={theme.textMuted} wrapMode="none">
          {commitCount} commit{commitCount !== 1 ? 's' : ''}, {fileCount} file
          {fileCount !== 1 ? 's' : ''} changed
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          base: {diffData.baseBranch}
        </text>
      </box>

      {/* Tab bar */}
      <box flexDirection="row" gap={2} height={1} overflow="hidden">
        {tabLabel('diff', '[1] Diff')}
        {tabLabel('files', '[2] Files')}
        {tabLabel('commits', '[3] Commits')}
        {fileDiffs.length > 1 && (
          <text fg={theme.textMuted} wrapMode="none">
            [n]ext [p]rev [a]ll
          </text>
        )}
      </box>

      {/* Content */}
      {activeTab === 'diff' && (
        <box flexDirection="column" flexGrow={1}>
          {/* File indicator when viewing single file */}
          {selectedFileIndex !== null && fileDiffs[selectedFileIndex] && (
            <box height={1} overflow="hidden">
              <text fg={theme.accent} wrapMode="none">
                {fileDiffs[selectedFileIndex].path}
                <span fg={theme.textMuted}>
                  {' '}
                  ({selectedFileIndex + 1}/{fileDiffs.length})
                </span>
              </text>
            </box>
          )}
          {diffContent && diffContent !== '(no diff)' ? (
            <scrollbox
              ref={scrollboxRef}
              flexGrow={1}
              flexShrink={1}
              stickyScroll
              stickyStart="top"
            >
              <diff diff={diffContent} view="unified" showLineNumbers />
            </scrollbox>
          ) : (
            <box flexGrow={1} alignItems="center" justifyContent="center">
              <text fg={theme.textMuted}>No changes found</text>
            </box>
          )}
        </box>
      )}

      {activeTab === 'files' && (
        <scrollbox
          ref={scrollboxRef}
          flexGrow={1}
          flexShrink={1}
          stickyScroll
          stickyStart="top"
        >
          {fileDiffs.length > 0 ? (
            <>
              {fileDiffs.map((file, i) => {
                const isSelected = i === selectedFileIndex;
                // Find the stat line for this file
                const statLine = statLines.find((l) => l.includes(file.path));
                const statSuffix = statLine
                  ? statLine.replace(file.path, '').trim()
                  : '';
                return (
                  <box
                    key={file.path}
                    height={1}
                    flexDirection="row"
                    backgroundColor={
                      isSelected ? theme.backgroundElement : undefined
                    }
                    onMouseDown={() => {
                      selectFile(i);
                      setActiveTab('diff');
                    }}
                  >
                    <text
                      fg={isSelected ? theme.accent : theme.text}
                      wrapMode="none"
                    >
                      {isSelected ? '> ' : '  '}
                      {file.path}
                    </text>
                    {statSuffix && (
                      <text fg={theme.textMuted} wrapMode="none">
                        {'  '}
                        <AnsiText>{statSuffix}</AnsiText>
                      </text>
                    )}
                  </box>
                );
              })}
              {/* Summary stat line at bottom */}
              {(() => {
                const summaryLine = statLines[statLines.length - 1];
                return statLines.length > 1 && summaryLine ? (
                  <box marginTop={1}>
                    <text fg={theme.textMuted} wrapMode="word">
                      <AnsiText>{summaryLine}</AnsiText>
                    </text>
                  </box>
                ) : null;
              })()}
            </>
          ) : (
            <text fg={theme.textMuted}>No file changes</text>
          )}
        </scrollbox>
      )}

      {activeTab === 'commits' && (
        <scrollbox
          ref={scrollboxRef}
          flexGrow={1}
          flexShrink={1}
          stickyScroll
          stickyStart="top"
        >
          {diffData.log && diffData.log !== '(no commits)' ? (
            diffData.log
              .split('\n')
              .filter((l) => l.trim())
              .map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: log lines are static
                <text key={i} wrapMode="word">
                  <AnsiText>{line}</AnsiText>
                </text>
              ))
          ) : (
            <text fg={theme.textMuted}>No commits</text>
          )}
        </scrollbox>
      )}
    </box>
  );
}
