import { create } from 'zustand';
import type { ToastType } from '../components/Toast.tsx';

export interface ToastMessage {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

export interface ToastState {
  current: ToastMessage | null;
  show: (message: string, type: ToastType, duration?: number) => void;
  dismiss: () => void;
}

export const useToastStore = create<ToastState>()((set) => ({
  current: null,

  show: (message: string, type: ToastType, duration?: number) => {
    set({
      current: {
        id: crypto.randomUUID(),
        message,
        type,
        duration,
      },
    });
  },

  dismiss: () => {
    set({ current: null });
  },
}));
