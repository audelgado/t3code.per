import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { CommandCenterArtifactKind } from "@t3tools/contracts";
import { useMemo } from "react";

import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { DiffWorkerPoolProvider } from "../../DiffWorkerPoolProvider";
import { DIFF_VIEW_UNSAFE_CSS } from "../../diffs/StyledDiffCodeView";

/** Source diff between two versions of one artifact, drawn by the app's diff renderer. */
export function ArtifactDiff({
  kind,
  before,
  after,
  cacheKey,
}: {
  readonly kind: CommandCenterArtifactKind;
  readonly before: string;
  readonly after: string;
  /** Stable per version pair, so the renderer's highlight cache can reuse work. */
  readonly cacheKey: string;
}) {
  const { resolvedTheme } = useTheme();
  const name = kind === "html" ? "artifact.html" : "artifact.md";
  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        { name, contents: before, cacheKey: `${cacheKey}:before` },
        { name, contents: after, cacheKey: `${cacheKey}:after` },
      ),
    [after, before, cacheKey, name],
  );
  const options = useMemo(
    () => ({
      diffStyle: "unified" as const,
      lineDiffType: "word" as const,
      overflow: "wrap" as const,
      disableFileHeader: true,
      hunkSeparators: "simple" as const,
      theme: resolveDiffThemeName(resolvedTheme),
      themeType: resolvedTheme,
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
      unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
    }),
    [resolvedTheme],
  );
  if (fileDiff.hunks.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">These versions are identical.</p>;
  }
  return (
    <DiffWorkerPoolProvider>
      <FileDiff fileDiff={fileDiff} options={options} />
    </DiffWorkerPoolProvider>
  );
}
