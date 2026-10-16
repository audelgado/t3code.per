import { useEffect, useRef, type ReactNode } from "react";

/**
 * Bottom sheet on phones (< 768px), centered overlay modal on desktop. Escape or a tap on the backdrop closes it.
 * `footer` is a sticky action bar (Aprobar / Rechazar ...). Focus moves in on open and returns on close.
 */
export function Sheet({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-fg/30 md:items-start md:p-6 md:pt-[8vh]" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-[22px] border border-line bg-panel shadow-[0_-10px_40px_rgba(0,0,0,.2)] outline-none md:max-h-[84dvh] md:rounded-2xl md:shadow-[0_24px_64px_rgba(0,0,0,.28)] ${wide ? "max-w-3xl" : "max-w-xl"}`}
      >
        <div aria-hidden className="mx-auto mt-2 mb-1 h-[5px] w-10 shrink-0 rounded-full bg-[#d6d3cc] md:hidden" />
        <h2 className="shrink-0 px-4 pt-3 pb-3 text-base font-semibold break-words">{title}</h2>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
        {footer && <div className="shrink-0 border-t border-line bg-panel px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
  );
}
