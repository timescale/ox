import { createInterface } from 'node:readline';
import { type CliRenderer, createCliRenderer } from '@opentui/core';
import type { Root } from '@opentui/react';
import { createRoot } from '@opentui/react';
import type { ReactNode } from 'react';
import { useTheme } from '../stores/themeStore';
import { restoreConsole } from '../utils';
import { supportsTrueColor } from './theme';

interface TuiResult {
  renderer: CliRenderer;
  root: Root;
  destroy: () => Promise<void>;
  render: (node: ReactNode) => void;
}

/**
 * Warn the user if their terminal lacks truecolor support.
 * The TUI renderer (@opentui) only outputs 24-bit color escape sequences,
 * which non-truecolor terminals will ignore, resulting in a blank or garbled screen.
 */
async function warnIfNoTrueColor(): Promise<void> {
  if (supportsTrueColor) return;

  console.warn(
    '\n\x1b[33mWarning: Your terminal does not appear to support truecolor (24-bit color).\x1b[0m\n' +
      'The hermes TUI requires truecolor support and may not render correctly.\n' +
      'For best results, use Ghostty, iTerm2, Kitty, or another truecolor terminal.\n',
  );

  await new Promise<void>((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question('Press Enter to continue anyway, or Ctrl+C to quit... ', () => {
      rl.close();
      resolve();
    });
  });
}

export const createTui = async (): Promise<TuiResult> => {
  await warnIfNoTrueColor();
  await useTheme.getState().initialize();
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const root = createRoot(renderer);

  const render = (node: ReactNode) => {
    root.render(node);
  };

  const destroy = async () => {
    await renderer.idle();
    renderer.destroy();
    restoreConsole();
  };

  return { root, destroy, render, renderer };
};
