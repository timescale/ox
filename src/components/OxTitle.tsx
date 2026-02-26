import { useWindowSize } from '../hooks/useWindowSize';
import { useTheme } from '../stores/themeStore';

const TITLE_MAX_WIDTH = 76;
const TITLE_PADDING = 4;

// Solid block characters get the main bright color
const SOLID_CHARS = new Set(['█', '▀', '▄', '▌', '▐', '░', '▒', '▓']);

const OX_TITLE_WIDE = [
  '██╗  ██╗███████╗██████╗ ███╗   ███╗███████╗███████╗',
  '██║  ██║██╔════╝██╔══██╗████╗ ████║██╔════╝██╔════╝',
  '███████║█████╗  ██████╔╝██╔████╔██║█████╗  ███████╗',
  '██╔══██║██╔══╝  ██╔══██╗██║╚██╔╝██║██╔══╝  ╚════██║',
  '██║  ██║███████╗██║  ██║██║ ╚═╝ ██║███████╗███████║',
  '╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝',
];

const OX_TITLE_NARROW = `
▄  ▄ ▄▄▄▄ ▄▄▄  ▄   ▄ ▄▄▄▄ ▄▄▄▄
█▄▄█ █▄▄  █▄▄▀ █▀▄▀█ █▄▄  ▀▄▄ 
█  █ █▄▄▄ █ ▀▄ █   █ █▄▄▄ ▄▄▄▀
`.trim();

type CharType = 'solid' | 'outline' | 'space';

function getCharType(char: string): CharType {
  if (char === ' ') return 'space';
  return SOLID_CHARS.has(char) ? 'solid' : 'outline';
}

function getMaxLineLength(lines: string[]) {
  return lines.reduce((max, line) => Math.max(max, line.length), 0);
}

// Parse lines into segments grouped by character type for efficient rendering
function linesToSegments(lines: string[]) {
  return lines.map((line) => {
    const segments: { text: string; type: CharType }[] = [];
    let currentType: CharType = 'space';
    let buffer = '';

    for (const char of line) {
      const charType = getCharType(char);
      if (charType !== currentType) {
        if (buffer.length > 0) {
          segments.push({ text: buffer, type: currentType });
        }
        currentType = charType;
        buffer = char;
      } else {
        buffer += char;
      }
    }

    if (buffer.length > 0) {
      segments.push({ text: buffer, type: currentType });
    }

    return segments;
  });
}

const OX_TITLE_WIDE_SEGMENTS = linesToSegments(OX_TITLE_WIDE);
const OX_TITLE_WIDE_WIDTH = getMaxLineLength(OX_TITLE_WIDE);

/**
 * Responsive ASCII art title for "ox".
 * Switches between wide and narrow versions based on terminal width.
 */
export function OxTitle() {
  const { theme } = useTheme();
  const { columns } = useWindowSize();

  const containerWidth = Math.min(
    Math.max(columns - TITLE_PADDING, 0),
    TITLE_MAX_WIDTH,
  );
  const isWideTitle = containerWidth >= OX_TITLE_WIDE_WIDTH + 10;

  return (
    <box marginBottom={2} width="100%" alignItems="center">
      {isWideTitle ? (
        <box flexDirection="column" alignItems="center">
          {OX_TITLE_WIDE_SEGMENTS.map((segments) => {
            const rowKey = segments
              .map((segment) => `${segment.type}:${segment.text}`)
              .join('|');
            let segmentOffset = 0;

            return (
              <box flexDirection="row" key={`title-row-${rowKey}`}>
                {segments.map((segment) => {
                  const fg =
                    segment.type === 'solid'
                      ? theme.text
                      : segment.type === 'outline'
                        ? theme.textMuted
                        : undefined;
                  const segmentKey = `title-segment-${rowKey}-${segment.type}-${segmentOffset}`;
                  segmentOffset += segment.text.length;
                  return (
                    <text key={segmentKey} fg={fg}>
                      {segment.text}
                    </text>
                  );
                })}
              </box>
            );
          })}
        </box>
      ) : (
        <text fg={theme.text}>{OX_TITLE_NARROW}</text>
      )}
    </box>
  );
}
