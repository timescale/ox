import type { ScrollBoxRenderable } from '@opentui/core';
import { flushSync, useKeyboard } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';
import {
  type BaseSelectorProps,
  getOptionValue,
  LINES_PER_ITEM,
  ListItem,
  scrollToIndex,
} from './SelectorCommon.tsx';

export type FilterableSelectorProps = BaseSelectorProps;

export function FilterableSelector({
  title,
  description,
  options,
  initialIndex,
  showBack = false,
  onSelect,
  onCancel,
  onBack,
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

  // Filter options based on text input
  const filteredOptions = options.filter((opt) => {
    const searchText = filterText.toLowerCase();
    return (
      opt.name.toLowerCase().includes(searchText) ||
      (opt.description?.toLowerCase().includes(searchText) ?? false)
    );
  });

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
      return;
    }
    if (key.name === 'down') {
      const newIndex = Math.min(filteredOptions.length - 1, selectedIndex + 1);
      flushSync(() => setSelectedIndex(newIndex));
      scrollToIndex(scrollboxRef.current, newIndex);
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
  };

  const handleMouseOut = () => {
    setHoveredIndex(null);
  };

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
        <text height={1} fg="#888888">
          {helpText}
        </text>

        <box marginTop={1} flexDirection="row" height={1}>
          <text fg="#888888">Filter: </text>
          <input
            focused
            value={filterText}
            placeholder="Type to filter..."
            onInput={handleFilterInput}
            flexGrow={1}
            backgroundColor="#333333"
            textColor="#ffffff"
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
          <text marginTop={1} fg="#888888">
            No items match your filter
          </text>
        )}

        <text marginTop={1} fg="#555555">
          {filteredOptions.length} of {options.length} items shown
        </text>
      </box>
    </box>
  );
}
