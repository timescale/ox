import { useState } from 'react';
import { useTheme } from '../stores/themeStore.ts';

export interface ActionButtonProps {
  label: string;
  keybind?: string;
  color: string;
  onPress: () => void;
  focused?: boolean;
  disabled?: boolean;
}

export function ActionButton({
  label,
  keybind,
  color,
  onPress,
  focused,
  disabled,
}: ActionButtonProps) {
  const { theme } = useTheme();
  const [hovered, setHovered] = useState(false);

  const highlighted = !disabled && (hovered || focused);

  return (
    <box
      onMouseOver={disabled ? undefined : () => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={disabled ? undefined : onPress}
      backgroundColor={highlighted ? color : undefined}
      border
      borderStyle="single"
      borderColor={
        highlighted ? color : disabled ? theme.textMuted : theme.border
      }
      paddingLeft={1}
      paddingRight={1}
      height={3}
      gap={2}
      flexDirection="row"
    >
      <text
        fg={highlighted ? theme.background : disabled ? theme.textMuted : color}
      >
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
