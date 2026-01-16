// ============================================================================
// Git & Branch Name Services
// ============================================================================

import { formatShellError, type ShellError } from "../utils";

export interface RepoInfo {
  owner: string;
  repo: string;
  fullName: string; // owner/repo
}

export async function getRepoInfo(): Promise<RepoInfo> {
  let remoteUrl: string;
  try {
    const result = await Bun.$`git remote get-url origin`.quiet();
    remoteUrl = result.stdout.toString().trim();
  } catch (err) {
    throw formatShellError(err as ShellError);
  }

  // Parse GitHub URL (supports both HTTPS and SSH formats)
  // https://github.com/owner/repo.git
  // git@github.com:owner/repo.git
  let repoPath = remoteUrl;
  repoPath = repoPath.replace(/^https:\/\/github\.com\//, "");
  repoPath = repoPath.replace(/^git@github\.com:/, "");
  repoPath = repoPath.replace(/\.git$/, "");

  const parts = repoPath.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Unable to parse GitHub repository from remote URL: ${remoteUrl}`);
  }

  return {
    owner: parts[0],
    repo: parts[1],
    fullName: repoPath,
  };
}

function isValidBranchName(name: string): boolean {
  // Must start with letter, contain only lowercase letters, numbers, hyphens
  // Must end with letter or number, max 50 chars
  if (name.length === 0 || name.length > 50) return false;
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name) && !/^[a-z]$/.test(name))
    return false;
  if (name.includes("--")) return false; // No double hyphens
  return true;
}

async function getExistingBranches(): Promise<string[]> {
  try {
    const result = await Bun.$`git branch --list`.quiet();
    return result.stdout
      .toString()
      .split("\n")
      .map((line) => line.replace(/^\*?\s*/, "").trim())
      .filter(Boolean);
  } catch (err) {
    throw formatShellError(err as ShellError);
  }
}

async function getExistingServices(): Promise<string[]> {
  try {
    const result = await Bun.$`tiger svc list -o json`.quiet();
    const services = JSON.parse(result.stdout.toString());
    return services.map((svc: { name: string }) => svc.name);
  } catch {
    // tiger CLI not available or no services, return empty array
    return [];
  }
}

async function getExistingContainers(): Promise<string[]> {
  try {
    // Get all container names (running and stopped), strip "conductor-" prefix if present
    const result = await Bun.$`docker ps -a --format {{.Names}}`.quiet();
    return result.stdout
      .toString()
      .split("\n")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => name.replace(/^conductor-/, "")); // Normalize to branch name format
  } catch {
    // Docker not available, return empty array
    return [];
  }
}

export async function generateBranchName(
  prompt: string,
  maxRetries: number = 3
): Promise<string> {
  // Gather all existing names to avoid conflicts
  const [existingBranches, existingServices, existingContainers] =
    await Promise.all([
      getExistingBranches(),
      getExistingServices(),
      getExistingContainers(),
    ]);

  const allExistingNames = new Set([
    ...existingBranches,
    ...existingServices,
    ...existingContainers,
  ]);

  let lastAttempt = "";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let claudePrompt = `Generate a git branch name for the following task: ${prompt}

Requirements:
- Output ONLY the branch name, nothing else
- Lowercase letters, numbers, and hyphens only
- No special characters, spaces, or underscores
- Keep it concise (2-4 words max)
- Example format: add-user-auth, fix-login-bug`;

    if (allExistingNames.size > 0) {
      claudePrompt += `\n\nIMPORTANT: Do NOT use any of these names (they already exist):
${[...allExistingNames].join(", ")}`;
    }

    if (lastAttempt) {
      claudePrompt += `\n\nThe name '${lastAttempt}' is invalid. Suggest a different name.`;
    }

    let result: string;
    try {
      const proc = await Bun.$`claude --model haiku -p ${claudePrompt}`.quiet();
      result = proc.stdout.toString();
    } catch (err) {
      throw formatShellError(err as ShellError);
    }
    const branchName = result.trim().toLowerCase();

    // Clean up any quotes or extra whitespace
    const cleaned = branchName.replace(/['"]/g, "").trim();

    if (!isValidBranchName(cleaned)) {
      console.log(
        `  Attempt ${attempt}: '${cleaned}' is not a valid branch name`
      );
      lastAttempt = cleaned;
      continue;
    }

    if (allExistingNames.has(cleaned)) {
      console.log(`  Attempt ${attempt}: '${cleaned}' already exists`);
      lastAttempt = cleaned;
      allExistingNames.add(cleaned); // Add to set to avoid suggesting again
      continue;
    }

    return cleaned;
  }

  throw new Error(`Failed to generate valid branch name after ${maxRetries} attempts`);
}
