import { SparklesIcon, WandSparklesIcon } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";

import { fnv1a32 } from "~/lib/diffRendering";
import { Button } from "../../../ui/button";
import { Spinner } from "../../../ui/spinner";
import { cleanupText, estimateTokens, formatTokens } from "./textLogic";

// The diff renderer is heavy; load it only when a rewrite is up for review.
const ArtifactDiff = lazy(() =>
  import("../../artifacts/ArtifactDiff").then((module) => ({ default: module.ArtifactDiff })),
);

export type TextOptimizerKind = "prompt" | "skill";

/** Asks the cheap text model for a shorter version; resolves null when it failed (and said so). */
export type TextRewrite = (text: string, kind: TextOptimizerKind) => Promise<string | null>;

type RewriteState =
  | { readonly status: "idle" }
  | { readonly status: "pending" }
  | { readonly status: "review"; readonly base: string; readonly proposal: string };

/**
 * Sits under the field that edits `value`: a token estimate, "Optimize" (free cleanup of spacing
 * and repeated lines) and, when `rewrite` is given, "Rewrite shorter", which shows a diff to
 * accept or discard. Nothing runs until the user clicks.
 */
export function TextOptimizer({
  value,
  onChange,
  kind,
  rewrite,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly kind: TextOptimizerKind;
  readonly rewrite?: TextRewrite | undefined;
}) {
  const cleanup = useMemo(() => cleanupText(value), [value]);
  const [lastCleanup, setLastCleanup] = useState<{ text: string; note: string } | null>(null);
  const [rewriteState, setRewriteState] = useState<RewriteState>({ status: "idle" });
  const tokens = estimateTokens(value);

  const optimize = () => {
    const saved = tokens - estimateTokens(cleanup.text);
    const parts = [
      cleanup.removedLines > 0
        ? `Removed ${cleanup.removedLines} repeated line${cleanup.removedLines === 1 ? "" : "s"}`
        : "Tidied spacing",
      saved > 0 ? `saved ${formatTokens(saved)}` : null,
    ];
    setLastCleanup({ text: cleanup.text, note: parts.filter((part) => part !== null).join(", ") });
    onChange(cleanup.text);
  };

  const startRewrite = async () => {
    if (rewrite === undefined || rewriteState.status === "pending") return;
    const base = value;
    setRewriteState({ status: "pending" });
    const proposal = await rewrite(base, kind);
    setRewriteState(
      proposal === null || proposal.trim() === base.trim()
        ? { status: "idle" }
        : { status: "review", base, proposal },
    );
  };

  const review = rewriteState.status === "review" ? rewriteState : null;
  const stale = review !== null && review.base !== value;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span aria-live="polite">
          {formatTokens(tokens)}
          {lastCleanup !== null && lastCleanup.text === value ? ` · ${lastCleanup.note}` : null}
        </span>
        <div className="ms-auto flex items-center gap-1">
          <Button
            variant="ghost-muted"
            size="xs"
            disabled={cleanup.text === value}
            title="Free: trims spacing and drops repeated lines"
            onClick={optimize}
          >
            <SparklesIcon />
            Optimize
          </Button>
          {rewrite !== undefined ? (
            <Button
              variant="ghost-muted"
              size="xs"
              disabled={value.trim() === "" || rewriteState.status !== "idle"}
              title="Uses your text generation model; you review the result first"
              onClick={() => void startRewrite()}
            >
              {rewriteState.status === "pending" ? <Spinner size="xs" /> : <WandSparklesIcon />}
              Rewrite shorter
            </Button>
          ) : null}
        </div>
      </div>
      {review !== null ? (
        <div className="space-y-2 rounded-md border">
          <div className="max-h-80 overflow-auto">
            <Suspense fallback={<p className="p-3 text-xs text-muted-foreground">Loading diff…</p>}>
              <ArtifactDiff
                kind="markdown"
                before={review.base}
                after={review.proposal}
                cacheKey={`rewrite:${fnv1a32(review.base).toString(36)}:${fnv1a32(review.proposal).toString(36)}`}
              />
            </Suspense>
          </div>
          <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs text-muted-foreground">
            <span>
              {stale
                ? "The text changed since the rewrite started."
                : `${formatTokens(estimateTokens(review.base))} → ${formatTokens(estimateTokens(review.proposal))}`}
            </span>
            <div className="ms-auto flex items-center gap-1">
              <Button
                variant="outline"
                size="xs"
                onClick={() => setRewriteState({ status: "idle" })}
              >
                Discard
              </Button>
              <Button
                size="xs"
                disabled={stale}
                onClick={() => {
                  onChange(review.proposal);
                  setRewriteState({ status: "idle" });
                }}
              >
                Use rewrite
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
