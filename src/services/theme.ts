// ============================================================================
// Theme Service - Theme types and resolution logic
// Adapted from opencode's theme system
// ============================================================================

// Import all theme JSON files
import aura from '../theme/aura.json' with { type: 'json' };
import ayu from '../theme/ayu.json' with { type: 'json' };
import carbonfox from '../theme/carbonfox.json' with { type: 'json' };
import catppuccin from '../theme/catppuccin.json' with { type: 'json' };
import catppuccinFrappe from '../theme/catppuccin-frappe.json' with {
  type: 'json',
};
import catppuccinMacchiato from '../theme/catppuccin-macchiato.json' with {
  type: 'json',
};
import cobalt2 from '../theme/cobalt2.json' with { type: 'json' };
import cursor from '../theme/cursor.json' with { type: 'json' };
import dracula from '../theme/dracula.json' with { type: 'json' };
import everforest from '../theme/everforest.json' with { type: 'json' };
import flexoki from '../theme/flexoki.json' with { type: 'json' };
import github from '../theme/github.json' with { type: 'json' };
import gruvbox from '../theme/gruvbox.json' with { type: 'json' };
import kanagawa from '../theme/kanagawa.json' with { type: 'json' };
import lucentOrng from '../theme/lucent-orng.json' with { type: 'json' };
import material from '../theme/material.json' with { type: 'json' };
import matrix from '../theme/matrix.json' with { type: 'json' };
import mercury from '../theme/mercury.json' with { type: 'json' };
import monokai from '../theme/monokai.json' with { type: 'json' };
import nightowl from '../theme/nightowl.json' with { type: 'json' };
import nord from '../theme/nord.json' with { type: 'json' };
import oneDark from '../theme/one-dark.json' with { type: 'json' };
import opencode from '../theme/opencode.json' with { type: 'json' };
import orng from '../theme/orng.json' with { type: 'json' };
import osakaJade from '../theme/osaka-jade.json' with { type: 'json' };
import palenight from '../theme/palenight.json' with { type: 'json' };
import rosepine from '../theme/rosepine.json' with { type: 'json' };
import solarized from '../theme/solarized.json' with { type: 'json' };
import synthwave84 from '../theme/synthwave84.json' with { type: 'json' };
import tokyonight from '../theme/tokyonight.json' with { type: 'json' };
import vercel from '../theme/vercel.json' with { type: 'json' };
import vesper from '../theme/vesper.json' with { type: 'json' };
import zenburn from '../theme/zenburn.json' with { type: 'json' };

// ============================================================================
// Types
// ============================================================================

type HexColor = `#${string}`;
type RefName = string;
type Variant = {
  dark: HexColor | RefName;
  light: HexColor | RefName;
};
type ColorValue = HexColor | RefName | Variant | number;

/** Raw theme JSON structure from opencode */
export interface ThemeJson {
  $schema?: string;
  defs?: Record<string, HexColor | RefName>;
  theme: Record<string, ColorValue>;
}

/** Resolved theme colors - the subset we actually use in hermes */
export interface ThemeColors {
  // Primary colors
  primary: string;
  secondary: string;
  accent: string;

  // Status colors
  error: string;
  warning: string;
  success: string;
  info: string;

  // Text colors
  text: string;
  textMuted: string;

  // Background colors
  background: string;
  backgroundPanel: string;
  backgroundElement: string;

  // Border colors
  border: string;
  borderActive: string;
  borderSubtle: string;
}

// ============================================================================
// Theme Registry
// ============================================================================

export const DEFAULT_THEMES: Record<string, ThemeJson> = {
  aura: aura as ThemeJson,
  ayu: ayu as ThemeJson,
  carbonfox: carbonfox as ThemeJson,
  catppuccin: catppuccin as ThemeJson,
  'catppuccin-frappe': catppuccinFrappe as ThemeJson,
  'catppuccin-macchiato': catppuccinMacchiato as ThemeJson,
  cobalt2: cobalt2 as ThemeJson,
  cursor: cursor as ThemeJson,
  dracula: dracula as ThemeJson,
  everforest: everforest as ThemeJson,
  flexoki: flexoki as ThemeJson,
  github: github as ThemeJson,
  gruvbox: gruvbox as ThemeJson,
  kanagawa: kanagawa as ThemeJson,
  'lucent-orng': lucentOrng as ThemeJson,
  material: material as ThemeJson,
  matrix: matrix as ThemeJson,
  mercury: mercury as ThemeJson,
  monokai: monokai as ThemeJson,
  nightowl: nightowl as ThemeJson,
  nord: nord as ThemeJson,
  'one-dark': oneDark as ThemeJson,
  opencode: opencode as ThemeJson,
  orng: orng as ThemeJson,
  'osaka-jade': osakaJade as ThemeJson,
  palenight: palenight as ThemeJson,
  rosepine: rosepine as ThemeJson,
  solarized: solarized as ThemeJson,
  synthwave84: synthwave84 as ThemeJson,
  tokyonight: tokyonight as ThemeJson,
  vercel: vercel as ThemeJson,
  vesper: vesper as ThemeJson,
  zenburn: zenburn as ThemeJson,
};

/** Get sorted list of all theme names */
export function getThemeNames(): string[] {
  return Object.keys(DEFAULT_THEMES).sort((a, b) => a.localeCompare(b));
}

// ============================================================================
// Terminal Color Capability Detection
// ============================================================================

