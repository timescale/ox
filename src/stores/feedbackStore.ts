import { create } from 'zustand';
import { useCommandStore } from '../services/commands.tsx';

export interface FeedbackState {
  isOpen: boolean;
  _resumeCommands: (() => void) | null;
  open: () => void;
  close: () => void;
}

export const useFeedbackStore = create<FeedbackState>()((set) => ({
  isOpen: false,
  _resumeCommands: null,

  open: () => {
    const resume = useCommandStore.getState().suspend();
    set({ isOpen: true, _resumeCommands: resume });
  },

  close: () => {
    set((state) => {
      state._resumeCommands?.();
      return { isOpen: false, _resumeCommands: null };
    });
  },
}));
