import { useEffect, useRef, type ReactNode } from "react";

/**
 * Bottom sheet on phones (< 768px), centered overlay modal on desktop. Escape or a tap on the backdrop closes it.
 * `footer` is a sticky action bar (Aprobar / Rechazar ...). Focus moves in on open and returns on close.
 */
export function Sheet({ title, onClose, children, footer, header, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; header?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog ref={ref} aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }} className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-y-auto bg-transparent p-0 text-fg backdrop:bg-fg/30">
    <div className="flex min-h-full items-end justify-center md:items-start md:p-6 md:pt-[8vh]" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        className={`flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-[22px] border border-line bg-panel shadow-[0_-10px_40px_rgba(0,0,0,.2)] md:max-h-[84dvh] md:rounded-2xl md:shadow-[0_24px_64px_rgba(0,0,0,.28)] ${wide ? "max-w-3xl" : "max-w-xl"}`}
      >
        <div aria-hidden className="mx-auto mt-2 mb-1 h-[5px] w-10 shrink-0 rounded-full bg-[#d6d3cc] md:hidden" />
        {header ? <header className="flex shrink-0 items-center gap-1 border-b border-line px-4 py-3">{header}</header> : <div className="flex shrink-0 items-center gap-3 px-4 py-3"><h2 className="min-w-0 flex-1 text-base font-semibold break-words">{title}</h2><button type="button" autoFocus onClick={onClose} className="rounded-ctl border border-line px-3 py-2 text-sm hover:bg-soft">Cerrar</button></div>}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
        {footer && <div className="shrink-0 border-t border-line bg-panel px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
    </dialog>
  );
}
