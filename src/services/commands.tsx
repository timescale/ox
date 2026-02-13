// ============================================================================
// Command Palette — Zustand store, host component, and palette UI
// ============================================================================

import { RGBA, TextAttributes } from '@opentui/core';
import { flushSync, useKeyboard } from '@opentui/react';
import fuzzysort from 'fuzzysort';
import { type DependencyList, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useTheme } from '../stores/themeStore.ts';
import { log } from './logger';

// Lines per command item in the palette (single line per item)
const LINES_PER_ITEM = 1;

// ============================================================================
// Types
// ============================================================================

/** Keybind definition for matching keyboard events and display. */
export interface KeybindDef {
  /** Key name (e.g. 'n', 's', 'l') */
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  /** Override the display string (e.g. "ctrl+n"). Auto-generated if omitted. */
  display?: string;
}

/** A command that can appear in the palette and/or respond to a keybind. */
export interface Command {
  /** Unique identifier, e.g. "session.attach" */
  id: string;
  /** Display name shown in the palette list */
  title: string;
  /** Longer description shown at the bottom of the palette when highlighted */
  description?: string;
  /** Grouping label (e.g. "Session", "System") */
  category?: string;
  /**
   * Keybind(s) for both dispatch and display hint.
   * Can be a single KeybindDef or an array. When an array, all bindings
   * trigger the command but only the first is displayed in the palette.
   */
  keybind?: KeybindDef | KeybindDef[];
  /** If true, responds to keybind but is hidden from the palette list */
  hidden?: boolean;
  /** If false, the command is completely disabled (keybind + palette) */
  enabled?: boolean;
  /** Action handler */
  onSelect: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

/** Convert a KeybindDef to a human-readable string like "ctrl+n". */
export function keybindDisplay(def: KeybindDef): string {
  if (def.display) return def.display;
  const parts: string[] = [];
  if (def.ctrl) parts.push('ctrl');
  if (def.meta) parts.push('meta');
  if (def.shift) parts.push('shift');
  parts.push(def.key);
  return parts.join('+');
}

/**
 * Test whether a keyboard event matches a single KeybindDef.
 * The `key` parameter should be the opentui KeyEvent from useKeyboard.
 */
export function keybindMatch(
  def: KeybindDef,
  key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean },
): boolean {
  if (key.name !== def.key) return false;
  if (!!key.ctrl !== !!def.ctrl) return false;
  if (!!key.meta !== !!def.meta) return false;
  if (!!key.shift !== !!def.shift) return false;
  return true;
}

/**
 * Test whether a keyboard event matches any of a command's keybind(s).
 */
function commandKeybindMatch(
  keybind: KeybindDef | KeybindDef[],
  key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean },
): boolean {
  const defs = Array.isArray(keybind) ? keybind : [keybind];
  return defs.some((def) => keybindMatch(def, key));
}

/**
 * Get the display keybind for a command (first in the array if multiple).
 */
function commandKeybindDisplayDef(
  keybind: KeybindDef | KeybindDef[],
): KeybindDef | undefined {
  return Array.isArray(keybind) ? keybind[0] : keybind;
}

// ============================================================================
// Zustand Store
// ============================================================================

interface Registration {
  commands: Command[];
}

let nextRegistrationId = 0;

interface CommandState {
  /** Map of registration ID -> commands */
  registrations: Map<number, Registration>;

  /** Whether the command palette modal is open */
  isOpen: boolean;

  /** Suspend counter — when > 0, keybind dispatch is paused */
  suspendCount: number;

  /**
   * Register a set of commands. Returns a cleanup function that
   * unregisters them (designed for use as a useEffect return value).
   */
  register: (commands: Command[]) => () => void;

  /** Open the command palette */
  show: () => void;

  /** Close the command palette */
  hide: () => void;

  /**
   * Suspend keybind dispatch (e.g. when a sub-modal is open).
   * Returns a resume function.
   */
  suspend: () => () => void;
}

