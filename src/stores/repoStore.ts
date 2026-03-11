import { create } from 'zustand';
import type { RepoInfo } from '../services/git.ts';

export interface RepoState {
  /** Full repo info, or null if not in a git repo */
  repoInfo: RepoInfo | null;
  /** Convenience: whether we're in a git repo */
  isGitRepo: boolean;
  /** Convenience: owner/repo string, or undefined */
  fullName: string | undefined;
  /** Seed the store with already-fetched repo info (called once before render) */
  initialize: (repoInfo: RepoInfo | null) => void;
}

export const useRepoStore = create<RepoState>()((set) => ({
  repoInfo: null,
  isGitRepo: false,
  fullName: undefined,

  initialize: (repoInfo) => {
    set({
      repoInfo,
      isGitRepo: repoInfo !== null,
      fullName: repoInfo?.fullName,
    });
  },
}));
