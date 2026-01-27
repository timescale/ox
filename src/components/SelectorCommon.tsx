import type { ScrollBoxRenderable, SelectOption } from '@opentui/core';

export interface BaseSelectorProps {
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

export function ListItem({
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
      flexDirection="column"
      backgroundColor={bgColor}
      paddingLeft={1}
    >
      <text fg={textColor}>{`${arrow} ${option.name}`}</text>
      <text fg={descColor}>{`  ${option.description}`}</text>
    </box>
  );
}

export const LINES_PER_ITEM = 2; // Each item has name + description
export const MAX_VISIBLE_HEIGHT = 20; // Max height of scrollbox in lines

// Scroll to center the given index in the viewport
export function scrollToIndex(
  scrollbox: ScrollBoxRenderable | null,
  index: number,
) {
  if (!scrollbox) return;
  const viewportHeight = scrollbox.viewport?.height ?? MAX_VISIBLE_HEIGHT;
  const itemY = index * LINES_PER_ITEM;
  // Center the item in the viewport
  const targetScrollY = Math.max(
    0,
    itemY - Math.floor(viewportHeight / 2) + LINES_PER_ITEM / 2,
  );
  scrollbox.scrollTo({ x: 0, y: targetScrollY });
}

// Extract option value, converting __null__ sentinel to actual null
export function getOptionValue(option: SelectOption): string | null {
  return option.value === '__null__' ? null : (option.value as string);
}
