import { useEffect, useRef, useState } from 'react';

// Animated ... indicator
export function Dots() {
  const count = useRef(0);
  const [dots, setDots] = useState('   ');

  useEffect(() => {
    const interval = setInterval(() => {
      count.current += 1;
      setDots('.'.repeat(count.current % 4).padEnd(3, ' '));
    }, 400);
    return () => clearInterval(interval);
  }, []);

  return <span>{dots}</span>;
}
