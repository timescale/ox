import type { FC, ReactNode } from 'react';

interface Props {
  title: string;
  children: ReactNode;
  centered?: boolean;
}

export function Frame({ title, children, centered = false }: Props) {
  return (
    <box
      style={{
        flexDirection: 'column',
        padding: 1,
        paddingBottom: 0,
        flexGrow: 1,
      }}
    >
      <box
        title={` ${title} `}
        style={{
          border: true,
          borderStyle: 'single',
          padding: 1,
          paddingBottom: 0,
          flexDirection: 'column',
          flexGrow: 1,
          ...(centered
            ? { alignItems: 'center', justifyContent: 'center' }
            : {}),
        }}
      >
        {children}
      </box>
    </box>
  );
}
