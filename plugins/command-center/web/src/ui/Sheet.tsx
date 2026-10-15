import { useEffect, useRef, type ReactNode } from "react";

/** Bottom sheet. Escape or a tap on the backdrop closes it. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85dvh] w-full max-w-xl overflow-y-auto rounded-t-2xl border border-border bg-bg p-4 pb-[max(1rem,env(safe-area-inset-bottom))] outline-none"
      >
        <h2 className="mb-3 text-base font-semibold break-words">{title}</h2>
        {children}
      </div>
    </div>
  );
}
