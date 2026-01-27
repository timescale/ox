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

export type SelectorProps = BaseSelectorProps;

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
    // Esc goes back if possible, otherwise cancels
    if (key.name === 'escape') {
      if (showBack && onBack) {
        onBack();
      } else {
        onCancel();
      }
    }
    // Backspace/b also goes back
    if (showBack && onBack && (key.name === 'backspace' || key.name === 'b')) {
      onBack();
    }
    // Use flushSync to render and scroll in one frame to avoid flicker
    if (key.name === 'up') {
      const newIndex = Math.max(0, selectedIndex - 1);
      flushSync(() => setSelectedIndex(newIndex));
      scrollToIndex(scrollboxRef.current, newIndex);
    }
    if (key.name === 'down') {
      const newIndex = Math.min(options.length - 1, selectedIndex + 1);
      flushSync(() => setSelectedIndex(newIndex));
      scrollToIndex(scrollboxRef.current, newIndex);
    }
    if (key.name === 'return' && options.length > 0) {
      const option = options[selectedIndex];
      if (option) {
        onSelect(getOptionValue(option));
      }
    }
  });

  const handleItemClick = (index: number) => {
    const option = options[index];
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
    ? 'Arrows to navigate, Enter/click to select, Esc to go back'
    : 'Arrows to navigate, Enter/click to select, Esc to cancel';

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

        <scrollbox
          ref={scrollboxRef}
          onMouseOut={handleMouseOut}
          marginTop={1}
          flexShrink={1}
          flexGrow={1}
          maxHeight={options.length * LINES_PER_ITEM}
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
