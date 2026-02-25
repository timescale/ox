import type { KeyEvent, ScrollBoxRenderable } from '@opentui/core';
import { flushSync, useKeyboard } from '@opentui/react';
import fuzzysort from 'fuzzysort';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../stores/themeStore.ts';
import { HotkeysBar } from './HotkeysBar';
import {
  type BaseSelectorProps,
  getOptionValue,
  LINES_PER_ITEM,
  ListItem,
  scrollToIndex,
} from './SelectorCommon.tsx';

export interface HotkeyConfig {
  /** Display label for the hotkey (e.g., "ctrl+a") */
  label: string;
  /** Display description for the hotkey (e.g., "add provider") */
  description: string;
  /** Test function to check if the key event matches this hotkey */
  test: (key: KeyEvent) => boolean;
  /** Handler function to call when the hotkey is triggered */
  handler: () => void;
}

export interface FilterableSelectorProps extends BaseSelectorProps {
  /** Optional array of hotkeys to register */
  hotkeys?: HotkeyConfig[];
  /** Optional callback for live preview - called on selection change, hover, and mouse-out */
  onPreview?: (value: string | null) => void;
}

export function FilterableSelector({
  title,
  description,
  options,
  initialIndex,
  showBack = false,
  onSelect,
  onCancel,
  onBack,
  hotkeys,
  onPreview,
}: FilterableSelectorProps) {
  const [filterText, setFilterText] = useState('');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);

  // Capture the initial index at mount time (clamped to valid range)
  const computedInitialIndex =
    initialIndex >= 0 && initialIndex < options.length ? initialIndex : 0;
  const initialIndexRef = useRef(computedInitialIndex);

  const [selectedIndex, setSelectedIndex] = useState(computedInitialIndex);
  const hasInitialScrolled = useRef(false);

  // Filter options via fuzzysort when there's a search query
  const filteredOptions = useMemo(
    () =>
      filterText
        ? fuzzysort
            .go(filterText, options, {
              keys: ['name', 'description'],
              scoreFn: (r) =>
                Math.max(
                  r[0]?.score ?? 0, // name (full weight)
                  (r[1]?.score ?? 0) * 0.5, // description (reduced)
                ),
              threshold: 0.3,
            })
            .map((r) => r.obj)
        : options,
    [filterText, options],
  );

  // Clamp selected index to valid range for filtered options
  const clampedIndex = Math.min(
    selectedIndex,
    Math.max(0, filteredOptions.length - 1),
  );

  // Scroll to initial selection after component mounts and renders
  useEffect(() => {
    if (hasInitialScrolled.current) return;
    // Use setTimeout to ensure the scrollbox is fully rendered with content
    const timer = setTimeout(() => {
      if (scrollboxRef.current && !hasInitialScrolled.current) {
        scrollToIndex(scrollboxRef.current, initialIndexRef.current);
        hasInitialScrolled.current = true;
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useKeyboard((key) => {
    // Check custom hotkeys first
    if (hotkeys) {
      for (const hotkey of hotkeys) {
        if (hotkey.test(key)) {
          hotkey.handler();
          return;
        }
      }
    }

    // Esc goes back if possible, otherwise cancels
    if (key.name === 'escape') {
      if (showBack && onBack) {
        onBack();
      } else {
        onCancel();
      }
      return;
    }

    // Tab also goes back when filter is empty
    if (showBack && onBack && key.name === 'tab' && filterText === '') {
      onBack();
      return;
    }

    // Arrow key navigation for the list
    // Use flushSync to render and scroll in one frame to avoid flicker
    if (key.name === 'up') {
      const newIndex = Math.max(0, selectedIndex - 1);
      flushSync(() => setSelectedIndex(newIndex));
      scrollToIndex(scrollboxRef.current, newIndex);
      const option = filteredOptions[newIndex];
      if (option && onPreview) {
        onPreview(getOptionValue(option));
      }
      return;
    }
    if (key.name === 'down') {
      const newIndex = Math.min(filteredOptions.length - 1, selectedIndex + 1);
      flushSync(() => setSelectedIndex(newIndex));
      scrollToIndex(scrollboxRef.current, newIndex);
      const option = filteredOptions[newIndex];
      if (option && onPreview) {
        onPreview(getOptionValue(option));
      }
      return;
    }

    // Enter to select current item
    if (key.name === 'return' && filteredOptions.length > 0) {
      const option = filteredOptions[clampedIndex];
      if (option) {
        onSelect(getOptionValue(option));
      }
      return;
    }
  });

  const handleFilterInput = (value: string) => {
    setFilterText(value);
    // Reset selection to top when filter changes
    setSelectedIndex(0);
    scrollToIndex(scrollboxRef.current, 0);
  };

  const handleItemClick = (index: number) => {
    const option = filteredOptions[index];
    if (option) {
      onSelect(getOptionValue(option));
    }
  };

  const handleItemHover = (index: number) => {
    setHoveredIndex(index);
    const option = filteredOptions[index];
    if (option && onPreview) {
      onPreview(getOptionValue(option));
    }
  };

  const handleMouseOut = () => {
    setHoveredIndex(null);
    // Restore preview to currently selected item
    const option = filteredOptions[clampedIndex];
    if (option && onPreview) {
      onPreview(getOptionValue(option));
    }
  };

  const { theme } = useTheme();

  const helpText = showBack
    ? 'Type to filter, arrows to navigate, Enter/click to select, Esc to go back'
    : 'Type to filter, arrows to navigate, Enter/click to select, Esc to cancel';

  return (
    <box flexDirection="column" padding={1} flexGrow={1}>
      <box
        title={title}
        border
        borderStyle="single"
        padding={1}
        flexDirection="column"
        flexGrow={1}
      >
        <text height={1}>{description}</text>
        <text height={1} fg={theme.textMuted}>
          {helpText}
        </text>

        <box marginTop={1} flexDirection="row" height={1}>
          <text fg={theme.textMuted}>Filter: </text>
          <input
            focused
            value={filterText}
            placeholder="Type to filter..."
            onInput={handleFilterInput}
            flexGrow={1}
            backgroundColor={theme.backgroundElement}
            textColor={theme.text}
          />
        </box>

        {filteredOptions.length > 0 ? (
          <scrollbox
            ref={scrollboxRef}
            onMouseOut={handleMouseOut}
            marginTop={1}
            flexShrink={1}
            flexGrow={1}
            maxHeight={filteredOptions.length * LINES_PER_ITEM}
          >
            {filteredOptions.map((option, index) => (
              <ListItem
                key={option.value ?? index}
                option={option}
                isSelected={index === clampedIndex}
                isHovered={index === hoveredIndex}
                onMouseDown={() => handleItemClick(index)}
                onMouseOver={() => handleItemHover(index)}
              />
            ))}
          </scrollbox>
        ) : (
          <text marginTop={1} fg={theme.textMuted}>
            No items match your filter
          </text>
        )}

        <text marginTop={1} fg={theme.borderSubtle}>
          {`${filteredOptions.length} of ${options.length} items shown`}
        </text>

        {hotkeys && hotkeys.length > 0 && (
          <HotkeysBar
            keyList={hotkeys.map((h) => [h.label, h.description] as const)}
          />
        )}
      </box>
    </box>
  );
}
