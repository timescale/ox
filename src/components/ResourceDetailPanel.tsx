import { useMemo } from 'react';
import { useWindowSize } from '../hooks/useWindowSize.ts';
import { useCommandStore } from '../services/commands.tsx';
import type { SandboxResource } from '../services/sandbox/resources.ts';
import { formatSize } from '../services/sessionDisplay.ts';
import { useRouterStore } from '../stores/routerStore.ts';
import { useTheme } from '../stores/themeStore.ts';
import { ActionButton } from './ActionButton.tsx';

export interface ResourceDetailPanelProps {
  resource: SandboxResource;
  allResources: SandboxResource[];
  onDelete: (resource: SandboxResource) => void;
  cleanupCount: number;
  onCleanup: () => void;
}

function statusLabel(status: SandboxResource['status']): string {
  switch (status) {
    case 'current':
      return 'current';
    case 'active':
      return 'active';
    case 'old':
      return 'old';
    case 'orphaned':
      return 'orphaned';
  }
}

export function ResourceDetailPanel({
  resource,
  allResources,
  onDelete,
  cleanupCount,
  onCleanup,
}: ResourceDetailPanelProps) {
  const { theme } = useTheme();
  const { isWide } = useWindowSize();
  const showCommands = useCommandStore((s) => s.show);

  const statusColor = useMemo(() => {
    switch (resource.status) {
      case 'current':
        return theme.success;
      case 'active':
        return theme.accent;
      case 'old':
        return theme.warning;
      case 'orphaned':
        return theme.error;
    }
  }, [resource.status, theme]);

  // For snapshots: find the parent volume by sourceVolumeSlug
  const parentVolume = useMemo(() => {
    if (resource.kind !== 'snapshot' || !resource.sourceVolumeSlug) return null;
    return (
      allResources.find(
        (r) => r.kind === 'volume' && r.name === resource.sourceVolumeSlug,
      ) ?? null
    );
  }, [resource, allResources]);

  // For volumes: find child snapshots by childSnapshotSlugs
  const childSnapshots = useMemo(() => {
    if (resource.kind !== 'volume' || !resource.childSnapshotSlugs?.length) {
      return [];
    }
    const slugSet = new Set(resource.childSnapshotSlugs);
    return allResources.filter(
      (r) => r.kind === 'snapshot' && slugSet.has(r.name),
    );
  }, [resource, allResources]);

  const providerLabel = resource.provider === 'cloud' ? 'cloud' : 'docker';
  const providerColor =
    resource.provider === 'cloud' ? theme.accent : theme.text;

  return (
    <>
      {/* Row 1: Name + size */}
      <box flexDirection="row" gap={1} overflow="hidden">
        <box flexDirection="row" gap={1}>
          <text wrapMode="none" fg={theme.textMuted}>
            name
          </text>
          <text wrapMode="none">{resource.name}</text>
        </box>
        {resource.size != null && (
          <box
            flexDirection="row"
            gap={1}
            flexGrow={1}
            justifyContent="flex-end"
          >
            <text fg={theme.textMuted}>size</text>
            <text>{formatSize(resource.size)}</text>
          </box>
        )}
      </box>

      {/* Row 2: Kind + category + provider */}
      <box
        flexDirection="row"
        columnGap={isWide ? 3 : 2}
        overflow="hidden"
        flexWrap="wrap"
      >
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>kind</text>
          <text>{resource.kind}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>category</text>
          <text>{resource.category}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>provider</text>
          <text fg={providerColor}>{providerLabel}</text>
        </box>
      </box>

      {/* Row 3: Status + optional region/session/created */}
      <box
        flexDirection="row"
        columnGap={isWide ? 3 : 2}
        overflow="hidden"
        flexWrap="wrap"
      >
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>status</text>
          <text fg={statusColor}>{statusLabel(resource.status)}</text>
        </box>
        {resource.region && (
          <box flexDirection="row" gap={1}>
            <text fg={theme.textMuted}>region</text>
            <text>{resource.region}</text>
          </box>
        )}
        {resource.sessionName && (
          <box flexDirection="row" gap={1}>
            <text fg={theme.textMuted}>session</text>
            <text>{resource.sessionName}</text>
          </box>
        )}
        {resource.createdAt && (
          <box
            flexDirection="row"
            gap={1}
            flexGrow={1}
            justifyContent="flex-end"
          >
            <text fg={theme.textMuted}>created</text>
            <text>{resource.createdAt}</text>
          </box>
        )}
      </box>

      {/* Row 4 (optional): Relationship info */}
      {parentVolume && (
        <box flexDirection="row" gap={1} overflow="hidden">
          <text fg={theme.textMuted}>volume</text>
          <text>{parentVolume.name}</text>
          <text fg={theme.textMuted}>({parentVolume.status})</text>
        </box>
      )}
      {resource.sourceVolumeSlug && !parentVolume && (
        <box flexDirection="row" gap={1} overflow="hidden">
          <text fg={theme.textMuted}>volume</text>
          <text fg={theme.textMuted}>{resource.sourceVolumeSlug}</text>
          <text fg={theme.textMuted}>(not found)</text>
        </box>
      )}
      {childSnapshots.length > 0 && (
        <box flexDirection="row" gap={1} overflow="hidden">
          <text fg={theme.textMuted}>
            {childSnapshots.length === 1 ? 'snapshot' : 'snapshots'}
          </text>
          <text>{childSnapshots.map((s) => s.name).join(', ')}</text>
        </box>
      )}

      {/* Action buttons */}
      <box
        flexDirection="row-reverse"
        flexWrap="wrap"
        columnGap={1}
        marginTop={1}
      >
        <ActionButton
          label="delete"
          keybind="^d"
          color={theme.error}
          onPress={() => onDelete(resource)}
        />
        {cleanupCount > 0 && (
          <ActionButton
            label={`cleanup (${cleanupCount})`}
            keybind="^x"
            color={theme.warning}
            onPress={onCleanup}
          />
        )}
        <box flexGrow={1} height={0} />
        <ActionButton
          label="back"
          color={theme.textMuted}
          onPress={() => useRouterStore.getState().goToList()}
        />
        <ActionButton
          label="commands"
          keybind="^p"
          color={theme.text}
          onPress={showCommands}
        />
      </box>
    </>
  );
}
