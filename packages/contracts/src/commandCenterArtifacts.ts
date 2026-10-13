import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { CommandCenterMemoryEntry } from "./commandCenter.ts";

// Command Center wave 4: the shared artifacts library and the per-project canvas.
// See docs/command-center/SPEC.md ("Wave 4"). Artifacts never ride the main snapshot; they page
// in through their own list and subscription.

export const CommandCenterArtifactId = TrimmedNonEmptyString.pipe(
  Schema.brand("CommandCenterArtifactId"),
);
export type CommandCenterArtifactId = typeof CommandCenterArtifactId.Type;
export const CommandCenterCanvasItemId = TrimmedNonEmptyString.pipe(
  Schema.brand("CommandCenterCanvasItemId"),
);
export type CommandCenterCanvasItemId = typeof CommandCenterCanvasItemId.Type;
export const CommandCenterCanvasEdgeId = TrimmedNonEmptyString.pipe(
  Schema.brand("CommandCenterCanvasEdgeId"),
);
export type CommandCenterCanvasEdgeId = typeof CommandCenterCanvasEdgeId.Type;

/** Largest artifact version, in UTF-8 bytes. The server checks bytes; the schema bounds characters. */
export const COMMAND_CENTER_ARTIFACT_MAX_BYTES = 5 * 1024 * 1024;

export const CommandCenterArtifactKind = Schema.Literals(["html", "markdown"]);
export type CommandCenterArtifactKind = typeof CommandCenterArtifactKind.Type;

/** Who wrote a version: the user (any client) or an agent (MCP). */
export const CommandCenterArtifactAuthor = Schema.Literals(["user", "agent"]);
export type CommandCenterArtifactAuthor = typeof CommandCenterArtifactAuthor.Type;

const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const ShortText = TrimmedString.check(Schema.isMaxLength(2_000));
const ArtifactContent = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(COMMAND_CENTER_ARTIFACT_MAX_BYTES),
);

