// ============================================================================
// Shared CLI Utilities
// ============================================================================

export interface ShellError extends Error {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export function formatShellError(error: ShellError): Error {
  const stdout = error.stdout?.toString().trim();
  const stderr = error.stderr?.toString().trim();
  const details = [
    stderr && `stderr: ${stderr}`,
    stdout && `stdout: ${stdout}`,
  ]
    .filter(Boolean)
    .join("\n");

  return new Error(
    `Command failed (exit code ${error.exitCode})${details ? `\n${details}` : ""}`
  );
}

export async function ensureGitignore(): Promise<void> {
  const gitignorePath = ".gitignore";
  const entry = ".conductor/";

  const file = Bun.file(gitignorePath);
  let content = "";

  if (await file.exists()) {
    content = await file.text();
  }

  // Check if .conductor/ is already in gitignore
  const lines = content.split("\n");
  const hasEntry = lines.some(
    (line) => line.trim() === ".conductor/" || line.trim() === ".conductor"
  );

  if (!hasEntry) {
    // Append entry, ensuring there's a newline before it if file doesn't end with one
    const newContent = content.endsWith("\n") || content === ""
      ? content + entry + "\n"
      : content + "\n" + entry + "\n";

    await Bun.write(gitignorePath, newContent);
    console.log("  Added .conductor/ to .gitignore");
  }
}
