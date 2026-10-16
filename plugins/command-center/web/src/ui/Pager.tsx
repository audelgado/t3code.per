import { ChevronLeft, ChevronRight } from "lucide-react";
import { fmtNumber } from "../look.ts";
import { Button } from "./Button.tsx";

interface PageInfo {
  page: number;
  pageCount: number;
  total: number;
  start: number;
  end: number;
}

/** History only: actionable items are never paged. Controls only the loaded collection; cursor-backed screens keep their server cursors. */
export function Pager({ page, onPageChange, label = "Elementos" }: { page: PageInfo; onPageChange: (page: number) => void; label?: string }) {
  if (page.pageCount <= 1) return null;
  return (
    <nav aria-label={`Páginas de ${label.toLowerCase()}`} className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
      <p aria-live="polite" aria-atomic="true" className="text-xs text-muted-fg tabular-nums">
        {fmtNumber(page.start)}–{fmtNumber(page.end)} de {fmtNumber(page.total)}
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" aria-label={`Página anterior de ${label.toLowerCase()}`} disabled={page.page <= 1} onClick={() => onPageChange(page.page - 1)}>
          <ChevronLeft className="size-4" aria-hidden /> Anterior
        </Button>
        <span className="text-xs text-muted-fg tabular-nums">Página {page.page} de {page.pageCount}</span>
        <Button size="sm" variant="ghost" aria-label={`Página siguiente de ${label.toLowerCase()}`} disabled={page.page >= page.pageCount} onClick={() => onPageChange(page.page + 1)}>
          Siguiente <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
