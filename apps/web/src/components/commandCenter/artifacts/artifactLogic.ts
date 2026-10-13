import {
  COMMAND_CENTER_ARTIFACT_MAX_BYTES,
  type CommandCenterArtifact,
  type CommandCenterArtifactVersion,
} from "@t3tools/contracts";

/** Rows per page, for the live newest page and each older page. */
export const ARTIFACT_PAGE_SIZE = 30;

/**
 * The live newest page, then older pages minus anything the live page now holds (an artifact
 * updated meanwhile moved up into it). Both are newest-updated first.
 */
export function mergeArtifactPages(
  live: ReadonlyArray<CommandCenterArtifact>,
  older: ReadonlyArray<CommandCenterArtifact>,
): ReadonlyArray<CommandCenterArtifact> {
  if (older.length === 0) return live;
  const seen = new Set(live.map((artifact) => artifact.id));
  return [...live, ...older.filter((artifact) => !seen.has(artifact.id))];
}

/** Value cursor for the page after `rows`; undefined when there is nothing to page from. */
export function nextArtifactCursor(rows: ReadonlyArray<CommandCenterArtifact>) {
  const last = rows.at(-1);
  return last === undefined ? undefined : { before: last.id, beforeUpdatedAt: last.updatedAt };
}

/**
 * Identity of the live page's oldest row. Older pages were fetched after it, so once it changes
 * (a new artifact pushed rows out of the live page) they may have a gap and are dropped.
 */
export function livePageBoundary(live: ReadonlyArray<CommandCenterArtifact>): string {
  const last = live.at(-1);
  return last === undefined ? "" : `${last.id}@${last.updatedAt}`;
}

/** The version just before `version` in a newest-first history, to diff against. */
export function previousArtifactVersion(
  versions: ReadonlyArray<CommandCenterArtifactVersion>,
  version: number,
): number | null {
  let previous: number | null = null;
  for (const entry of versions) {
    if (entry.version < version && (previous === null || entry.version > previous)) {
      previous = entry.version;
    }
  }
  return previous;
}

const IMPORTABLE_EXTENSION = /\.(?:html?|md|markdown|txt)$/i;
const IMPORTABLE_TYPE = /^text\/(?:html|markdown|x-markdown|plain)$/;

/** Why a dropped or picked file cannot be imported, or null when it can. */
export function artifactImportFileError(file: {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}): string | null {
  if (!IMPORTABLE_EXTENSION.test(file.name) && !IMPORTABLE_TYPE.test(file.type)) {
    return `${file.name} is not an HTML or Markdown file.`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > COMMAND_CENTER_ARTIFACT_MAX_BYTES) return `${file.name} is larger than 5 MB.`;
  return null;
}

/** Why pasted text cannot be imported, or null when it can. The server checks UTF-8 bytes. */
export function artifactImportTextError(text: string): string | null {
  if (text.trim() === "") return "Paste some HTML or Markdown first.";
  if (new TextEncoder().encode(text).length > COMMAND_CENTER_ARTIFACT_MAX_BYTES) {
    return "The page is larger than 5 MB.";
  }
  return null;
}
