import type { ReactNode } from 'react';

// ANSI color code mappings
const ANSI_COLORS: Record<number, string> = {
  // Standard colors (30-37)
  30: '#000000', // black
  31: '#cc0000', // red
  32: '#00cc00', // green
  33: '#cccc00', // yellow
  34: '#0000cc', // blue
  35: '#cc00cc', // magenta
  36: '#00cccc', // cyan
  37: '#cccccc', // white
  // Bright colors (90-97)
  90: '#666666', // bright black (gray)
  91: '#ff6666', // bright red
  92: '#66ff66', // bright green
  93: '#ffff66', // bright yellow
  94: '#6666ff', // bright blue
  95: '#ff66ff', // bright magenta
  96: '#66ffff', // bright cyan
  97: '#ffffff', // bright white
};

// Reset code
const RESET = 0;

interface TextSegment {
  text: string;
  color?: string;
  bold?: boolean;
}

// Pattern to strip non-color escape sequences (cursor movement, modes, etc.)
const STRIP_SEQUENCES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI/terminal control codes
  /\x1b\[[0-9;]*[ABCDEFGHJKSTfnsu]|\x1b\[\?[0-9;]*[hl]|\x1b\][^\x07]*\x07/g;

// Pattern to match ANSI color/style escape sequences
// biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI codes
const COLOR_REGEX = /\x1b\[([0-9;]*)m/g;

/**
 * Strip non-color terminal control sequences from input
 */
function stripControlSequences(input: string): string {
  return input.replace(STRIP_SEQUENCES, '');
}

/**
 * Parse ANSI SGR codes and update color/style state
 * Returns the new foreground color (if changed) or undefined
 */
function parseColorCodes(codeString: string): {
  color?: string;
  reset?: boolean;
  bold?: boolean;
  unbold?: boolean;
} {
  if (!codeString) return { reset: true };

  const codes = codeString.split(';').map(Number);
  let i = 0;
  let color: string | undefined;
  let reset = false;
  let bold: boolean | undefined;
  let unbold: boolean | undefined;

  while (i < codes.length) {
    const code = codes[i];

    if (code === RESET) {
      reset = true;
    } else if (code === 1) {
      bold = true;
    } else if (code === 22) {
      unbold = true;
    } else if (code === 38) {
      // Foreground color - check for 24-bit (38;2;R;G;B) or 256-color (38;5;N)
      if (codes[i + 1] === 2 && i + 4 < codes.length) {
        // 24-bit color: 38;2;R;G;B
        const r = codes[i + 2];
        const g = codes[i + 3];
        const b = codes[i + 4];
        if (r !== undefined && g !== undefined && b !== undefined) {
          color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
        }
        i += 4;
      } else if (codes[i + 1] === 5 && i + 2 < codes.length) {
        // 256-color: 38;5;N - skip for now, just advance
        i += 2;
      }
    } else if (code === 48) {
      // Background color - skip (we only render foreground)
      if (codes[i + 1] === 2) {
        i += 4; // 48;2;R;G;B
      } else if (codes[i + 1] === 5) {
        i += 2; // 48;5;N
      }
    } else if (code === 39) {
      // Default foreground color
      color = undefined;
      reset = true;
    } else if (code === 49) {
      // Default background color - ignore
    } else if (code !== undefined && ANSI_COLORS[code]) {
      color = ANSI_COLORS[code];
    }

    i++;
  }

  return { color, reset, bold, unbold };
}

/**
 * Parse a string with ANSI codes into segments with color info
 */
function parseAnsi(input: string): TextSegment[] {
  // First strip non-color control sequences
  const cleaned = stripControlSequences(input);

  const segments: TextSegment[] = [];
  let currentColor: string | undefined;
  let currentBold = false;
  let lastIndex = 0;

  // Find all ANSI color escape sequences
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop pattern
  while ((match = COLOR_REGEX.exec(cleaned)) !== null) {
    // Add text before this escape sequence
    if (match.index > lastIndex) {
      const text = cleaned.slice(lastIndex, match.index);
      if (text) {
        segments.push({ text, color: currentColor, bold: currentBold });
      }
    }

    // Parse the escape codes
    const result = parseColorCodes(match[1] || '');

    if (result.reset) {
      currentColor = undefined;
      currentBold = false;
    }
    if (result.color !== undefined) {
      currentColor = result.color;
    }
    if (result.bold) {
      currentBold = true;
    }
    if (result.unbold) {
      currentBold = false;
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after last escape sequence
  if (lastIndex < cleaned.length) {
    const text = cleaned.slice(lastIndex);
    if (text) {
      segments.push({ text, color: currentColor, bold: currentBold });
    }
  }

  return segments;
}

export interface AnsiTextProps {
  children: string;
}

/**
 * Renders text with ANSI color codes as colored spans
 */
export function AnsiText({ children }: AnsiTextProps): ReactNode {
  const segments = parseAnsi(children);

  if (segments.length === 0) {
    return ' ';
  }

  if (segments.length === 1 && !segments[0]?.color && !segments[0]?.bold) {
    return segments[0]?.text || ' ';
  }

  return (
    <>
      {segments.map((segment, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are derived from static input
        <span key={i} fg={segment.color}>
          {segment.text}
        </span>
      ))}
    </>
  );
}
