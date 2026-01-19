import type { ScrollBoxRenderable, SelectOption } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useEffect, useRef, useState } from 'react';

export interface SelectorProps {
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
const MAX_VISIBLE_HEIGHT = 20; // Max height of scrollbox in lines

// Scroll to center the given index in the viewport
const scrollToIndex = (
  scrollbox: ScrollBoxRenderable | null,
  index: number,
) => {
  if (!scrollbox) return;
  const viewportHeight = scrollbox.viewport?.height ?? MAX_VISIBLE_HEIGHT;
  const itemY = index * LINES_PER_ITEM;
  // Center the item in the viewport
  const targetScrollY = Math.max(
    0,
    itemY - Math.floor(viewportHeight / 2) + LINES_PER_ITEM / 2,
  );
  scrollbox.scrollTo({ x: 0, y: targetScrollY });
};

export function Selector({
  title,
  description,
  options,
  initialIndex,
  showBack = false,
  onSelect,
  onCancel,
  onBack,
}: SelectorProps) {
  const [selectedIndex, setSelectedIndex] = useState(() => {
    return initialIndex >= 0 ? initialIndex : 0;
  });
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);
  const hasInitialScrolled = useRef(false);

  // Scroll to initial selection after component mounts and renders
  useEffect(() => {
    if (hasInitialScrolled.current) return;
    // Use setTimeout to ensure the scrollbox is fully rendered with content
    const timer = setTimeout(() => {
      if (scrollboxRef.current && !hasInitialScrolled.current) {
        scrollToIndex(
          scrollboxRef.current,
          initialIndex >= 0 ? initialIndex : 0,
        );
        hasInitialScrolled.current = true;
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [initialIndex]);

  useKeyboard((key) => {
    if (key.name === 'escape') {
      onCancel();
    }
    if (showBack && onBack && (key.name === 'backspace' || key.name === 'b')) {
      onBack();
    }
    if (key.name === 'up') {
      const newIndex = Math.max(0, selectedIndex - 1);
      setSelectedIndex(newIndex);
      scrollToIndex(scrollboxRef.current, newIndex);
    }
    if (key.name === 'down') {
      const newIndex = Math.min(options.length - 1, selectedIndex + 1);
      setSelectedIndex(newIndex);
      scrollToIndex(scrollboxRef.current, newIndex);
    }
    if (key.name === 'return' && options.length > 0) {
      const option = options[selectedIndex];
      if (option) {
        onSelect(option.value === '__null__' ? null : (option.value as string));
      }
    }
  });

  const handleItemClick = (index: number) => {
    const option = options[index];
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
        <text>{description}</text>
        <text style={{ fg: '#888888' }}>
          {showBack
            ? 'Use arrows to navigate, Enter/click to select, b/Backspace to go back, Esc to cancel'
            : 'Use arrows to navigate, Enter/click to select, Esc to cancel'}
        </text>

        <scrollbox
          ref={scrollboxRef}
          onMouseOut={handleMouseOut}
          style={{
            marginTop: 1,
            flexShrink: 1,
            flexGrow: 1,
            maxHeight: options.length * LINES_PER_ITEM,
          }}
        >
          {options.map((option, index) => (
            <ListItem
              key={option.value ?? index}
              option={option}
              isSelected={index === selectedIndex}
              isHovered={index === hoveredIndex}
              onMouseDown={() => handleItemClick(index)}
              onMouseOver={() => handleItemHover(index)}
            />
          ))}
        </scrollbox>
      </box>
    </box>
  );
}
