import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./Button.tsx";

interface PageInfo {
  page: number;
  pageCount: number;
  total: number;
  start: number;
  end: number;
}

/** Controls only the loaded collection; cursor-backed screens keep their server cursors. */
export function Pager({ page, onPageChange, label = "Items" }: { page: PageInfo; onPageChange: (page: number) => void; label?: string }) {
  if (page.pageCount <= 1) return null;
  return (
    <nav aria-label={`${label} pages`} className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
      <p aria-live="polite" aria-atomic="true" className="text-xs tabular-nums text-muted-fg">
        {page.start}–{page.end} of {page.total}
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" aria-label={`Previous ${label.toLowerCase()} page`} disabled={page.page <= 1} onClick={() => onPageChange(page.page - 1)}>
          <ChevronLeft className="size-4" aria-hidden /> Previous
        </Button>
        <span className="text-xs tabular-nums text-muted-fg">{page.page} / {page.pageCount}</span>
        <Button size="sm" variant="ghost" aria-label={`Next ${label.toLowerCase()} page`} disabled={page.page >= page.pageCount} onClick={() => onPageChange(page.page + 1)}>
          Next <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
