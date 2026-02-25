import type { ScrollBoxRenderable } from '@opentui/core';
import { flushSync, useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCommandStore, useRegisterCommands } from '../services/commands.tsx';
import { log } from '../services/logger.ts';
import {
  deleteResource,
  getCleanupTargets,
  groupResourcesByKind,
  listAllResources,
  type SandboxResource,
} from '../services/sandbox/resources.ts';
import { formatSize } from '../services/sessionDisplay.ts';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore.ts';
import { useTheme } from '../stores/themeStore.ts';
import { useToastStore } from '../stores/toastStore.ts';
import { ConfirmModal } from './ConfirmModal.tsx';
import { Frame } from './Frame.tsx';
import { HotkeysBar } from './HotkeysBar.tsx';

// ============================================================================
// Types
// ============================================================================

export interface ResourcesListProps {
  onBack: () => void;
}

type FilterMode = 'all' | 'snapshot' | 'volume' | 'image';

type ConfirmAction =
  | { type: 'delete'; resource: SandboxResource }
  | { type: 'cleanup'; targets: SandboxResource[] };

// ============================================================================
// Constants
// ============================================================================

const FILTER_LABELS: Record<FilterMode, string> = {
  all: 'All',
  snapshot: 'Snapshots',
  volume: 'Volumes',
  image: 'Images',
};

const FILTER_ORDER: FilterMode[] = ['all', 'snapshot', 'volume', 'image'];

// ============================================================================
// Helpers
// ============================================================================

function statusIcon(status: SandboxResource['status']): string {
  switch (status) {
    case 'current':
    case 'active':
      return '\u25CF'; // ●
    case 'old':
      return '\u25CB'; // ○
    case 'orphaned':
      return '\u25CC'; // ◌
  }
}

function statusLabel(status: SandboxResource['status']): string {
  switch (status) {
    case 'current':
      return 'cur';
    case 'active':
      return 'act';
    case 'old':
      return 'old';
    case 'orphaned':
      return 'orph';
  }
}

// ============================================================================
// Component
// ============================================================================

