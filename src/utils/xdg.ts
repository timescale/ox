import { homedir } from 'node:os';
import { join } from 'node:path';
import { xdgData, xdgState } from 'xdg-basedir';

/**
 * Resolve the XDG directories using `xdg-basedir`.
 * Prefers the env vars directly to respect runtime changes (e.g. in tests).
 * since `xdg-basedir` evaluates the env var once at import time.
 */

export const getXdgData = (): string =>
  process.env.XDG_DATA_HOME || xdgData || join(homedir(), '.local', 'share');

export const getXdgState = (): string => {
  return (
    process.env.XDG_STATE_HOME || xdgState || join(homedir(), '.local', 'state')
  );
};
