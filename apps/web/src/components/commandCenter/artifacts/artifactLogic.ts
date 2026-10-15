import {
  COMMAND_CENTER_ARTIFACT_MAX_BYTES,
  type CommandCenterArtifact,
  type CommandCenterArtifactVersion,
} from "@t3tools/contracts";

/** Rows per page, for the live newest page and each older page. */
export const ARTIFACT_PAGE_SIZE = 30;

/**
 * The live newest page, then the loaded rows that still sort after it (server order: updatedAt,
 * then id, both descending). `loaded` holds every row shown when the last older page was fetched,
 * live rows included, so a row a new artifact pushes out of the live page stays. A loaded row the
 * live page now holds (updated meanwhile) or should hold but does not (archived, renamed out of
 * the search) is dropped.
 */
export function mergeArtifactPages(
  live: ReadonlyArray<CommandCenterArtifact>,
  loaded: ReadonlyArray<CommandCenterArtifact>,
): ReadonlyArray<CommandCenterArtifact> {
  const last = live.at(-1);
  if (loaded.length === 0 || last === undefined) return live;
  const seen = new Set(live.map((artifact) => artifact.id));
  const afterLive = (row: CommandCenterArtifact) =>
    row.updatedAt < last.updatedAt || (row.updatedAt === last.updatedAt && row.id < last.id);
  return [...live, ...loaded.filter((row) => !seen.has(row.id) && afterLive(row))];
}

/** Value cursor for the page after `rows`; undefined when there is nothing to page from. */
export function nextArtifactCursor(rows: ReadonlyArray<CommandCenterArtifact>) {
  const last = rows.at(-1);
  return last === undefined ? undefined : { before: last.id, beforeUpdatedAt: last.updatedAt };
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
