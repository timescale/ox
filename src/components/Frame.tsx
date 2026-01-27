import type { ReactNode } from 'react';

interface Props {
  title: string;
  children: ReactNode;
  centered?: boolean;
}

export function Frame({ title, children, centered = false }: Props) {
  return (
    <box flexDirection="column" padding={1} paddingBottom={0} flexGrow={1}>
      <box
        title={` ${title} `}
        border
        borderStyle="single"
        padding={1}
        paddingBottom={0}
        flexDirection="column"
        flexGrow={1}
        alignItems={centered ? 'center' : undefined}
        justifyContent={centered ? 'center' : undefined}
      >
        {children}
      </box>
    </box>
  );
}
