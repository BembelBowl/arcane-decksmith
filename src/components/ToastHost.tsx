import { useEffect, useState } from "react";
import { subscribeToasts, type ToastMessage } from "../toast";

const DURATION_MS: Record<ToastMessage["kind"], number> = {
  success: 2600,
  info: 3200,
  error: 7000
};

export default function ToastHost() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => subscribeToasts(toast => {
    setToasts(current => [...current.slice(-3), toast]);
    setTimeout(() => {
      setToasts(current => current.filter(item => item.id !== toast.id));
    }, DURATION_MS[toast.kind]);
  }), []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`toast toast-${toast.kind}`}
          role={toast.kind === "error" ? "alert" : "status"}
        >
          <span>{toast.message}</span>
          <button
            type="button"
            className="toast-close"
            aria-label="Meldung schließen"
            onClick={() => setToasts(current => current.filter(item => item.id !== toast.id))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
