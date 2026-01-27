interface Props {
  keyList: readonly [string, string][];
  compact?: boolean;
}

export function HotkeysBar({ keyList, compact }: Props) {
  return (
    <box flexDirection="row" justifyContent="flex-end" gap={2}>
      {keyList.map(([key, action]) => (
        <box
          key={key}
          flexDirection="row"
          gap={key.length === 1 && compact ? 0 : 1}
        >
          <text fg="#eee">{key}</text>
          <text fg="#666666">{action}</text>
        </box>
      ))}
    </box>
  );
}
