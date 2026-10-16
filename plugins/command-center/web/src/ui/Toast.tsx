import { useSyncExternalStore } from "react";

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

/** Show a toast for 5 seconds (one at a time). `action` is for undo-style buttons. Mount <Toaster /> once (App does). */
export function toast(text: string, action?: ToastState["action"]) {
  clearTimeout(timer);
  set({ text, action });
  timer = setTimeout(() => set(null), 5000);
}

export function Toaster() {
  const t = useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => current,
  );
  if (!t) return null;
  return (
    <div role="status" className="fixed bottom-24 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-[10px] bg-fg px-3.5 py-2 text-[13px] text-white shadow-[0_8px_24px_rgba(0,0,0,.25)] md:bottom-6">
      <span>{t.text}</span>
      {t.action && (
        <button type="button" className="font-semibold text-[#93c5fd]" onClick={() => { t.action!.onClick(); set(null); }}>
          {t.action.label}
        </button>
      )}
    </div>
  );
}
