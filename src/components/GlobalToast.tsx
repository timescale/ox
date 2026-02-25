import { useToastStore } from '../stores/toastStore.ts';
import { Toast } from './Toast.tsx';

export function GlobalToast() {
  const current = useToastStore((s) => s.current);
  const dismiss = useToastStore((s) => s.dismiss);

  if (!current) return null;

  return (
    <Toast
      message={current.message}
      type={current.type}
      duration={current.duration}
      onDismiss={dismiss}
    />
  );
}
