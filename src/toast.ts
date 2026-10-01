export type ToastKind = "success" | "error" | "info";

export interface ToastMessage {
  id: number;
  message: string;
  kind: ToastKind;
}

type Listener = (toast: ToastMessage) => void;

const listeners = new Set<Listener>();
let nextId = 1;

/** Zeigt eine nicht-blockierende Meldung an (Ersatz für `alert()`). */
export function showToast(message: string, kind: ToastKind = "info") {
  const toast = { id: nextId++, message, kind };
  for (const listener of listeners) listener(toast);
  if (listeners.size === 0 && kind === "error") console.error(message);
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
