import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../ui/button";

/** Shared paging controls for Command Center collections; `children` sits between count and pages. */
export function CollectionPager({
  page,
  pageCount,
  total,
  start,
  end,
  label,
  onPageChange,
  disabled = false,
  children,
}: {
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly onPageChange: (page: number) => void;
  readonly disabled?: boolean;
  readonly children?: ReactNode;
}) {
  // A single page needs no pager; the list or its empty state already says what is there.
  if (pageCount <= 1 && children === undefined) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-2">
      <span className="text-xs tabular-nums text-muted-foreground" role="status">
        {start}–{end} of {total} {label}
      </span>
      {children}
      {pageCount > 1 ? (
        <nav className="flex items-center gap-2" aria-label={`${label} pages`}>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Previous ${label} page`}
            disabled={disabled || page === 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeftIcon />
          </Button>
          <span className="text-xs tabular-nums">
            {page} / {pageCount}
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Next ${label} page`}
            disabled={disabled || page === pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRightIcon />
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
