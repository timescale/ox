import { useEffect, useRef, useState } from 'react';

export interface StartingScreenProps {
  step: string;
}

export function StartingScreen({ step }: StartingScreenProps) {
  const count = useRef(0);
  const [dots, setDots] = useState('');

  useEffect(() => {
    const interval = setInterval(() => {
      count.current += 1;
      setDots('.'.repeat(count.current % 4).padEnd(3, ' '));
    }, 300);
    return () => clearInterval(interval);
  }, []);

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      alignItems="center"
      justifyContent="center"
    >
      <text fg="#888888" marginBottom={2}>
        Starting...
      </text>
      <text fg="#cccccc">
        {step}
        {dots}
      </text>
    </box>
  );
}