export function ResourcesList({ onBack }: ResourcesListProps) {
  const { theme } = useTheme();

  const [resources, setResources] = useState<SandboxResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(
    () => new Set(),
  );
  const pendingDeletesRef = useRef(pendingDeletes);
  pendingDeletesRef.current = pendingDeletes;
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(
    null,
  );
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);

  // Filter resources by kind
  const filteredResources = useMemo(() => {
    if (filterMode === 'all') return resources;
    return resources.filter((r) => r.kind === filterMode);
  }, [resources, filterMode]);

  // Cleanup targets summary
  const cleanupTargets = useMemo(
    () => getCleanupTargets(resources),
    [resources],
  );

  // Load resources — reads pendingDeletes via ref to avoid re-creating
  // the callback (and resetting the auto-refresh timer) on every delete.
  const loadResources = useCallback(async () => {
    try {
      const loaded = await listAllResources();
      const pending = pendingDeletesRef.current;
      setResources(loaded.filter((r) => !pending.has(r.id)));
      setLoading(false);
    } catch (err) {
      log.error({ err }, 'Failed to load resources');
      useToastStore
        .getState()
        .show(`Failed to load resources: ${err}`, 'error');
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadResources();
  }, [loadResources]);

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const interval = setInterval(loadResources, 60000);
    return () => clearInterval(interval);
  }, [loadResources]);

  // Keep selected index in bounds
  useEffect(() => {
    if (
      filteredResources.length > 0 &&
      selectedIndex >= filteredResources.length
    ) {
      setSelectedIndex(Math.max(0, filteredResources.length - 1));
    }
  }, [filteredResources.length, selectedIndex]);

  // Scroll to keep selection visible
  const scrollToIndex = useCallback((index: number) => {
    if (scrollboxRef.current) {
      const viewportHeight = scrollboxRef.current.viewport?.height ?? 10;
      const itemY = index;
      const targetScrollY = Math.max(0, itemY - Math.floor(viewportHeight / 2));
      scrollboxRef.current.scrollTo({ x: 0, y: targetScrollY });
    }
  }, []);

  // Mouse handlers
  const handleRowClick = useCallback((index: number) => {
    setSelectedIndex(index);
  }, []);

  const handleRowHover = useCallback((index: number) => {
    setHoveredIndex(index);
  }, []);

  const handleMouseOut = useCallback(() => {
    setHoveredIndex(null);
  }, []);

  // Add a resource ID to pending deletes
  const addPendingDelete = useCallback((id: string) => {
    setPendingDeletes((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  // Remove a resource ID from pending deletes
  const removePendingDelete = useCallback((id: string) => {
    setPendingDeletes((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Delete a single resource (optimistic)
  const handleDeleteConfirm = useCallback(() => {
    if (!confirmAction || confirmAction.type !== 'delete') return;
    const resource = confirmAction.resource;

    // Determine next selection
    const deleteIndex = filteredResources.findIndex(
      (r) => r.id === resource.id,
    );
    const nextIndex =
      deleteIndex + 1 < filteredResources.length
        ? deleteIndex
        : Math.max(0, deleteIndex - 1);

    setConfirmAction(null);

    // Optimistic hide
    addPendingDelete(resource.id);
    setResources((prev) => prev.filter((r) => r.id !== resource.id));
    setSelectedIndex(nextIndex);

    useToastStore.getState().show('Resource deleted', 'success');

    // Enqueue background deletion
    useBackgroundTaskStore
      .getState()
      .enqueue(`Deleting "${resource.name}"`, async () => {
        try {
          await deleteResource(resource);
        } catch (err) {
          log.error(
            { err, id: resource.id, name: resource.name },
            'Background delete failed',
          );
          throw err;
        } finally {
          removePendingDelete(resource.id);
        }
      });
  }, [confirmAction, filteredResources, addPendingDelete, removePendingDelete]);

  // Cleanup all old+orphaned resources with dependency ordering.
  // Resources are grouped by kind (snapshots → volumes → images).
  // Within each group, deletions run in parallel as individual tasks.
  // Groups are sequenced so snapshots complete before volumes start.
  const handleCleanupConfirm = useCallback(() => {
    if (!confirmAction || confirmAction.type !== 'cleanup') return;
    const targets = confirmAction.targets;

    setConfirmAction(null);

    // Optimistic hide all targets
    const targetIds = new Set(targets.map((t) => t.id));
    for (const id of targetIds) {
      addPendingDelete(id);
    }
    setResources((prev) => prev.filter((r) => !targetIds.has(r.id)));
    setSelectedIndex(0);

    const groups = groupResourcesByKind(targets);
    const totalCount = targets.length;
    const groupCount = groups.length;

    log.info(
      {
        totalCount,
        groupCount,
        groups: groups.map((g) => ({ kind: g[0]?.kind, count: g.length })),
      },
      'Starting resource cleanup',
    );
    useToastStore
      .getState()
      .show(`Cleaning up ${totalCount} resources...`, 'info');

    // Process groups sequentially; within each group, enqueue individual tasks
    // and wait for the whole group to finish before starting the next one.
    const processGroups = async () => {
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        if (!group || group.length === 0) continue;

        const kind = group[0]?.kind ?? 'unknown';
        log.info(
          { kind, count: group.length, groupIndex: i + 1, groupCount },
          'Processing cleanup group',
        );

        // Enqueue all resources in this group as individual tasks
        const taskPromises = group.map((target) => {
          return new Promise<void>((resolve) => {
            useBackgroundTaskStore
              .getState()
              .enqueue(`Deleting ${target.kind} "${target.name}"`, async () => {
                try {
                  await deleteResource(target);
                } catch (err) {
                  log.error(
                    {
                      err,
                      id: target.id,
                      name: target.name,
                      kind: target.kind,
                    },
                    'Cleanup: failed to delete resource',
                  );
                  throw err;
                } finally {
                  removePendingDelete(target.id);
                  resolve();
                }
              });
          });
        });

        // Wait for all tasks in this group to settle before starting next group
        await Promise.allSettled(taskPromises);
        log.info({ kind, groupIndex: i + 1 }, 'Cleanup group complete');
      }

      log.info({ totalCount }, 'Resource cleanup finished');
    };

    processGroups();
  }, [confirmAction, addPendingDelete, removePendingDelete]);

  // Suspend command keybind dispatch when modal is open
  const suspend = useCommandStore((s) => s.suspend);
  const isOpen = useCommandStore((s) => s.isOpen);
  useEffect(() => {
    if (confirmAction) {
      return suspend();
    }
  }, [confirmAction, suspend]);

  // Helper to get the currently selected resource
  const getSelectedResource = () => filteredResources[selectedIndex];

  // Register commands for the command palette
  useRegisterCommands(() => {
    const selected = getSelectedResource();

    return [
      {
        id: 'resources.delete',
        title: 'Delete selected resource',
        description: 'Remove the selected resource permanently',
        category: 'Resources',
        keybind: [
          { key: 'delete', display: 'delete' },
          { key: 'backspace', display: 'backspace' },
          { key: 'd', ctrl: true },
        ],
        enabled: !!selected,
        onSelect: () => {
          const r = getSelectedResource();
          if (r) setConfirmAction({ type: 'delete', resource: r });
        },
      },
      {
        id: 'resources.cleanup',
        title: 'Cleanup old & orphaned resources',
        description: `Delete all old and orphaned resources (${cleanupTargets.length} targets)`,
        category: 'Resources',
        keybind: { key: 'x', ctrl: true },
        enabled: cleanupTargets.length > 0,
        onSelect: () => {
          if (cleanupTargets.length > 0) {
            setConfirmAction({ type: 'cleanup', targets: cleanupTargets });
          }
        },
      },
      {
        id: 'resources.filter',
        title: 'Cycle filter',
        description: 'Cycle between All, Snapshots, Volumes, and Images',
        category: 'View',
        keybind: { key: 'tab', display: 'tab' },
        onSelect: () => {
          const currentIdx = FILTER_ORDER.indexOf(filterMode);
          const nextIdx = (currentIdx + 1) % FILTER_ORDER.length;
          const nextMode = FILTER_ORDER[nextIdx];
          if (nextMode) setFilterMode(nextMode);
        },
      },
      {
        id: 'resources.refresh',
        title: 'Refresh resources',
        description: 'Reload the resource list',
        category: 'Resources',
        keybind: { key: 'f2', display: 'f2' },
        onSelect: () => {
          setLoading(true);
          loadResources().then(() => {
            useToastStore.getState().show('Refreshed', 'info');
          });
        },
      },
      {
        id: 'resources.back',
        title: 'Go back',
        description: 'Return to the previous screen',
        category: 'Navigation',
        keybind: { key: 'escape', display: 'esc' },
        hidden: true,
        onSelect: () => {
          if (!isOpen) onBack();
        },
      },
    ];
  }, [
    filterMode,
    cleanupTargets,
    loadResources,
    filteredResources,
    selectedIndex,
    isOpen,
    onBack,
  ]);

  // Keyboard handling — navigation keys only
  useKeyboard((key) => {
    // Ignore keyboard input when modal is open
    if (confirmAction) return;

    // Escape returns to previous screen (but not if command palette is open)
    if (key.name === 'escape') {
      if (!isOpen) onBack();
      return;
    }

    // Don't navigate when the command palette is open
    if (isOpen) return;

    if (key.name === 'up' || (key.name === 'k' && key.ctrl)) {
      const newIndex = Math.max(0, selectedIndex - 1);
      flushSync(() => setSelectedIndex(newIndex));
      scrollToIndex(newIndex);
      return;
    }

    if (
      key.name === 'down' ||
      (key.name === 'j' && key.ctrl) ||
      key.name === 'linefeed'
    ) {
      const newIndex = Math.min(
        filteredResources.length - 1,
        selectedIndex + 1,
      );
      flushSync(() => setSelectedIndex(newIndex));
      scrollToIndex(newIndex);
      return;
    }
  });

  // Loading state
  if (loading && resources.length === 0) {
    return (
      <Frame title="Resources" centered>
        <text fg={theme.textMuted}>Loading resources...</text>
      </Frame>
    );
  }

  const filterLabel = FILTER_LABELS[filterMode];
  const countText = `${filteredResources.length} of ${resources.length}`;
  const cleanupCount = cleanupTargets.length;

  // Status color helper
  const getStatusColor = (status: SandboxResource['status']): string => {
    switch (status) {
      case 'current':
        return theme.success;
      case 'active':
        return theme.accent;
      case 'old':
        return theme.warning;
      case 'orphaned':
        return theme.error;
    }
  };

  return (
    <Frame title="Resources">
      {/* Filter bar */}
      <box height={1} marginBottom={1} flexDirection="row">
        <text height={1}>
          Filter: <span fg={theme.primary}>{filterLabel}</span>
        </text>
        <text height={1} flexGrow={1} />
        <text height={1} fg={theme.textMuted}>
          [{filterLabel}] {countText}
          {cleanupCount > 0 ? ` | ${cleanupCount} cleanable` : ''}
        </text>
      </box>

      {/* Column headers */}
      <box
        height={1}
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        gap={2}
      >
        <text height={1} width={3} fg={theme.textMuted} />
        <text height={1} width={6} fg={theme.textMuted}>
          STATUS
        </text>
        <text height={1} width={8} fg={theme.textMuted}>
          PROVIDER
        </text>
        <text height={1} flexGrow={1} flexBasis={0} fg={theme.textMuted}>
          CATEGORY
        </text>
        <text height={1} flexGrow={2} flexBasis={0} fg={theme.textMuted}>
          NAME
        </text>
        <text height={1} width={6} fg={theme.textMuted}>
          SIZE
        </text>
      </box>

      {/* Resource list */}
      {filteredResources.length === 0 ? (
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>
            {resources.length === 0
              ? 'No resources found.'
              : 'No resources match the current filter.'}
          </text>
        </box>
      ) : (
        <scrollbox
          ref={scrollboxRef}
          flexGrow={1}
          flexShrink={1}
          onMouseOut={handleMouseOut}
        >
          {filteredResources.map((resource, index) => {
            const isSelected = index === selectedIndex;
            const isHovered = index === hoveredIndex;
            const stColor = getStatusColor(resource.status);

            const bgColor = isSelected
              ? theme.primary
              : isHovered
                ? theme.backgroundElement
                : undefined;
            const itemFg = isSelected ? theme.background : theme.text;
            const itemFgMuted = isSelected
              ? theme.backgroundElement
              : theme.textMuted;

            const providerLabel =
              resource.provider === 'cloud' ? 'Cloud' : 'Docker';
            const providerColor =
              resource.provider === 'cloud' ? theme.accent : theme.textMuted;

            return (
              <box
                key={resource.id}
                height={1}
                flexDirection="row"
                backgroundColor={bgColor}
                paddingLeft={1}
                paddingRight={1}
                gap={2}
                onMouseDown={() => handleRowClick(index)}
                onMouseOver={() => handleRowHover(index)}
              >
                <text height={1} width={3} fg={isSelected ? itemFg : stColor}>
                  {statusIcon(resource.status)}
                </text>
                <text height={1} width={6} fg={itemFgMuted}>
                  {statusLabel(resource.status)}
                </text>
                <text
                  height={1}
                  width={8}
                  fg={isSelected ? itemFg : providerColor}
                >
                  {providerLabel}
                </text>
                <text height={1} flexGrow={1} flexBasis={0} fg={itemFgMuted}>
                  {resource.category}
                </text>
                <text
                  height={1}
                  flexGrow={2}
                  flexBasis={0}
                  fg={itemFg}
                  overflow="hidden"
                  wrapMode="none"
                >
                  {resource.name}
                </text>
                <text height={1} width={6} fg={itemFgMuted}>
                  {formatSize(resource.size)}
                </text>
              </box>
            );
          })}
        </scrollbox>
      )}

      <HotkeysBar
        keyList={[
          ['ctrl+d', 'delete'],
          ['ctrl+x', 'cleanup'],
          ['tab', 'filter'],
          ['f2', 'refresh'],
          ['esc', 'back'],
          ['ctrl+p', 'commands'],
        ]}
      />

      {/* Delete confirmation modal */}
      {confirmAction?.type === 'delete' && (
        <ConfirmModal
          title="Delete Resource"
          message={`Delete "${confirmAction.resource.name}"?`}
          detail="This cannot be undone."
          confirmLabel="Delete"
          confirmColor={theme.error}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {/* Cleanup confirmation modal */}
      {confirmAction?.type === 'cleanup' && (
        <ConfirmModal
          title="Cleanup Resources"
          message={`Delete ${confirmAction.targets.length} old and orphaned resources?`}
          detail="This will remove all old and orphaned snapshots, volumes, and images. This cannot be undone."
          confirmLabel="Delete All"
          confirmColor={theme.error}
          onConfirm={handleCleanupConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </Frame>
  );
}
