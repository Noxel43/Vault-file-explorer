import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useExplorer } from "../store/explorer";
import { useUi } from "../store/ui";

export function ConfirmDialog() {
  const confirm = useUi((s) => s.confirm);
  const close = useUi((s) => s.closeConfirm);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirm) btnRef.current?.focus();
  }, [confirm]);

  if (!confirm) return null;
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal confirm"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") close();
        }}
      >
        <h3>{confirm.title}</h3>
        <p>{confirm.message}</p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={close}>Cancel</button>
          <button
            ref={btnRef}
            className={`btn ${confirm.danger ? "danger" : "primary"}`}
            onClick={() => {
              close();
              confirm.onConfirm();
            }}
          >
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useExplorer((s) => s.toasts);
  const dismiss = useExplorer((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.text}</span>
          <button onClick={() => dismiss(t.id)}>
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
