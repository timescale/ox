// ============================================================================
// Colors Command - Display theme color swatches for diagnostics
// ============================================================================

import { useKeyboard } from '@opentui/react';
import { Command } from 'commander';
import { CopyOnSelect } from '../components/CopyOnSelect';
import {
  ansiToHex,
  DEFAULT_THEME_NAME,
  getTheme,
  getThemeNames,
  supportsTrueColor,
  type ThemeColors,
} from '../services/theme';
import { createTui } from '../services/tui';
import { useTheme } from '../stores/themeStore';

// ============================================================================
// ANSI 256-Color Utilities
// ============================================================================

/** Pre-built ANSI 256 palette for nearest-color lookup */
function buildAnsi256Palette(): {
  code: number;
  r: number;
  g: number;
  b: number;
}[] {
  const palette: { code: number; r: number; g: number; b: number }[] = [];
  for (let i = 0; i < 256; i++) {
    const hex = ansiToHex(i);
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    palette.push({ code: i, r, g, b });
  }
  return palette;
}

const ansi256Palette = buildAnsi256Palette();

/** Find the nearest ANSI 256-color code for a hex color */
function hexToAnsi256Code(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);

  let bestDist = Number.POSITIVE_INFINITY;
  let bestCode = 0;

  for (const entry of ansi256Palette) {
    const dr = r - entry.r;
    const dg = g - entry.g;
    const db = b - entry.b;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestCode = entry.code;
      if (dist === 0) break;
    }
  }

  return bestCode;
}

// ============================================================================
// ANSI Escape Helpers
// ============================================================================

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

