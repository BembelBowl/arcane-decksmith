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

const lastNotified = new Map<string, number>();

/** Wie showToast, aber höchstens einmal pro Zeitfenster je Schlüssel (für Hintergrundfehler). */
export function notifyOnce(key: string, message: string, kind: ToastKind = "info", windowMs = 5 * 60 * 1000) {
  const now = Date.now();
  const last = lastNotified.get(key) ?? 0;
  if (now - last < windowMs) return;
  lastNotified.set(key, now);
  showToast(message, kind);
}
