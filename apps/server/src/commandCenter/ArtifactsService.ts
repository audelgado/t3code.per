import {
  COMMAND_CENTER_ARTIFACT_MAX_BYTES,
  COMMAND_CENTER_CANVAS_ITEM_LIMIT,
  CommandCenterArtifact,
  CommandCenterArtifactListResult,
  CommandCenterArtifactVersion,
  CommandCenterCanvas,
  CommandCenterCanvasEdge,
  CommandCenterCanvasItem,
  CommandCenterError,
  type CommandCenterArtifactAuthor,
  type CommandCenterArtifactDetail,
  type CommandCenterArtifactGetInput,
  type CommandCenterArtifactImportInput,
  type CommandCenterArtifactKind,
  type CommandCenterArtifactListInput,
  type CommandCenterArtifactRestoreVersionInput,
  type CommandCenterArtifactSaveInput,
  type CommandCenterArtifactSaveResult,
  type CommandCenterArtifactSetArchivedInput,
  type CommandCenterArtifactSubscribeInput,
  type CommandCenterArtifactThumbnail,
  type CommandCenterArtifactThumbnailInput,
  type CommandCenterCanvasDeleteInput,
  type CommandCenterCanvasDeleteResult,
  type CommandCenterCanvasGetInput,
  type CommandCenterCanvasUpsertEdgesInput,
  type CommandCenterCanvasUpsertEdgesResult,
  type CommandCenterCanvasUpsertItemsInput,
  type CommandCenterCanvasUpsertItemsResult,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import {
  createAttachmentId,
  parseAttachmentFileExtension,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as ServerSettings from "../serverSettings.ts";
import { detectArtifactImport } from "./artifactImport.ts";
import * as CommandCenterService from "./CommandCenterService.ts";
import { decodeRows, failWith, fromRow } from "./CommandCenterService.ts";

/** Who writes a version: clients write as the user, MCP callers as an agent. */
export interface ArtifactAuthor {
  readonly author: CommandCenterArtifactAuthor;
  /** Provider instance or client label, when known. */
  readonly label: string | null;
}

const USER: ArtifactAuthor = { author: "user", label: null };

/**
 * Wave 4: the artifacts library (HTML and Markdown pages shared across agents, with versions)
 * and the per-project canvas. Rows live in `cc_artifacts*` / `cc_canvas_*`; each version's page
 * is a file in the attachments directory, so the asset route serves it like an `html_render`
 * page. Nothing here runs without a request, and artifacts never join the main snapshot.
 */
export class ArtifactsService extends Context.Service<
  ArtifactsService,
  {
    /**
     * The newest page on subscribe, then again after every artifact change. Fails while
     * Command Center is off.
     */
    readonly subscribe: (
      input: CommandCenterArtifactSubscribeInput,
    ) => Stream.Stream<CommandCenterArtifactListResult, CommandCenterError>;
    /** One page, most recently updated first. */
    readonly list: (
      input: CommandCenterArtifactListInput,
    ) => Effect.Effect<CommandCenterArtifactListResult, CommandCenterError>;
    /** A version's content (the current one by default) with the artifact and its history. */
    readonly get: (
      input: CommandCenterArtifactGetInput,
    ) => Effect.Effect<CommandCenterArtifactDetail, CommandCenterError>;
    /** Creates an artifact or appends a version; a new version restores an archived artifact. */
    readonly save: (
      input: CommandCenterArtifactSaveInput,
      author?: ArtifactAuthor,
    ) => Effect.Effect<CommandCenterArtifactSaveResult, CommandCenterError>;
    /** Pasted text or a dropped file, with its kind and title worked out from it. */
    readonly importArtifact: (
      input: CommandCenterArtifactImportInput,
    ) => Effect.Effect<CommandCenterArtifactSaveResult, CommandCenterError>;
    /** Appends a copy of an older version as the new current one; history is never rewritten. */
    readonly restoreVersion: (
      input: CommandCenterArtifactRestoreVersionInput,
      author?: ArtifactAuthor,
    ) => Effect.Effect<CommandCenterArtifactSaveResult, CommandCenterError>;
    readonly setArchived: (
      input: CommandCenterArtifactSetArchivedInput,
    ) => Effect.Effect<CommandCenterArtifact, CommandCenterError>;
    /**
     * The version's cached thumbnail, captured on its first request. Null when this server has
     * no preview browser installed (it is never installed for this) or the capture failed.
     */
    readonly thumbnail: (
      input: CommandCenterArtifactThumbnailInput,
    ) => Effect.Effect<CommandCenterArtifactThumbnail, CommandCenterError>;
    readonly getCanvas: (
      input: CommandCenterCanvasGetInput,
    ) => Effect.Effect<CommandCenterCanvas, CommandCenterError>;
    readonly upsertCanvasItems: (
      input: CommandCenterCanvasUpsertItemsInput,
    ) => Effect.Effect<CommandCenterCanvasUpsertItemsResult, CommandCenterError>;
    /** Both ends must be cards on the same board. */
    readonly upsertCanvasEdges: (
      input: CommandCenterCanvasUpsertEdgesInput,
    ) => Effect.Effect<CommandCenterCanvasUpsertEdgesResult, CommandCenterError>;
    /** Removes cards (with their edges) and edges; returns the removed rows for undo. */
    readonly deleteCanvasEntries: (
      input: CommandCenterCanvasDeleteInput,
    ) => Effect.Effect<CommandCenterCanvasDeleteResult, CommandCenterError>;
  }
>()("t3/commandCenter/ArtifactsService") {}

// Version files are attachments named `cc-artifact-<uuid>-<ext>`; the thumbnail of a version
// drops the suffix (`cc-artifact-<uuid>.webp`), which the asset route serves as an image.
const ATTACHMENT_SEGMENT = "cc-artifact";
const FILE_EXTENSION = { html: "html", markdown: "md" } as const satisfies Record<
  CommandCenterArtifactKind,
  string
>;
const LIST_DEFAULT_LIMIT = 50;
const MARKDOWN_THUMBNAIL_CHARS = 3_000;
const MIB = 1024 * 1024;

type Row = Record<string, unknown>;

const decodeArtifact = Schema.decodeUnknownEffect(CommandCenterArtifact);
const decodeArtifactPage = Schema.decodeUnknownEffect(CommandCenterArtifactListResult);
const decodeVersion = Schema.decodeUnknownEffect(CommandCenterArtifactVersion);
const decodeVersions = Schema.decodeUnknownEffect(Schema.Array(CommandCenterArtifactVersion));
const decodeCanvas = Schema.decodeUnknownEffect(CommandCenterCanvas);
const decodeItems = Schema.decodeUnknownEffect(Schema.Array(CommandCenterCanvasItem));
const decodeEdges = Schema.decodeUnknownEffect(Schema.Array(CommandCenterCanvasEdge));
const isCommandCenterError = Schema.is(CommandCenterError);

const fail = (message: string) => Effect.fail(new CommandCenterError({ message }));

/** Keeps a service error as is and wraps anything else (SQL, files) in `message`. */
const orFailWith = (message: string) => (error: unknown) =>
  isCommandCenterError(error) ? error : failWith(message)(error);

/** The `html_render` theme bootstrap (`injectHtmlRenderBootstrap`) that stored HTML carries. */
const BOOTSTRAP_PATTERN =
  /<style id="t3-theme">[^<]*<\/style><script>\(function\(\)\{var s=document\.getElementById\("t3-theme"\)[\s\S]*?\}\)\(\);<\/script>/;

/** A stored HTML version as agents and editors should see it: without the theme bootstrap. */
export const stripHtmlRenderBootstrap = (html: string) => html.replace(BOOTSTRAP_PATTERN, "");

// Inlined images (html_render inlines local ones as base64) would flood an agent's context, so
// agents read them as `data:t3-inline/<n>` and a saved version gets them back by number.
const INLINE_DATA_PATTERN = /data:[a-z0-9.+/-]+;base64,[a-z0-9+/=]{200,}/gi;
const INLINE_PLACEHOLDER_PATTERN = /data:t3-inline\/(\d+)/g;

/** `content` with every long base64 data URI replaced by `data:t3-inline/<n>` (n from 0). */
export const elideInlineData = (content: string) => {
  let count = 0;
  const elided = content.replace(INLINE_DATA_PATTERN, () => `data:t3-inline/${count++}`);
  return { content: elided, count };
};

/**
 * Puts back the data URIs `elideInlineData` took out of `source`. Null when `content` names one
 * `source` does not have.
 */
export const restoreInlineData = (content: string, source: string): string | null => {
  const originals = source.match(INLINE_DATA_PATTERN) ?? [];
  let missing = false;
  const restored = content.replace(INLINE_PLACEHOLDER_PATTERN, (placeholder, index: string) => {
    const original = originals[Number(index)];
    if (original === undefined) missing = true;
    return original ?? placeholder;
  });
  return missing ? null : restored;
};

/** HTML is stored with the bootstrap, so it renders themed like an `html_render` page. */
const storedContent = (kind: CommandCenterArtifactKind, content: string) =>
  kind === "html" && !BOOTSTRAP_PATTERN.test(content)
    ? injectHtmlRenderBootstrap(content)
    : content;

const escapeHtml = (text: string) =>
  text.replace(/[&<>]/g, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;"));

/** A page showing the start of a Markdown version as plain text, for its thumbnail. */
export const markdownThumbnailHtml = (markdown: string) =>
  injectHtmlRenderBootstrap(
    `<!doctype html><html><head></head><body><pre style="margin:0;padding:32px;white-space:pre-wrap;font:15px/1.6 var(--font-sans)">${escapeHtml(markdown.slice(0, MARKDOWN_THUMBNAIL_CHARS))}</pre></body></html>`,
  );

const thumbnailIdFor = (attachmentId: string) => attachmentId.replace(/-(?:html|md)$/, "");

export const make = Effect.gen(function* () {
  // Built on the Command Center service, which creates the tables when it starts.
  yield* CommandCenterService.CommandCenterService;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const htmlRender = yield* HtmlRender.HtmlRender;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  // Sliding(1): every signal re-lists anyway, so a slow subscriber needs only the latest one.
  const changes = yield* PubSub.sliding<void>(1);
  const notifyChanged = PubSub.publish(changes, undefined);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const newId = crypto.randomUUIDv4.pipe(
    Effect.mapError(failWith("Could not generate a Command Center id.")),
  );
  const isEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.commandCenter.enabled),
    Effect.mapError(failWith("Could not read the Command Center setting.")),
  );

  const attachmentPath = (relativePath: string) =>
    resolveAttachmentRelativePath({ attachmentsDir: config.attachmentsDir, relativePath });
  const versionPath = (attachmentId: string) => {
    const extension = parseAttachmentFileExtension(attachmentId);
    return extension === null ? null : attachmentPath(`${attachmentId}.${extension}`);
  };
  const readVersionFile = (attachmentId: string) => {
    const path = versionPath(attachmentId);
    return path === null
      ? fail("The artifact file is missing.")
      : fileSystem
          .readFileString(path)
          .pipe(Effect.mapError(failWith("The artifact file is missing or unreadable.")));
  };

  const readArtifact = (row: Row) =>
    decodeRows("Could not read the artifact.", decodeArtifact, () => fromRow(row));

  const findArtifact = (id: string) =>
    sql<Row>`SELECT * FROM cc_artifacts WHERE id = ${id}`.pipe(
      Effect.mapError(failWith("Could not read the artifact.")),
      Effect.flatMap(([row]) =>
        row === undefined ? fail("Artifact not found.") : readArtifact(row),
      ),
    );

  const findVersions = (artifactId: string) =>
    sql<Row>`
      SELECT * FROM cc_artifact_versions WHERE artifact_id = ${artifactId} ORDER BY version DESC
    `.pipe(
      Effect.mapError(failWith("Could not read the artifact history.")),
      Effect.flatMap((rows) =>
        decodeRows("Could not read the artifact history.", decodeVersions, () => rows.map(fromRow)),
      ),
    );

  const findVersion = (artifactId: string, version: number) =>
    sql<Row>`
      SELECT * FROM cc_artifact_versions WHERE artifact_id = ${artifactId} AND version = ${version}
    `.pipe(
      Effect.mapError(failWith("Could not read the artifact version.")),
      Effect.flatMap(([row]) =>
        row === undefined
          ? fail("Artifact version not found.")
          : decodeRows("Could not read the artifact version.", decodeVersion, () => fromRow(row)),
      ),
    );

  const list = Effect.fn("ArtifactsService.list")(function* (
    input: CommandCenterArtifactListInput,
  ) {
    const limit = input.limit ?? LIST_DEFAULT_LIMIT;
    const query = input.query?.trim() ?? "";
    // One extra row tells whether another page exists.
    const rows = yield* sql<Row>`
      SELECT * FROM cc_artifacts
      WHERE ${sql.and([
        input.archived === true ? sql`archived_at IS NOT NULL` : sql`archived_at IS NULL`,
        ...(input.projectId === undefined
          ? []
          : [
              input.projectId === null
                ? sql`project_id IS NULL`
                : sql`project_id = ${input.projectId}`,
            ]),
        ...(query === ""
          ? []
          : [
              sql`title LIKE ${`%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`} ESCAPE '\\'`,
            ]),
        ...(input.before === undefined
          ? []
          : [
              // A value cursor, so paging survives the `before` artifact changing meanwhile.
              sql`(updated_at, id) < (
                COALESCE(
                  ${input.beforeUpdatedAt ?? null},
                  (SELECT updated_at FROM cc_artifacts WHERE id = ${input.before})
                ),
                ${input.before}
              )`,
            ]),
      ])}
      ORDER BY updated_at DESC, id DESC
      LIMIT ${limit + 1}
    `.pipe(Effect.mapError(failWith("Could not list artifacts.")));
    return yield* decodeRows("Could not list artifacts.", decodeArtifactPage, () => ({
      artifacts: rows.slice(0, limit).map(fromRow),
      hasMore: rows.length > limit,
    }));
  });

  const subscribe = (input: CommandCenterArtifactSubscribeInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (!(yield* isEnabled)) {
          return yield* new CommandCenterError({
            message: "Command Center is turned off on this server (commandCenter.enabled).",
          });
        }
        // Subscribe before the first read so a change landing between the two is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(list(input)),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list(input))),
        );
      }),
    );

  const get = Effect.fn("ArtifactsService.get")(function* (input: CommandCenterArtifactGetInput) {
    const artifact = yield* findArtifact(input.id);
    const versions = yield* findVersions(input.id);
    const wanted = input.version ?? artifact.currentVersion;
    const version = versions.find((candidate) => candidate.version === wanted);
    if (version === undefined) return yield* fail("Artifact version not found.");
    if (!(input.includeContent ?? artifact.kind === "markdown")) {
      return { artifact, version, content: null, versions };
    }
    const stored = yield* readVersionFile(version.attachmentId);
    const content = artifact.kind === "html" ? stripHtmlRenderBootstrap(stored) : stored;
    return { artifact, version, content, versions };
  });

  /** The page to store: `content` as given, or a copy of an `html_render` page on this server. */
  const sourceContent = Effect.fn("ArtifactsService.sourceContent")(function* (input: {
    readonly content?: string | undefined;
    readonly fromAttachmentId?: string | undefined;
  }) {
    if (input.fromAttachmentId === undefined) {
      if (input.content === undefined) {
        return yield* fail("Give the page as content or as fromAttachmentId.");
      }
      return input.content;
    }
    if (input.content !== undefined) {
      return yield* fail("Give the page as content or as fromAttachmentId, not both.");
    }
    // Only HTML pages (ids ending in -html: html_render pages, artifact versions) are copied.
    const path =
      parseAttachmentFileExtension(input.fromAttachmentId) === "html"
        ? resolveAttachmentPathById({
            attachmentsDir: config.attachmentsDir,
            attachmentId: input.fromAttachmentId,
          })
        : null;
    if (path === null) return yield* fail("That rendered page is not on this server.");
    return yield* fileSystem
      .readFileString(path)
      .pipe(Effect.mapError(failWith("Could not read the rendered page.")));
  });

  const checkSize = (content: string) => {
    const bytes = Buffer.byteLength(content, "utf8");
    return bytes > COMMAND_CENTER_ARTIFACT_MAX_BYTES
      ? fail(
          `The page is ${(bytes / MIB).toFixed(1)} MiB; an artifact version holds at most ${COMMAND_CENTER_ARTIFACT_MAX_BYTES / MIB} MiB.`,
        )
      : Effect.void;
  };

  /**
   * Writes the version file, then its rows in one transaction (removing the file if they fail),
   * then tells subscribers. `commit` gets the file and returns the artifact row it saved.
   */
  const writeVersion = Effect.fn("ArtifactsService.writeVersion")(function* (
    kind: CommandCenterArtifactKind,
    stored: string,
    author: ArtifactAuthor,
    threadId: ThreadId | null,
    commit: (now: string) => Effect.Effect<ReadonlyArray<Row>, SqlError>,
  ) {
    const attachmentId = createAttachmentId(ATTACHMENT_SEGMENT, FILE_EXTENSION[kind]);
    const path = attachmentId === null ? null : versionPath(attachmentId);
    if (attachmentId === null || path === null) return yield* fail("Could not store the artifact.");
    const now = yield* nowIso;
    const saveRows = Effect.gen(function* () {
      const [artifact] = yield* commit(now);
      if (artifact === undefined) return yield* fail("Artifact not found.");
      const [version] = yield* sql<Row>`
        INSERT INTO cc_artifact_versions ${sql.insert({
          artifact_id: artifact.id,
          version: artifact.current_version,
          author: author.author,
          author_label: author.label,
          thread_id: threadId,
          attachment_id: attachmentId,
          size_bytes: Buffer.byteLength(stored, "utf8"),
          created_at: now,
        })}
        RETURNING *
      `;
      if (version === undefined) return yield* fail("Could not save the artifact version.");
      return { artifact, version };
    }).pipe(sql.withTransaction);
    const rows = yield* fileSystem.writeFileString(path, stored).pipe(
      Effect.andThen(saveRows),
      Effect.mapError(orFailWith("Could not save the artifact.")),
      // Only committed rows point at the file, so a failed save leaves nothing behind.
      Effect.onError(() => fileSystem.remove(path, { force: true }).pipe(Effect.ignore)),
    );
    // Published after commit so subscribers never list a row that rolled back.
    yield* notifyChanged;
    return {
      artifact: yield* readArtifact(rows.artifact),
      version: yield* decodeRows("Could not read the artifact version.", decodeVersion, () =>
        fromRow(rows.version),
      ),
    };
  });

  /** Appends `stored` as the artifact's next version, applying an optional rename or move. */
  const appendVersion = (
    artifact: CommandCenterArtifact,
    stored: string,
    author: ArtifactAuthor,
    patch: {
      readonly title?: string | undefined;
      readonly projectId?: ProjectId | null | undefined;
      readonly threadId?: ThreadId | undefined;
    },
  ) =>
    writeVersion(
      artifact.kind,
      stored,
      author,
      patch.threadId ?? null,
      (now) => sql<Row>`
        UPDATE cc_artifacts SET
          current_version = current_version + 1,
          title = COALESCE(${patch.title ?? null}, title),
          project_id = CASE WHEN ${patch.projectId === undefined ? 1 : 0} = 1
            THEN project_id ELSE ${patch.projectId ?? null} END,
          updated_at = ${now},
          archived_at = NULL
        WHERE id = ${artifact.id}
        RETURNING *
      `,
    );

  const save = Effect.fn("ArtifactsService.save")(function* (
    input: CommandCenterArtifactSaveInput,
    author: ArtifactAuthor = USER,
  ) {
    const content = yield* sourceContent(input);
    yield* checkSize(content);
    if (input.id !== undefined) {
      const artifact = yield* findArtifact(input.id);
      if (input.kind !== undefined && input.kind !== artifact.kind) {
        return yield* fail(`This artifact is ${artifact.kind}; its kind cannot change.`);
      }
      if (artifact.kind !== "html" && input.fromAttachmentId !== undefined) {
        return yield* fail("A rendered page can only be saved to an html artifact.");
      }
      return yield* appendVersion(artifact, storedContent(artifact.kind, content), author, input);
    }
    if (input.title === undefined) return yield* fail("A new artifact needs a title.");
    const kind = input.kind ?? "html";
    if (kind !== "html" && input.fromAttachmentId !== undefined) {
      return yield* fail("A rendered page can only be saved as an html artifact.");
    }
    const id = yield* newId;
    const title = input.title;
    return yield* writeVersion(
      kind,
      storedContent(kind, content),
      author,
      input.threadId ?? null,
      (now) => sql<Row>`
        INSERT INTO cc_artifacts ${sql.insert({
          id,
          project_id: input.projectId ?? null,
          title,
          kind,
          current_version: 1,
          source_thread_id: input.threadId ?? null,
          created_at: now,
          updated_at: now,
          archived_at: null,
        })}
        RETURNING *
      `,
    );
  });

  const importArtifact = (input: CommandCenterArtifactImportInput) => {
    const { kind, title } = detectArtifactImport(input);
    return save({
      title,
      kind,
      content: input.content,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    });
  };

  const restoreVersion = Effect.fn("ArtifactsService.restoreVersion")(function* (
    input: CommandCenterArtifactRestoreVersionInput,
    author: ArtifactAuthor = USER,
  ) {
    const artifact = yield* findArtifact(input.id);
    const version = yield* findVersion(input.id, input.version);
    const stored = yield* readVersionFile(version.attachmentId);
    return yield* appendVersion(artifact, stored, author, {});
  });

  const setArchived = Effect.fn("ArtifactsService.setArchived")(function* (
    input: CommandCenterArtifactSetArchivedInput,
  ) {
    const now = yield* nowIso;
    const [row] = yield* sql<Row>`
      UPDATE cc_artifacts SET
        archived_at = ${input.archived ? sql`COALESCE(archived_at, ${now})` : sql`NULL`},
        updated_at = ${now}
      WHERE id = ${input.id}
      RETURNING *
    `.pipe(Effect.mapError(failWith("Could not update the artifact.")));
    if (row === undefined) return yield* fail("Artifact not found.");
    yield* notifyChanged;
    return yield* readArtifact(row);
  });

  // ponytail: one capture at a time and an in-memory list of pages that failed (retried after a
  // restart); a per-version lock and a persisted failure mark if thumbnails ever queue up.
  const thumbnailLock = yield* Semaphore.make(1);
  const failedThumbnails = new Set<string>();

  const thumbnail = Effect.fn("ArtifactsService.thumbnail")(function* (
    input: CommandCenterArtifactThumbnailInput,
  ) {
    const artifact = yield* findArtifact(input.id);
    const version = yield* findVersion(input.id, input.version);
    const thumbnailId = thumbnailIdFor(version.attachmentId);
    const path = attachmentPath(`${thumbnailId}.webp`);
    if (path === null) return { attachmentId: null };
    const cached = fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
    if (yield* cached) return { attachmentId: thumbnailId };
    return yield* thumbnailLock.withPermits(1)(
      Effect.gen(function* () {
        // Another request may have captured it while this one waited.
        if (yield* cached) return { attachmentId: thumbnailId };
        if (failedThumbnails.has(thumbnailId)) return { attachmentId: null };
        const stored = yield* readVersionFile(version.attachmentId);
        const page = artifact.kind === "html" ? stored : markdownThumbnailHtml(stored);
        const image = yield* htmlRender
          .thumbnail(page)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not capture an artifact thumbnail.", { cause }).pipe(
                Effect.andThen(Effect.sync(() => failedThumbnails.add(thumbnailId))),
                Effect.as(Option.none<string>()),
              ),
            ),
          );
        if (Option.isNone(image)) return { attachmentId: null };
        // Written aside and renamed, so a failed write never leaves a truncated image that the
        // `cached` check would serve forever (the pending-upload sweep clears stray `.part`s).
        const partial = `${path}.part`;
        yield* fileSystem
          .writeFile(partial, new Uint8Array(Buffer.from(image.value, "base64")))
          .pipe(
            Effect.andThen(fileSystem.rename(partial, path)),
            Effect.onError(() => fileSystem.remove(partial, { force: true }).pipe(Effect.ignore)),
            Effect.mapError(failWith("Could not store the artifact thumbnail.")),
          );
        return { attachmentId: thumbnailId };
      }),
    );
  });

  const getCanvas = Effect.fn("ArtifactsService.getCanvas")(function* (
    input: CommandCenterCanvasGetInput,
  ) {
    const projectId = input.projectId;
    const rows = yield* Effect.all({
      items: sql<Row>`
        SELECT * FROM cc_canvas_items WHERE project_id = ${projectId} ORDER BY created_at, rowid
      `,
      edges: sql<Row>`
        SELECT * FROM cc_canvas_edges WHERE project_id = ${projectId} ORDER BY created_at, rowid
      `,
      artifacts: sql<Row>`
        SELECT * FROM cc_artifacts WHERE id IN (
          SELECT ref_id FROM cc_canvas_items WHERE project_id = ${projectId} AND kind = 'artifact'
        )
      `,
      memory: sql<Row>`
        SELECT * FROM cc_memory WHERE id IN (
          SELECT ref_id FROM cc_canvas_items WHERE project_id = ${projectId} AND kind = 'memory'
        )
      `,
    }).pipe(Effect.mapError(failWith("Could not read the canvas.")));
    return yield* decodeRows("Could not read the canvas.", decodeCanvas, () =>
      Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, value.map(fromRow)])),
    );
  });

  /** Inserts or replaces one board row; a row id already used on another board is refused. */
  const upsertBoardRow = (table: "cc_canvas_items" | "cc_canvas_edges", row: Row) =>
    sql<Row>`
      INSERT INTO ${sql(table)} ${sql.insert(row)}
      ON CONFLICT (id) DO UPDATE SET ${sql.update(row, ["id", "project_id", "created_at"])}
      WHERE project_id = excluded.project_id
      RETURNING *
    `.pipe(
      Effect.flatMap(([saved]) =>
        saved === undefined
          ? fail("That id belongs to another project's canvas.")
          : Effect.succeed(saved),
      ),
    );

  const upsertCanvasItems = Effect.fn("ArtifactsService.upsertCanvasItems")(function* (
    input: CommandCenterCanvasUpsertItemsInput,
  ) {
    if (
      input.items.some((item) => "kind" in item && (item.kind === "note") !== (item.refId === null))
    ) {
      return yield* fail("A note card has no refId; every other card needs one.");
    }
    const now = yield* nowIso;
    const rows = yield* Effect.gen(function* () {
      const saved = yield* Effect.forEach(input.items, (item) =>
        Effect.gen(function* () {
          if (!("kind" in item)) {
            const moved = yield* sql<Row>`
              UPDATE cc_canvas_items SET x = ${item.x}, y = ${item.y}, updated_at = ${now}
              WHERE id = ${item.id} AND project_id = ${input.projectId}
              RETURNING *
            `;
            return moved;
          }
          const id = item.id ?? (yield* newId);
          return [
            yield* upsertBoardRow("cc_canvas_items", {
              id,
              project_id: input.projectId,
              kind: item.kind,
              ref_id: item.refId,
              text: item.text,
              x: item.x,
              y: item.y,
              w: item.w,
              h: item.h,
              created_at: now,
              updated_at: now,
            }),
          ];
        }),
      );
      const [count] = yield* sql<{ readonly cards: number }>`
        SELECT COUNT(*) AS cards FROM cc_canvas_items WHERE project_id = ${input.projectId}
      `;
      if ((count?.cards ?? 0) > COMMAND_CENTER_CANVAS_ITEM_LIMIT) {
        return yield* fail(
          `A canvas holds at most ${COMMAND_CENTER_CANVAS_ITEM_LIMIT} cards; remove some first.`,
        );
      }
      return saved.flat();
    }).pipe(sql.withTransaction, Effect.mapError(orFailWith("Could not save the canvas.")));
    const items = yield* decodeRows("Could not read the canvas.", decodeItems, () =>
      rows.map(fromRow),
    );
    return { items };
  });

  const upsertCanvasEdges = Effect.fn("ArtifactsService.upsertCanvasEdges")(function* (
    input: CommandCenterCanvasUpsertEdgesInput,
  ) {
    if (input.edges.some((edge) => edge.fromItemId === edge.toItemId)) {
      return yield* fail("An edge connects two different cards.");
    }
    const ends = [...new Set(input.edges.flatMap((edge) => [edge.fromItemId, edge.toItemId]))];
    const now = yield* nowIso;
    // Checked inside the transaction, so a card deleted meanwhile cannot leave a dangling edge.
    const rows = yield* Effect.gen(function* () {
      const found = yield* sql<{ readonly id: string }>`
        SELECT id FROM cc_canvas_items WHERE project_id = ${input.projectId} AND id IN ${sql.in(ends)}
      `;
      if (found.length !== ends.length) {
        return yield* fail("Both ends of an edge must be cards on this canvas.");
      }
      return yield* Effect.forEach(input.edges, (edge) =>
        Effect.gen(function* () {
          const id = edge.id ?? (yield* newId);
          return yield* upsertBoardRow("cc_canvas_edges", {
            id,
            project_id: input.projectId,
            from_item_id: edge.fromItemId,
            to_item_id: edge.toItemId,
            label: edge.label,
            created_at: now,
            updated_at: now,
          });
        }),
      );
    }).pipe(sql.withTransaction, Effect.mapError(orFailWith("Could not save the canvas.")));
    const edges = yield* decodeRows("Could not read the canvas.", decodeEdges, () =>
      rows.map(fromRow),
    );
    return { edges };
  });

  const deleteCanvasEntries = Effect.fn("ArtifactsService.deleteCanvasEntries")(function* (
    input: CommandCenterCanvasDeleteInput,
  ) {
    const projectId = input.projectId;
    const removed = yield* Effect.gen(function* () {
      const edges = yield* sql<Row>`
        DELETE FROM cc_canvas_edges
        WHERE project_id = ${projectId} AND (
          id IN ${sql.in(input.edgeIds)}
          OR from_item_id IN ${sql.in(input.itemIds)}
          OR to_item_id IN ${sql.in(input.itemIds)}
        )
        RETURNING *
      `;
      const items = yield* sql<Row>`
        DELETE FROM cc_canvas_items WHERE project_id = ${projectId} AND id IN ${sql.in(input.itemIds)}
        RETURNING *
      `;
      return { edges, items };
    }).pipe(sql.withTransaction, Effect.mapError(failWith("Could not update the canvas.")));
    return {
      items: yield* decodeRows("Could not read the canvas.", decodeItems, () =>
        removed.items.map(fromRow),
      ),
      edges: yield* decodeRows("Could not read the canvas.", decodeEdges, () =>
        removed.edges.map(fromRow),
      ),
    };
  });

  return ArtifactsService.of({
    subscribe,
    list,
    get,
    save,
    importArtifact,
    restoreVersion,
    setArchived,
    thumbnail,
    getCanvas,
    upsertCanvasItems,
    upsertCanvasEdges,
    deleteCanvasEntries,
  });
});

export const layer = Layer.effect(ArtifactsService, make);
