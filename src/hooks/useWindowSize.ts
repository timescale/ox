import debounce from 'debounce';
import { useEffect, useState } from 'react';
import { log } from '../services/logger';

const debouncedLog = debounce((c: number, r: number) => {
  log.debug({ c, r }, 'Window resized');
}, 1000);

export const useWindowSize = () => {
  const [columns, setColumns] = useState(() => process.stdout.columns ?? 80);
  const [rows, setRows] = useState(() => process.stdout.rows ?? 24);

  useEffect(() => {
    const handleResize = () => {
      const c = process.stdout.columns ?? 80;
      const r = process.stdout.rows ?? 24;
      setColumns(c);
      setRows(r);
      debouncedLog(c, r);
    };

    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, []);

  return { columns, rows, isWide: columns > 100, isTall: rows > 40 };
};