export const useCommandStore = create<CommandState>()((set) => ({
  registrations: new Map(),
  isOpen: false,
  suspendCount: 0,

  register: (commands) => {
    const id = nextRegistrationId++;
    set((state) => {
      const next = new Map(state.registrations);
      next.set(id, { commands });
      return { registrations: next };
    });
    return () => {
      set((state) => {
        const next = new Map(state.registrations);
        next.delete(id);
        return { registrations: next };
      });
    };
  },

  show: () => set({ isOpen: true }),
  hide: () => set({ isOpen: false }),

  suspend: () => {
    set((state) => ({ suspendCount: state.suspendCount + 1 }));
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      set((state) => ({
        suspendCount: Math.max(0, state.suspendCount - 1),
      }));
    };
  },
}));

// ============================================================================
// Convenience hook
// ============================================================================

/**
 * Register commands for the current component's lifetime.
 * Re-registers when deps change (providing fresh closures).
 *
 * @param commandsFn Factory that returns the Command array (called on every dep change)
 * @param deps Dependency list — re-registers when any dep changes
 */
export function useRegisterCommands(
  commandsFn: () => Command[],
  deps: DependencyList,
): void {
  const register = useCommandStore((s) => s.register);
  // Store the factory in a ref so useEffect doesn't re-fire on every render
  const fnRef = useRef(commandsFn);
  fnRef.current = commandsFn;
  useEffect(() => {
    return register(fnRef.current());
    // Re-register when any dep changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, ...deps]);
}

/** Get all currently registered commands (flattened, in registration order). */
function getAllCommands(registrations: Map<number, Registration>): Command[] {
  const result: Command[] = [];
  for (const reg of registrations.values()) {
    for (const cmd of reg.commands) {
      result.push(cmd);
    }
  }
  return result;
}

/** Get visible commands (not hidden, enabled). */
function getVisibleCommands(all: Command[]): Command[] {
  return all.filter((cmd) => !cmd.hidden && cmd.enabled !== false);
}

/**
 * Scroll to ensure the given item is visible in a scrollbox.
 * Uses ensure-visible logic rather than centering, so the list doesn't
 * jump around unnecessarily.
 *
 * @param itemY The Y offset of the item within the scrollbox content area
 */
function scrollToItem(
  scrollbox: import('@opentui/core').ScrollBoxRenderable | null,
  itemY: number,
) {
  if (!scrollbox) return;
  const viewportHeight = scrollbox.viewport?.height ?? 20;
  const currentScroll = scrollbox.scrollTop;

  // If the item is above the viewport, scroll up to show it at the top
  if (itemY < currentScroll) {
    scrollbox.scrollTo({ x: 0, y: itemY });
    return;
  }

  // If the item is below the viewport, scroll down to show it at the bottom
  const itemBottom = itemY + LINES_PER_ITEM;
  if (itemBottom > currentScroll + viewportHeight) {
    scrollbox.scrollTo({ x: 0, y: itemBottom - viewportHeight });
    return;
  }
  // Otherwise the item is already visible, don't scroll
}

/**
 * Compute the Y offset of each item in the grouped list,
 * accounting for category headers and their padding.
 */
function computeItemOffsets(grouped: [string, Command[]][]): number[] {
  const offsets: number[] = [];
  let y = 0;
  let groupIndex = 0;
  for (const [category, cmds] of grouped) {
    if (category !== '') {
      // Category header: paddingTop is 1 for all groups except the first
      if (groupIndex > 0) y += 1;
      // The header text itself is 1 line
      y += 1;
    }
    for (const _cmd of cmds) {
      offsets.push(y);
      y += LINES_PER_ITEM;
    }
    groupIndex++;
  }
  return offsets;
}

// ============================================================================
// CommandPaletteHost — place once in the component tree
// ============================================================================

/**
 * Renders the command palette modal when open, and intercepts keybinds
 * globally. Place this component once, wrapping or alongside your main
 * app content.
 */
export function CommandPaletteHost() {
  const { isOpen, show, hide, suspendCount, registrations } = useCommandStore();

  useKeyboard((key) => {
    log.trace({ key }, 'Key pressed');

    // ctrl+p toggles the palette (but don't open it when suspended, e.g. another modal is open)
    if (key.name === 'p' && key.ctrl) {
      if (isOpen) {
        hide();
      } else if (suspendCount === 0) {
        show();
      }
      return;
    }

    // Don't dispatch keybinds when suspended or palette is open
    if (suspendCount > 0 || isOpen) return;

    // Dispatch keybinds to registered commands
    const all = getAllCommands(registrations);
    for (const cmd of all) {
      if (cmd.enabled === false) continue;
      if (!cmd.keybind) continue;
      if (commandKeybindMatch(cmd.keybind, key)) {
        cmd.onSelect();
        return;
      }
    }
  });

  if (!isOpen) return null;
  return <CommandPalette />;
}

// ============================================================================
// CommandPalette — the modal UI
// ============================================================================

function CommandPalette() {
  const { theme } = useTheme();
  const { registrations, hide } = useCommandStore();
  const [filter, setFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const scrollboxRef =
    useRef<import('@opentui/core').ScrollBoxRenderable>(null);

  // Gather visible commands
  const allCommands = getAllCommands(registrations);
  const visibleCommands = getVisibleCommands(allCommands);

  // Filter via fuzzysort when there's a search query
  const filtered: Command[] = (() => {
    if (!filter) return visibleCommands;
    const results = fuzzysort.go(filter, visibleCommands, {
      keys: ['title', 'category'],
      scoreFn: (r) => {
        const titleScore = r[0]?.score ?? 0;
        const categoryScore = r[1]?.score ?? 0;
        return titleScore * 2 + categoryScore;
      },
    });
    return results.map((r) => r.obj);
  })();

  // Group by category (preserve order within groups)
  const grouped: [string, Command[]][] = (() => {
    if (filter) {
      // When searching, show flat list (no grouping)
      return [['', filtered]];
    }
    const groups = new Map<string, Command[]>();
    for (const cmd of filtered) {
      const cat = cmd.category ?? '';
      const arr = groups.get(cat);
      if (arr) {
        arr.push(cmd);
      } else {
        groups.set(cat, [cmd]);
      }
    }
    return [...groups.entries()];
  })();

  // Flat list for index-based navigation
  const flat = grouped.flatMap(([, cmds]) => cmds);

  // Compute Y offsets for each item (accounts for category headers)
  const itemOffsets = computeItemOffsets(grouped);

  // Clamp selected index
  const clampedIndex = Math.min(selectedIndex, Math.max(0, flat.length - 1));
  const highlightedCommand = flat[clampedIndex];

  // Reset selection when filter changes
  const lastFilterRef = useRef(filter);
  if (filter !== lastFilterRef.current) {
    lastFilterRef.current = filter;
    if (selectedIndex !== 0) {
      setSelectedIndex(0);
    }
  }

  // Keyboard handling for the palette
  useKeyboard((key) => {
    if (key.name === 'escape') {
      hide();
      return;
    }

    if (key.name === 'up') {
      const newIndex = Math.max(0, clampedIndex - 1);
      flushSync(() => setSelectedIndex(newIndex));
      scrollToItem(scrollboxRef.current, itemOffsets[newIndex] ?? newIndex);
      return;
    }

    if (key.name === 'down') {
      const newIndex = Math.min(flat.length - 1, clampedIndex + 1);
      flushSync(() => setSelectedIndex(newIndex));
      scrollToItem(scrollboxRef.current, itemOffsets[newIndex] ?? newIndex);
      return;
    }

    if (key.name === 'return' && flat.length > 0) {
      const cmd = flat[clampedIndex];
      if (cmd) {
        hide();
        cmd.onSelect();
      }
      return;
    }
  });

  const handleFilterInput = (value: string) => {
    setFilter(value);
    setSelectedIndex(0);
    scrollboxRef.current?.scrollTo({ x: 0, y: 0 });
  };

  const handleItemClick = (cmd: Command) => {
    hide();
    cmd.onSelect();
  };

  // Calculate the height for the scrollable area using item offsets
  const lastOffset = itemOffsets[itemOffsets.length - 1];
  const contentHeight =
    lastOffset !== undefined ? lastOffset + LINES_PER_ITEM : 0;

  // Track the running index across groups for highlighting
  let runningIndex = 0;

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
        flexDirection="column"
        minWidth={50}
        maxWidth={70}
        maxHeight="90%"
        backgroundColor={theme.backgroundPanel}
        padding={1}
      >
        {/* Title bar */}
        <box
          marginLeft={2}
          marginRight={2}
          marginBottom={1}
          flexDirection="row"
        >
          <text flexGrow={1} attributes={TextAttributes.BOLD} fg={theme.text}>
            Commands
          </text>
          <text fg={theme.textMuted}>esc</text>
        </box>

        {/* Search input */}
        <box marginLeft={2} marginRight={2} marginBottom={1}>
          <input
            focused
            value={filter}
            placeholder="Search"
            onInput={handleFilterInput}
            flexGrow={1}
            backgroundColor={theme.backgroundElement}
            textColor={theme.text}
          />
        </box>

        {/* Command list */}
        {flat.length > 0 ? (
          <scrollbox
            ref={scrollboxRef}
            flexShrink={1}
            flexGrow={1}
            maxHeight={contentHeight}
          >
            {grouped.map(([category, cmds]) => {
              const startIndex = runningIndex;
              runningIndex += cmds.length;
              return (
                <box key={category || '__uncategorized'} flexDirection="column">
                  {/* Category header */}
                  {category !== '' && (
                    <box paddingTop={startIndex > 0 ? 1 : 0} paddingLeft={3}>
                      <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                        {category}
                      </text>
                    </box>
                  )}
                  {/* Command items */}
                  {cmds.map((cmd) => {
                    const itemIndex = flat.indexOf(cmd);
                    const isSelected = itemIndex === clampedIndex;
                    const bgColor = isSelected
                      ? theme.primary
                      : theme.backgroundPanel;
                    const fgColor = isSelected ? theme.background : theme.text;
                    const mutedColor = isSelected
                      ? theme.background
                      : theme.textMuted;

                    return (
                      <box
                        key={cmd.id}
                        flexDirection="row"
                        backgroundColor={bgColor}
                        paddingLeft={3}
                        paddingRight={3}
                        height={1}
                        onMouseDown={() => handleItemClick(cmd)}
                        onMouseOver={() => setSelectedIndex(itemIndex)}
                      >
                        <text fg={fgColor} flexGrow={1} wrapMode="none">
                          {cmd.title}
                        </text>
                        {cmd.keybind &&
                          (() => {
                            const displayDef = commandKeybindDisplayDef(
                              cmd.keybind,
                            );
                            return displayDef ? (
                              <text fg={mutedColor} flexShrink={0}>
                                {keybindDisplay(displayDef)}
                              </text>
                            ) : null;
                          })()}
                      </box>
                    );
                  })}
                </box>
              );
            })}
          </scrollbox>
        ) : (
          <box marginLeft={2} marginRight={2}>
            <text fg={theme.textMuted}>No matching commands</text>
          </box>
        )}

        {/* Description footer for highlighted item */}
        {highlightedCommand?.description && (
          <box
            marginTop={1}
            marginLeft={2}
            marginRight={2}
            paddingTop={1}
            borderColor={theme.borderSubtle}
            border={['top']}
          >
            <text fg={theme.textMuted}>{highlightedCommand.description}</text>
          </box>
        )}
      </box>
    </box>
  );
}
