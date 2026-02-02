import { useEffect, useState } from 'react';

export const useWindowSize = () => {
  const [columns, setColumns] = useState(() => process.stdout.columns ?? 80);
  const [rows, setRows] = useState(() => process.stdout.rows ?? 24);

  useEffect(() => {
    const handleResize = () => {
      setColumns(process.stdout.columns ?? 80);
      setRows(process.stdout.rows ?? 24);
    };

    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, []);

  return { columns, rows, isWide: columns > 100, isTall: rows > 50 };
};
