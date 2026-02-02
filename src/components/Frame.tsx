import type { ReactNode } from 'react';
import { useWindowSize } from '../hooks/useWindowSize';

interface Props {
  title: string;
  children: ReactNode;
  centered?: boolean;
}

export function Frame({ title, children, centered = false }: Props) {
  const { isWide, isTall } = useWindowSize();
  return (
    <box
      marginLeft={isWide ? 1 : 0}
      marginRight={isWide ? 1 : 0}
      marginTop={isTall ? 1 : 0}
      marginBottom={isTall ? 1 : 0}
      title={` ${title} `}
      border
      borderStyle="single"
      paddingLeft={1}
      paddingRight={1}
      paddingBottom={0}
      paddingTop={isTall ? 1 : 0}
      flexDirection="column"
      flexGrow={1}
      alignItems={centered ? 'center' : undefined}
      justifyContent={centered ? 'center' : undefined}
    >
      {children}
    </box>
  );
}
