// ============================================================================
// Theme Store - Zustand store for theme state management
// ============================================================================

import { create } from 'zustand';
import {
  projectConfig,
  readConfigValue,
  userConfig,
} from '../services/config.ts';
import { log } from '../services/logger.ts';
import { readOpencodeTheme } from '../services/opencode.ts';
import {
  DEFAULT_THEME_NAME,
  getTheme,
  getThemeNames,
  type ThemeColors,
} from '../services/theme.ts';

// ============================================================================
// Persistence
// ============================================================================

async function loadPersistedTheme(): Promise<string | null> {
  try {
    const oxTheme = (await readConfigValue('themeName')) || null;
    if (oxTheme) return oxTheme;
  } catch (error) {
    log.error({ error }, 'Failed to load persisted theme');
    // Ignore errors, fall through to opencode theme
  }

  // Fall back to OpenCode's theme preference if no ox theme is configured
  return await readOpencodeTheme();
}

async function persistTheme(themeName: string): Promise<void> {
  try {
    // If project config has a theme set, update project config
    // Otherwise, update user config (default)
    const projectTheme = await projectConfig.readValue('themeName');
    if (projectTheme !== undefined) {
      await projectConfig.writeValue('themeName', themeName);
    } else {
      await userConfig.writeValue('themeName', themeName);
    }
  } catch (error) {
    log.error({ error }, 'Failed to persist theme');
  }
}

// ============================================================================
// Store
// ============================================================================

export interface ThemeState {
  /** Current theme name */
  themeName: string;

  /** Resolved theme colors */
  theme: ThemeColors;

  /** Whether the store has been initialized from persisted state */
  initialized: boolean;

  /** Set the current theme by name */
  setTheme: (name: string) => void;

  /** Initialize the store from persisted state */
  initialize: () => Promise<void>;

  /** Get all available theme names */
  getThemeNames: () => string[];
}

export const useTheme = create<ThemeState>()((set, get) => ({
  themeName: DEFAULT_THEME_NAME,
  theme: getTheme(DEFAULT_THEME_NAME),
  initialized: false,

  setTheme: (name: string) => {
    const themeNames = getThemeNames();
    const validName = themeNames.includes(name) ? name : DEFAULT_THEME_NAME;
    const theme = getTheme(validName);

    set({ themeName: validName, theme });

    // Persist in background
    persistTheme(validName);
  },

  initialize: async () => {
    if (get().initialized) return;

    const persistedName = await loadPersistedTheme();
    if (persistedName) {
      const theme = getTheme(persistedName);
      set({ themeName: persistedName, theme, initialized: true });
    } else {
      set({ initialized: true });
    }
  },

  getThemeNames,
}));
