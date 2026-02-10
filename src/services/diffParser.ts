export interface FileDiff {
  /** File path (e.g., 'src/services/docker.ts') */
  path: string;
  /** The full diff chunk for this file (including the 'diff --git' header) */
  diff: string;
}

/**
 * Parse a unified diff into per-file chunks.
 * Splits on 'diff --git a/... b/...' headers.
 */
export function parseUnifiedDiff(rawDiff: string): FileDiff[] {
  if (!rawDiff || rawDiff === '(no diff)') {
    return [];
  }

  const files: FileDiff[] = [];
  // Split on diff --git headers, keeping the delimiter via lookahead
  const parts = rawDiff.split(/(?=^diff --git )/m);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Extract file path from 'diff --git a/path b/path'
    const headerMatch = trimmed.match(/^diff --git a\/(.+?) b\/(.+)/);
    if (headerMatch) {
      const path = headerMatch[2] ?? headerMatch[1] ?? 'unknown';
      files.push({ path, diff: trimmed });
    }
  }

  return files;
}
