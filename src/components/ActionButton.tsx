import { useState } from 'react';
import { useTheme } from '../stores/themeStore.ts';

export interface ActionButtonProps {
  label: string;
  keybind?: string;
  color: string;
  onPress: () => void;
  focused?: boolean;
}

export function ActionButton({
  label,
  keybind,
  color,
  onPress,
  focused,
}: ActionButtonProps) {
  const { theme } = useTheme();
  const [hovered, setHovered] = useState(false);

  const highlighted = hovered || focused;

  return (
    <box
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={onPress}
      backgroundColor={highlighted ? color : undefined}
      border
      borderStyle="single"
      borderColor={highlighted ? color : theme.border}
      paddingLeft={1}
      paddingRight={1}
      height={3}
      gap={2}
      flexDirection="row"
    >
      <text fg={highlighted ? theme.background : color}>
        {highlighted ? <strong>{label}</strong> : label}
      </text>
      {keybind ? (
        <text fg={highlighted ? theme.backgroundPanel : theme.textMuted}>
          {keybind}
        </text>
      ) : null}
    </box>
  );
}