/**
 * Detect whether the terminal supports 24-bit (truecolor) output.
 * Terminals like iTerm2, Kitty, Ghostty, Alacritty set COLORTERM=truecolor or 24bit.
 * macOS Terminal.app does not set COLORTERM and only supports 256 colors.
 */
const colorterm = process.env.COLORTERM?.toLowerCase();
export const supportsTrueColor =
  colorterm === 'truecolor' || colorterm === '24bit';

export const DEFAULT_THEME_NAME = supportsTrueColor ? 'opencode' : 'aura';

// ============================================================================
// Color Resolution
// ============================================================================

/** Convert ANSI color code (0-255) to hex string */
export function ansiToHex(code: number): string {
  // Standard ANSI colors (0-15)
  if (code < 16) {
    const ansiColors = [
      '#000000', // Black
      '#800000', // Red
      '#008000', // Green
      '#808000', // Yellow
      '#000080', // Blue
      '#800080', // Magenta
      '#008080', // Cyan
      '#c0c0c0', // White
      '#808080', // Bright Black
      '#ff0000', // Bright Red
      '#00ff00', // Bright Green
      '#ffff00', // Bright Yellow
      '#0000ff', // Bright Blue
      '#ff00ff', // Bright Magenta
      '#00ffff', // Bright Cyan
      '#ffffff', // Bright White
    ];
    return ansiColors[code] ?? '#000000';
  }

  // 6x6x6 Color Cube (16-231)
  if (code < 232) {
    const index = code - 16;
    const b = index % 6;
    const g = Math.floor(index / 6) % 6;
    const r = Math.floor(index / 36);
    const val = (x: number) => (x === 0 ? 0 : x * 40 + 55);
    const toHex = (n: number) => n.toString(16).padStart(2, '0');
    return `#${toHex(val(r))}${toHex(val(g))}${toHex(val(b))}`;
  }

  // Grayscale Ramp (232-255)
  if (code < 256) {
    const gray = (code - 232) * 10 + 8;
    const toHex = (n: number) => n.toString(16).padStart(2, '0');
    return `#${toHex(gray)}${toHex(gray)}${toHex(gray)}`;
  }

  return '#000000';
}

/**
 * Resolve a color value to a hex string.
 * Supports: hex colors, references to defs, references to theme colors, ANSI codes, dark/light variants.
 */
function resolveColor(
  value: ColorValue,
  defs: Record<string, HexColor | RefName>,
  theme: Record<string, ColorValue>,
  mode: 'dark' | 'light' = 'dark',
  visited: Set<string> = new Set(),
): string {
  // Handle ANSI codes
  if (typeof value === 'number') {
    return ansiToHex(value);
  }

  // Handle strings (hex or reference)
  if (typeof value === 'string') {
    // Transparent/none
    if (value === 'transparent' || value === 'none') {
      return 'transparent';
    }

    // Already a hex color
    if (value.startsWith('#')) {
      return value;
    }

    // Prevent circular references
    if (visited.has(value)) {
      return '#ff00ff'; // Magenta as error indicator
    }
    visited.add(value);

    // Try to resolve from defs first
    if (defs[value] !== undefined) {
      return resolveColor(defs[value], defs, theme, mode, visited);
    }

    // Then try to resolve from theme
    if (theme[value] !== undefined) {
      return resolveColor(theme[value], defs, theme, mode, visited);
    }

    // Unknown reference, return as-is (might be a color name)
    return value;
  }

  // Handle dark/light variant objects
  if (typeof value === 'object' && value !== null) {
    const variant = value as Variant;
    const modeValue = variant[mode];
    if (modeValue !== undefined) {
      return resolveColor(modeValue, defs, theme, mode, visited);
    }
  }

  return '#000000';
}

/**
 * Resolve a theme JSON to a ThemeColors object.
 * Only extracts the colors we actually use in hermes.
 */
export function resolveTheme(
  themeJson: ThemeJson,
  mode: 'dark' | 'light' = 'dark',
): ThemeColors {
  const defs = themeJson.defs ?? {};
  const theme = themeJson.theme;

  const resolve = (key: string, fallback: string): string => {
    const value = theme[key];
    if (value === undefined) {
      return fallback;
    }
    return resolveColor(value, defs, theme, mode);
  };

  return {
    primary: resolve('primary', '#bd93f9'),
    secondary: resolve('secondary', '#ff79c6'),
    accent: resolve('accent', '#8be9fd'),
    error: resolve('error', '#ff5555'),
    warning: resolve('warning', '#f1fa8c'),
    success: resolve('success', '#50fa7b'),
    info: resolve('info', '#ffb86c'),
    text: resolve('text', '#f8f8f2'),
    textMuted: resolve('textMuted', '#6272a4'),
    background: resolve('background', '#282a36'),
    backgroundPanel: resolve('backgroundPanel', '#21222c'),
    backgroundElement: resolve('backgroundElement', '#44475a'),
    border: resolve('border', '#44475a'),
    borderActive: resolve('borderActive', '#bd93f9'),
    borderSubtle: resolve('borderSubtle', '#191a21'),
  };
}

/**
 * Get resolved theme colors by name.
 * Falls back to default theme if name not found.
 */
export function getTheme(
  name: string,
  mode: 'dark' | 'light' = 'dark',
): ThemeColors {
  const themeJson = DEFAULT_THEMES[name] ?? DEFAULT_THEMES[DEFAULT_THEME_NAME];
  if (!themeJson) {
    // This should never happen, but TypeScript doesn't know that
    throw new Error(`Theme "${name}" not found and default theme is missing`);
  }
  return resolveTheme(themeJson, mode);
}