function parseHex(hex: string): { r: number; g: number; b: number } {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

/** Truecolor (24-bit) background */
function bgTrue(hex: string): string {
  const { r, g, b } = parseHex(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/** Truecolor (24-bit) foreground */
function fgTrue(hex: string): string {
  const { r, g, b } = parseHex(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** 256-color background */
function bg256(hex: string): string {
  return `\x1b[48;5;${hexToAnsi256Code(hex)}m`;
}

/** 256-color foreground */
function fg256(hex: string): string {
  return `\x1b[38;5;${hexToAnsi256Code(hex)}m`;
}

// ============================================================================
// Non-TUI (stdout) Mode
// ============================================================================

/** Color slot definitions with display names and grouping */
const COLOR_SLOTS: { key: keyof ThemeColors; label: string; group: string }[] =
  [
    { key: 'primary', label: 'primary', group: 'Primary' },
    { key: 'secondary', label: 'secondary', group: 'Primary' },
    { key: 'accent', label: 'accent', group: 'Primary' },
    { key: 'error', label: 'error', group: 'Status' },
    { key: 'warning', label: 'warning', group: 'Status' },
    { key: 'success', label: 'success', group: 'Status' },
    { key: 'info', label: 'info', group: 'Status' },
    { key: 'text', label: 'text', group: 'Text' },
    { key: 'textMuted', label: 'textMuted', group: 'Text' },
    { key: 'background', label: 'background', group: 'Background' },
    { key: 'backgroundPanel', label: 'backgroundPanel', group: 'Background' },
    {
      key: 'backgroundElement',
      label: 'backgroundElement',
      group: 'Background',
    },
    { key: 'border', label: 'border', group: 'Border' },
    { key: 'borderActive', label: 'borderActive', group: 'Border' },
    { key: 'borderSubtle', label: 'borderSubtle', group: 'Border' },
  ];

function printColorsStdout(themeName: string, colors: ThemeColors): void {
  const w = process.stdout.write.bind(process.stdout);

  // Column layout constants (character widths)
  const nameCol = 20; // color name column
  const swatchWidth = 10; // each swatch: spaces with colored background
  const gap = 1; // space between swatches

  const swatch = ' '.repeat(swatchWidth);

  w(`\n${BOLD}Hermes Theme Colors: ${themeName}${RESET}\n`);
  w(
    `${DIM}Truecolor: ${supportsTrueColor ? 'yes' : 'no'}` +
      ` (COLORTERM=${process.env.COLORTERM ?? 'unset'})${RESET}\n\n`,
  );

  // Header - align with swatch columns
  w(
    `${'Color'.padEnd(nameCol)}` +
      `${'Truecolor'.padEnd(swatchWidth + gap)}` +
      `${'256-Color'.padEnd(swatchWidth + gap)}` +
      `Hex\n`,
  );
  w(`${'─'.repeat(nameCol + (swatchWidth + gap) * 2 + 20)}\n`);

  let lastGroup = '';
  for (const slot of COLOR_SLOTS) {
    // Group separator
    if (slot.group !== lastGroup) {
      if (lastGroup) w('\n');
      w(`${DIM}${slot.group}${RESET}\n`);
      lastGroup = slot.group;
    }

    const hex = colors[slot.key];
    const code = hexToAnsi256Code(hex);

    const trueSwatch = `${bgTrue(hex)}${swatch}${RESET}`;
    const ansiSwatch = `${bg256(hex)}${swatch}${RESET}`;

    w(
      `  ${slot.label.padEnd(nameCol - 2)}` +
        `${trueSwatch}${' '.repeat(gap)}` +
        `${ansiSwatch}${' '.repeat(gap)}` +
        `${DIM}${hex} (256: ${String(code).padStart(3)})${RESET}\n`,
    );
  }

  w('\n');

  // Text rendering comparison
  w(`${BOLD}Text Rendering Test${RESET}\n`);
  w(`${'─'.repeat(nameCol + (swatchWidth + gap) * 2 + 20)}\n`);
  w(
    `  ${'Truecolor fg:'.padEnd(nameCol - 2)}${fgTrue(colors.primary)}The quick brown fox jumps over the lazy dog${RESET}\n`,
  );
  w(
    `  ${'256-color fg:'.padEnd(nameCol - 2)}${fg256(colors.primary)}The quick brown fox jumps over the lazy dog${RESET}\n`,
  );
  w(
    `  ${'Truecolor bg:'.padEnd(nameCol - 2)}${bgTrue(colors.background)}${fgTrue(colors.text)} text on background ${RESET}` +
      ` ${bgTrue(colors.backgroundPanel)}${fgTrue(colors.textMuted)} muted on panel ${RESET}\n`,
  );
  w(
    `  ${'256-color bg:'.padEnd(nameCol - 2)}${bg256(colors.background)}${fg256(colors.text)} text on background ${RESET}` +
      ` ${bg256(colors.backgroundPanel)}${fg256(colors.textMuted)} muted on panel ${RESET}\n`,
  );
  w('\n');

  if (!supportsTrueColor) {
    w(
      `${BOLD}\x1b[33mNote:${RESET} Your terminal does not advertise truecolor support.\n` +
        'If the "Truecolor" and "256-Color" columns look the same, your terminal\n' +
        'may be approximating truecolor. If the "Truecolor" column is blank or\n' +
        'garbled, your terminal only supports 256 colors.\n' +
        'For best results, use Ghostty, iTerm2, Kitty, or another truecolor terminal.\n\n',
    );
  }
}

// ============================================================================
// TUI Mode
// ============================================================================

interface ColorsScreenProps {
  themeName: string;
  onExit: () => void;
}

/** Group COLOR_SLOTS by their group field for rendering with headers */
function groupedSlots(): { group: string; slots: typeof COLOR_SLOTS }[] {
  const groups: { group: string; slots: typeof COLOR_SLOTS }[] = [];
  let current: (typeof groups)[0] | null = null;
  for (const slot of COLOR_SLOTS) {
    if (!current || current.group !== slot.group) {
      current = { group: slot.group, slots: [] };
      groups.push(current);
    }
    current.slots.push(slot);
  }
  return groups;
}

const SWATCH_GROUPS = groupedSlots();
const NAME_COL = 20;
const SWATCH_W = 10;

function ColorRow({
  label,
  hex,
  theme,
}: {
  label: string;
  hex: string;
  theme: ThemeColors;
}) {
  const code = hexToAnsi256Code(hex);
  return (
    <box flexDirection="row" height={1}>
      <text fg={theme.textMuted} width={NAME_COL}>
        {'  '}
        {label}
      </text>
      <box backgroundColor={hex} width={SWATCH_W}>
        <text> </text>
      </box>
      <text> </text>
      <text fg={theme.textMuted}>
        {hex} (256: {String(code).padStart(3)})
      </text>
    </box>
  );
}

function ColorsScreen({ themeName, onExit }: ColorsScreenProps) {
  const { theme } = useTheme();

  useKeyboard((key) => {
    if (key.name === 'escape' || key.name === 'q') {
      onExit();
    }
  });

  return (
    <box flexDirection="column" padding={1} flexGrow={1}>
      <text fg={theme.text}>
        <strong>
          Hermes Theme Colors: {themeName}
          {supportsTrueColor ? '' : ' (no truecolor detected)'}
        </strong>
      </text>
      <text fg={theme.textMuted} marginBottom={1}>
        Press Escape or q to exit
      </text>

      {/* Column header */}
      <box flexDirection="row" height={1}>
        <text fg={theme.textMuted} width={NAME_COL}>
          Color
        </text>
        <text fg={theme.textMuted} width={SWATCH_W + 1}>
          Swatch
        </text>
        <text fg={theme.textMuted}>Hex</text>
      </box>

      {/* Color swatches grouped */}
      <box flexDirection="column">
        {SWATCH_GROUPS.map(({ group, slots }) => (
          <box key={group} flexDirection="column" marginTop={1}>
            <text fg={theme.text}>{group}</text>
            {slots.map((slot) => (
              <ColorRow
                key={slot.key}
                label={slot.label}
                hex={theme[slot.key]}
                theme={theme}
              />
            ))}
          </box>
        ))}
      </box>

      {/* Text rendering samples */}
      <box flexDirection="column" marginTop={1}>
        <text fg={theme.text}>
          <strong>Text Rendering Test</strong>
        </text>
        <box flexDirection="column" marginTop={1}>
          <box flexDirection="row" height={1}>
            <text fg={theme.textMuted} width={NAME_COL}>
              {'  '}Foreground:
            </text>
            <text fg={theme.primary}>
              The quick brown fox jumps over the lazy dog
            </text>
          </box>
          <box flexDirection="row" height={1}>
            <text fg={theme.textMuted} width={NAME_COL}>
              {'  '}Text on bg:
            </text>
            <box
              backgroundColor={theme.background}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={theme.text}>text on background</text>
            </box>
            <text> </text>
            <box
              backgroundColor={theme.backgroundPanel}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={theme.textMuted}>muted on panel</text>
            </box>
          </box>
        </box>
      </box>
    </box>
  );
}

// ============================================================================
// Command Actions
// ============================================================================

interface ColorsOptions {
  tui?: boolean;
  theme?: string;
}

async function colorsAction(options: ColorsOptions): Promise<void> {
  const themeNames = getThemeNames();
  const themeName =
    options.theme && themeNames.includes(options.theme)
      ? options.theme
      : DEFAULT_THEME_NAME;
  const colors = getTheme(themeName);

  if (options.tui) {
    // TUI mode
    let resolveResult: () => void;
    const resultPromise = new Promise<void>((resolve) => {
      resolveResult = resolve;
    });

    const { render, destroy } = await createTui();

    // Apply the requested theme so the TUI renders with it
    useTheme.getState().setTheme(themeName);

    render(
      <CopyOnSelect>
        <ColorsScreen themeName={themeName} onExit={() => resolveResult()} />
      </CopyOnSelect>,
    );

    await resultPromise;
    await destroy();
  } else {
    // Non-TUI stdout mode (default)
    printColorsStdout(themeName, colors);
  }
}

// ============================================================================
// Command Definition
// ============================================================================

export const colorsCommand = new Command('colors')
  .description('Display theme color swatches for diagnostics')
  .option('--tui', 'Show colors in TUI mode (requires truecolor terminal)')
  .option(
    '-t, --theme <name>',
    'Show colors for a specific theme (default: current default)',
  )
  .action(colorsAction);