export const CommandCenterArtifact = Schema.Struct({
  id: CommandCenterArtifactId,
  /** Null for a global artifact. */
  projectId: Schema.NullOr(ProjectId),
  title: Title,
  kind: CommandCenterArtifactKind,
  currentVersion: PositiveInt,
  /** Thread the first version came from, if any. */
  sourceThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Archived artifacts leave the default list; `setArtifactArchived` brings them back. */
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type CommandCenterArtifact = typeof CommandCenterArtifact.Type;

export const CommandCenterArtifactVersion = Schema.Struct({
  artifactId: CommandCenterArtifactId,
  version: PositiveInt,
  author: CommandCenterArtifactAuthor,
  /** Provider instance or client that wrote it ("codex", "Claude Code"), when known. */
  authorLabel: Schema.NullOr(ShortText),
  threadId: Schema.NullOr(ThreadId),
  /**
   * Stored file, as an attachment id: an HTML version renders through the asset route
   * (`assets.createUrl` with `{ _tag: "attachment", attachmentId, disposition: "inline" }`).
   */
  attachmentId: TrimmedNonEmptyString,
  sizeBytes: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type CommandCenterArtifactVersion = typeof CommandCenterArtifactVersion.Type;

const ArtifactFilterFields = {
  /** Omit for every project; null for only the global artifacts (no project). */
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  /** True lists only archived artifacts; otherwise only active ones. */
  archived: Schema.optional(Schema.Boolean),
  /** Title contains it; case is ignored for ASCII letters only (SQLite LIKE). */
  query: Schema.optional(TrimmedString.check(Schema.isMaxLength(200))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
};

/** The newest page of artifacts, re-sent after every artifact change. */
export const CommandCenterArtifactSubscribeInput = Schema.Struct(ArtifactFilterFields);
export type CommandCenterArtifactSubscribeInput = typeof CommandCenterArtifactSubscribeInput.Type;

/** One page, most recently updated first. */
export const CommandCenterArtifactListInput = Schema.Struct({
  ...ArtifactFilterFields,
  /** Only artifacts updated before this one (pass the last row of the previous page). */
  before: Schema.optional(CommandCenterArtifactId),
  /** `updatedAt` of `before`, so paging survives it changing meanwhile. */
  beforeUpdatedAt: Schema.optional(IsoDateTime),
});
export type CommandCenterArtifactListInput = typeof CommandCenterArtifactListInput.Type;

export const CommandCenterArtifactListResult = Schema.Struct({
  artifacts: Schema.Array(CommandCenterArtifact),
  hasMore: Schema.Boolean,
});
export type CommandCenterArtifactListResult = typeof CommandCenterArtifactListResult.Type;

export const CommandCenterArtifactGetInput = Schema.Struct({
  id: CommandCenterArtifactId,
  /** Omit for the current version. */
  version: Schema.optional(PositiveInt),
  /**
   * Omit to get content for Markdown only: an HTML version renders from its attachment, so its
   * source (up to 5 MiB) rides the socket only when asked for, as a diff does. True always.
   */
  includeContent: Schema.optional(Schema.Boolean),
});
export type CommandCenterArtifactGetInput = typeof CommandCenterArtifactGetInput.Type;

/** One version (content per `includeContent`) plus the artifact and its full version history. */
export const CommandCenterArtifactDetail = Schema.Struct({
  artifact: CommandCenterArtifact,
  version: CommandCenterArtifactVersion,
  /** Null when not requested (HTML by default). */
  content: Schema.NullOr(Schema.String),
  /** Newest first. */
  versions: Schema.Array(CommandCenterArtifactVersion),
});
export type CommandCenterArtifactDetail = typeof CommandCenterArtifactDetail.Type;

/**
 * Creates an artifact (no `id`; `title` required) or adds a version to one. Give the page as
 * `content`, or as `fromAttachmentId`: an `html_render` page already on this server.
 */
export const CommandCenterArtifactSaveInput = Schema.Struct({
  id: Schema.optional(CommandCenterArtifactId),
  /** Required on create; on a new version it renames the artifact. */
  title: Schema.optional(Title),
  /** Create only; defaults to html. A new version keeps the artifact's kind. */
  kind: Schema.optional(CommandCenterArtifactKind),
  /** On create defaults to no project; on a new version omitted keeps it, given moves it. */
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  content: Schema.optional(ArtifactContent),
  fromAttachmentId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  /** Thread this version came from. */
  threadId: Schema.optional(ThreadId),
});
export type CommandCenterArtifactSaveInput = typeof CommandCenterArtifactSaveInput.Type;

export const CommandCenterArtifactSaveResult = Schema.Struct({
  artifact: CommandCenterArtifact,
  version: CommandCenterArtifactVersion,
});
export type CommandCenterArtifactSaveResult = typeof CommandCenterArtifactSaveResult.Type;

/**
 * Pasted text or a dropped file (claude.ai artifacts have no sync API). Kind comes from the file
 * extension or the content; the title from `title`, the page's `<title>` or first heading, or
 * the file name.
 */
export const CommandCenterArtifactImportInput = Schema.Struct({
  content: ArtifactContent,
  fileName: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
  title: Schema.optional(Title),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
});
export type CommandCenterArtifactImportInput = typeof CommandCenterArtifactImportInput.Type;

/** Restoring copies an older version's content into a new current version; history stays. */
export const CommandCenterArtifactRestoreVersionInput = Schema.Struct({
  id: CommandCenterArtifactId,
  version: PositiveInt,
});
export type CommandCenterArtifactRestoreVersionInput =
  typeof CommandCenterArtifactRestoreVersionInput.Type;

export const CommandCenterArtifactSetArchivedInput = Schema.Struct({
  id: CommandCenterArtifactId,
  archived: Schema.Boolean,
});
export type CommandCenterArtifactSetArchivedInput =
  typeof CommandCenterArtifactSetArchivedInput.Type;

export const CommandCenterArtifactThumbnailInput = Schema.Struct({
  id: CommandCenterArtifactId,
  version: PositiveInt,
});
export type CommandCenterArtifactThumbnailInput = typeof CommandCenterArtifactThumbnailInput.Type;

/**
 * An image attachment (render it with `assets.createUrl`, `{ _tag: "attachment" }`), made once
 * per version on first request; null when this server cannot capture pages.
 */
export const CommandCenterArtifactThumbnail = Schema.Struct({
  attachmentId: Schema.NullOr(TrimmedNonEmptyString),
});
export type CommandCenterArtifactThumbnail = typeof CommandCenterArtifactThumbnail.Type;

// Canvas: one board per project. Cards point at artifacts, sections or memory entries by id, or
// hold their own text (`note`). Positions are integer CSS pixels.

export const CommandCenterCanvasItemKind = Schema.Literals([
  "artifact",
  "section",
  "memory",
  "note",
]);
export type CommandCenterCanvasItemKind = typeof CommandCenterCanvasItemKind.Type;

const Coordinate = Schema.Int.check(Schema.isBetween({ minimum: -100_000, maximum: 100_000 }));
const Size = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }));

const CanvasItemFields = {
  kind: CommandCenterCanvasItemKind,
  /** Id of the artifact, section or memory entry; null for a note. */
  refId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  /** A note's text. */
  text: Schema.NullOr(ShortText),
  x: Coordinate,
  y: Coordinate,
  /** Null sizes the card by its content. */
  w: Schema.NullOr(Size),
  h: Schema.NullOr(Size),
};

const CanvasEdgeFields = {
  fromItemId: CommandCenterCanvasItemId,
  toItemId: CommandCenterCanvasItemId,
  label: Schema.NullOr(TrimmedString.check(Schema.isMaxLength(200))),
};

const timestamps = { createdAt: IsoDateTime, updatedAt: IsoDateTime };

export const CommandCenterCanvasItem = Schema.Struct({
  id: CommandCenterCanvasItemId,
  projectId: ProjectId,
  ...CanvasItemFields,
  ...timestamps,
});
export type CommandCenterCanvasItem = typeof CommandCenterCanvasItem.Type;

export const CommandCenterCanvasEdge = Schema.Struct({
  id: CommandCenterCanvasEdgeId,
  projectId: ProjectId,
  ...CanvasEdgeFields,
  ...timestamps,
});
export type CommandCenterCanvasEdge = typeof CommandCenterCanvasEdge.Type;

export const CommandCenterCanvasGetInput = Schema.Struct({ projectId: ProjectId });
export type CommandCenterCanvasGetInput = typeof CommandCenterCanvasGetInput.Type;

/**
 * A project's board. `artifacts` and `memory` are the rows its cards point at (archived ones
 * included), so cards resolve even when the row is outside the snapshot or the artifact page.
 * Sections come from the snapshot, which holds them all.
 */
export const CommandCenterCanvas = Schema.Struct({
  items: Schema.Array(CommandCenterCanvasItem),
  edges: Schema.Array(CommandCenterCanvasEdge),
  artifacts: Schema.Array(CommandCenterArtifact),
  memory: Schema.Array(CommandCenterMemoryEntry),
});
export type CommandCenterCanvas = typeof CommandCenterCanvas.Type;

/** Most cards one board holds; boards are not virtualized. */
export const COMMAND_CENTER_CANVAS_ITEM_LIMIT = 200;

/** Moves a card without touching its other fields, so a stale client cannot revert them. */
export const CommandCenterCanvasItemMove = Schema.Struct({
  id: CommandCenterCanvasItemId,
  x: Coordinate,
  y: Coordinate,
});
export type CommandCenterCanvasItemMove = typeof CommandCenterCanvasItemMove.Type;

/**
 * Creates (no `id`) or replaces cards; a known `id` restores a deleted card under that id. A
 * move (`{ id, x, y }`) changes only the position, and skips a card that no longer exists.
 */
export const CommandCenterCanvasUpsertItemsInput = Schema.Struct({
  projectId: ProjectId,
  items: Schema.Array(
    Schema.Union([
      Schema.Struct({ id: Schema.optional(CommandCenterCanvasItemId), ...CanvasItemFields }),
      CommandCenterCanvasItemMove,
    ]),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(COMMAND_CENTER_CANVAS_ITEM_LIMIT)),
});
export type CommandCenterCanvasUpsertItemsInput = typeof CommandCenterCanvasUpsertItemsInput.Type;

export const CommandCenterCanvasUpsertItemsResult = Schema.Struct({
  items: Schema.Array(CommandCenterCanvasItem),
});
export type CommandCenterCanvasUpsertItemsResult = typeof CommandCenterCanvasUpsertItemsResult.Type;

/** Both ends must be cards on the same board. */
export const CommandCenterCanvasUpsertEdgesInput = Schema.Struct({
  projectId: ProjectId,
  edges: Schema.Array(
    Schema.Struct({ id: Schema.optional(CommandCenterCanvasEdgeId), ...CanvasEdgeFields }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type CommandCenterCanvasUpsertEdgesInput = typeof CommandCenterCanvasUpsertEdgesInput.Type;

export const CommandCenterCanvasUpsertEdgesResult = Schema.Struct({
  edges: Schema.Array(CommandCenterCanvasEdge),
});
export type CommandCenterCanvasUpsertEdgesResult = typeof CommandCenterCanvasUpsertEdgesResult.Type;

/** Removing a card also removes its edges. */
export const CommandCenterCanvasDeleteInput = Schema.Struct({
  projectId: ProjectId,
  itemIds: Schema.Array(CommandCenterCanvasItemId).check(Schema.isMaxLength(500)),
  edgeIds: Schema.Array(CommandCenterCanvasEdgeId).check(Schema.isMaxLength(500)),
});
export type CommandCenterCanvasDeleteInput = typeof CommandCenterCanvasDeleteInput.Type;

/** The removed rows; upserting them again (with their ids) is the undo. */
export const CommandCenterCanvasDeleteResult = Schema.Struct({
  items: Schema.Array(CommandCenterCanvasItem),
  edges: Schema.Array(CommandCenterCanvasEdge),
});
export type CommandCenterCanvasDeleteResult = typeof CommandCenterCanvasDeleteResult.Type;
