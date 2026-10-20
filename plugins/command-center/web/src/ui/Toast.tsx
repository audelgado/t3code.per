import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

interface ToastState {
  text: string;
  action?: { label: string; onClick: () => void };
}

let current: ToastState | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const subs = new Set<() => void>();
const set = (t: ToastState | null) => {
  current = t;
  subs.forEach((f) => f());
};

const dismiss = () => {
  clearTimeout(timer);
  set(null);
};
const pause = () => clearTimeout(timer);
const resume = () => {
  clearTimeout(timer);
  if (current && !current.action) timer = setTimeout(dismiss, 5000);
};

/** Los avisos con acciones permanecen hasta usarlos o cerrarlos. */
export function toast(text: string, action?: ToastState["action"]) {
  clearTimeout(timer);
  set({ text, action });
  resume();
}

export function Toaster() {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    const update = () => setDialog(Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).at(-1) ?? null);
    update();
    // Un diálogo modal vuelve inerte el resto de la página, incluidos los avisos.
    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.type === "attributes" || [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element && (node.matches("dialog") || node.querySelector("dialog"))))) update();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    return () => observer.disconnect();
  }, []);
  const t = useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => current,
  );
  return createPortal(
    <div role="status" aria-atomic="true" onMouseEnter={pause} onMouseLeave={resume} onFocus={pause} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) resume(); }} className={t ? "fixed bottom-[max(6rem,calc(env(safe-area-inset-bottom)+5rem))] left-1/2 z-[70] flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-[10px] bg-fg px-3.5 py-2 text-[13px] text-white shadow-[0_8px_24px_rgba(0,0,0,.25)] md:bottom-6" : "sr-only"}>
      <span className="min-w-0 break-words">{t?.text}</span>
      {t?.action && (
        <button type="button" className="rounded px-1 py-2 font-semibold text-[#93c5fd] hover:underline" onClick={() => { const action = t.action; dismiss(); action?.onClick(); }}>
          {t.action.label}
        </button>
      )}
      {t && <button type="button" aria-label="Cerrar aviso" className="rounded px-2 py-2 hover:bg-white/15" onClick={dismiss}>×</button>}
    </div>,
    dialog ?? document.body,
  );
}
