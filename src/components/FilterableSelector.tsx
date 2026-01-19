import type { ScrollBoxRenderable, SelectOption } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';

export interface FilterableSelectorProps {
  title: string;
  description: string;
  options: SelectOption[];
  initialIndex: number;
  showBack?: boolean;
  onSelect: (value: string | null) => void;
  onCancel: () => void;
  onBack?: () => void;
}

interface ListItemProps {
  option: SelectOption;
  isSelected: boolean;
  isHovered: boolean;
  onMouseDown: () => void;
  onMouseOver: () => void;
}

function ListItem({
  option,
  isSelected,
  isHovered,
  onMouseDown,
  onMouseOver,
}: ListItemProps) {
  // Selected takes priority, then hovered, then default
  const bgColor = isSelected ? '#0066cc' : isHovered ? '#333344' : undefined;
  const textColor = isSelected ? '#ffffff' : undefined;
  const descColor = isSelected ? '#cccccc' : '#888888';
  const arrow = isSelected ? '>' : ' ';

  return (
    <box
      onMouseDown={onMouseDown}
      onMouseOver={onMouseOver}
      style={{
        flexDirection: 'column',
        backgroundColor: bgColor,
        paddingLeft: 1,
      }}
    >
      <text style={{ fg: textColor }}>{`${arrow} ${option.name}`}</text>
      <text style={{ fg: descColor }}>{`  ${option.description}`}</text>
    </box>
  );
}

const LINES_PER_ITEM = 2; // Each item has name + description

// Scroll to center the given index in the viewport
const scrollToIndex = (
  scrollbox: ScrollBoxRenderable | null,
  index: number,
) => {
  if (!scrollbox) return;
  const viewportHeight = scrollbox.viewport?.height ?? 1;
  const itemY = index * LINES_PER_ITEM;
  // Center the item in the viewport
  const targetScrollY = Math.max(
    0,
    itemY - Math.floor(viewportHeight / 2) + LINES_PER_ITEM / 2,
  );
  scrollbox.scrollTo({ x: 0, y: targetScrollY });
};

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
    if (key.name === 'escape') {
      onCancel();
      return;
    }

    // Back navigation - use Tab when filter is empty
    if (showBack && onBack && key.name === 'tab' && filterText === '') {
      onBack();
      return;
    }

    // Arrow key navigation for the list
    if (key.name === 'up') {
      const newIndex = Math.max(0, selectedIndex - 1);
      setSelectedIndex(newIndex);
      scrollToIndex(scrollboxRef.current, newIndex);
      return;
    }
    if (key.name === 'down') {
      const newIndex = Math.min(filteredOptions.length - 1, selectedIndex + 1);
      setSelectedIndex(newIndex);
      scrollToIndex(scrollboxRef.current, newIndex);
      return;
    }

    // Enter to select current item
    if (key.name === 'return' && filteredOptions.length > 0) {
      const option = filteredOptions[clampedIndex];
      if (option) {
        onSelect(option.value === '__null__' ? null : (option.value as string));
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
      onSelect(option.value === '__null__' ? null : (option.value as string));
    }
  };

  const handleItemHover = (index: number) => {
    setHoveredIndex(index);
  };

  const handleMouseOut = () => {
    setHoveredIndex(null);
  };

  const helpText = showBack
    ? 'Type to filter, arrows to navigate, Enter/click to select, Tab (empty) to go back, Esc to cancel'
    : 'Type to filter, arrows to navigate, Enter/click to select, Esc to cancel';

  return (
    <box style={{ flexDirection: 'column', padding: 1, flexGrow: 1 }}>
      <box
        title={title}
        style={{
          border: true,
          borderStyle: 'single',
          padding: 1,
          flexDirection: 'column',
          flexGrow: 1,
        }}
      >
        <text style={{ height: 1 }}>{description}</text>
        <text style={{ height: 1, fg: '#888888' }}>{helpText}</text>

        <box style={{ marginTop: 1, flexDirection: 'row', height: 1 }}>
          <text style={{ fg: '#888888' }}>Filter: </text>
          <input
            focused
            value={filterText}
            placeholder="Type to filter..."
            onInput={handleFilterInput}
            style={{
              flexGrow: 1,
              backgroundColor: '#333333',
              textColor: '#ffffff',
            }}
          />
        </box>

        {filteredOptions.length > 0 ? (
          <scrollbox
            ref={scrollboxRef}
            onMouseOut={handleMouseOut}
            style={{
              marginTop: 1,
              flexShrink: 1,
              flexGrow: 1,
              maxHeight: filteredOptions.length * LINES_PER_ITEM,
            }}
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
          <text style={{ marginTop: 1, fg: '#888888' }}>
            No items match your filter
          </text>
        )}

        <text style={{ marginTop: 1, fg: '#555555' }}>
          {filteredOptions.length} of {options.length} items shown
        </text>
      </box>
    </box>
  );
}
