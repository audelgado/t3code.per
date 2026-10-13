import { assert, describe, expect, it } from "@effect/vitest";
import {
  COMMAND_CENTER_ARTIFACT_MAX_BYTES,
  COMMAND_CENTER_CANVAS_ITEM_LIMIT,
  CommandCenterArtifactId,
  CommandCenterCanvasItemId,
  ProjectId,
  ThreadId,
  type CommandCenterArtifactListResult,
} from "@t3tools/contracts";
import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { HtmlRenderBrowserError } from "../htmlRender/headlessChrome.ts";
import { detectArtifactImport } from "./artifactImport.ts";
import {
  ArtifactsService,
  elideInlineData,
  markdownThumbnailHtml,
  restoreInlineData,
  stripHtmlRenderBootstrap,
} from "./ArtifactsService.ts";
import { CommandCenterService } from "./CommandCenterService.ts";
import { layerTest } from "./CommandCenterService.testkit.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const PAGE =
  "<!doctype html><html><head><title>Plan</title></head><body><h1>Plan</h1></body></html>";
// Stored pages gain the charset and viewport metas the bootstrap adds; reads drop only the theme.
const SAVED_PAGE = stripHtmlRenderBootstrap(injectHtmlRenderBootstrap(PAGE));

describe("detectArtifactImport", () => {
  it("takes the kind from the file extension, then from how the text starts", () => {
    expect(detectArtifactImport({ content: "# Notes", fileName: "notes.html" }).kind).toBe("html");
    expect(detectArtifactImport({ content: "<div>x</div>", fileName: "a.md" }).kind).toBe(
      "markdown",
    );
    expect(detectArtifactImport({ content: "  <!-- c -->\n<!DOCTYPE html><p>" }).kind).toBe("html");
    expect(detectArtifactImport({ content: "<svg viewBox='0 0 1 1'/>" }).kind).toBe("html");
    expect(detectArtifactImport({ content: "Plain text with <b>tags</b>" }).kind).toBe("markdown");
  });

  it("titles from the given title, the page, the file name, then a default", () => {
    expect(detectArtifactImport({ content: PAGE, title: " Mine " }).title).toBe("Mine");
    expect(
      detectArtifactImport({ content: "<title> Q3 &amp; <b>Q4</b>\n plan</title>" }).title,
    ).toBe("Q3 & Q4 plan");
    expect(detectArtifactImport({ content: "<html><body><h1>Big <i>idea</i></h1>" }).title).toBe(
      "Big idea",
    );
    expect(detectArtifactImport({ content: "intro\n\n## Roadmap ##\n- a" }).title).toBe("Roadmap");
    expect(detectArtifactImport({ content: "no heading", fileName: "launch.notes.md" }).title).toBe(
      "launch.notes",
    );
    expect(detectArtifactImport({ content: "no heading" }).title).toBe("Imported artifact");
  });
});

describe("stripHtmlRenderBootstrap", () => {
  it("removes exactly the theme bootstrap a stored page carries", () => {
    const stored = injectHtmlRenderBootstrap(PAGE);
    expect(stored).toContain("t3-theme");
    const stripped = stripHtmlRenderBootstrap(stored);
    expect(stripped).not.toContain("t3-theme");
    expect(stripped).toContain("<title>Plan</title></head><body><h1>Plan</h1>");
    expect(stripHtmlRenderBootstrap(PAGE)).toBe(PAGE);
  });

  it("escapes Markdown into a themed thumbnail page", () => {
    const page = markdownThumbnailHtml("# Title <script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain("t3-theme");
  });
});

it.effect("creates, versions, renames, restores and reads artifacts", () =>
  Effect.gen(function* () {
    const artifacts = yield* ArtifactsService;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const thread = ThreadId.make("thread-1");

    const created = yield* artifacts.save({
      title: "Plan",
      content: PAGE,
      projectId: projectA,
      threadId: thread,
    });
    expect(created.artifact).toMatchObject({
      title: "Plan",
      kind: "html",
      currentVersion: 1,
      projectId: projectA,
      sourceThreadId: thread,
      archivedAt: null,
    });
    expect(created.version).toMatchObject({ version: 1, author: "user", threadId: thread });
    // The file is stored themed, under the attachments directory, and read back without it.
    const path = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: created.version.attachmentId,
    });
    assert(path !== null);
    expect(yield* fileSystem.readFileString(path)).toContain('<style id="t3-theme">');

    yield* TestClock.adjust("1 minute");
    const revised = yield* artifacts.save(
      { id: created.artifact.id, title: "Plan v2", content: "<p>Second</p>" },
      { author: "agent", label: "codex" },
    );
    expect(revised.artifact).toMatchObject({ title: "Plan v2", currentVersion: 2 });
    expect(revised.artifact.projectId).toBe(projectA);
    expect(revised.version).toMatchObject({ version: 2, author: "agent", authorLabel: "codex" });

    const refused = yield* artifacts
      .save({ id: created.artifact.id, kind: "markdown", content: "# x" })
      .pipe(Effect.flip);
    expect(refused.message).toContain("cannot change");

    const current = yield* artifacts.get({ id: created.artifact.id, includeContent: true });
    // HTML renders from its attachment, so its source is sent only when asked for.
    expect((yield* artifacts.get({ id: created.artifact.id })).content).toBeNull();
    expect(current.version.version).toBe(2);
    expect(current.content).not.toContain("t3-theme");
    expect(current.content).toContain("<p>Second</p>");
    expect(current.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(
      (yield* artifacts.get({ id: created.artifact.id, version: 1, includeContent: true })).content,
    ).toBe(SAVED_PAGE);

    const restored = yield* artifacts.restoreVersion({ id: created.artifact.id, version: 1 });
    expect(restored.artifact.currentVersion).toBe(3);
    expect((yield* artifacts.get({ id: created.artifact.id, includeContent: true })).content).toBe(
      SAVED_PAGE,
    );

    const markdown = yield* artifacts.importArtifact({
      content: "# Release notes\n\n- Fixed",
      fileName: "notes.md",
    });
    expect(markdown.artifact).toMatchObject({ kind: "markdown", title: "Release notes" });
    expect((yield* artifacts.get({ id: markdown.artifact.id })).content).toBe(
      "# Release notes\n\n- Fixed",
    );

    expect(
      (yield* artifacts.get({ id: CommandCenterArtifactId.make("missing") }).pipe(Effect.flip))
        .message,
    ).toBe("Artifact not found.");
  }).pipe(Effect.provide(layerTest())),
);

it.effect("saves an html_render page by its attachment id and refuses other sources", () =>
  Effect.gen(function* () {
    const artifacts = yield* ArtifactsService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const rendered = injectHtmlRenderBootstrap(PAGE);
    const attachmentId = "thread-1-0f8fad5b-d9cb-469f-a165-70867728950e-html";
    yield* fileSystem.writeFileString(
      path.join(config.attachmentsDir, `${attachmentId}.html`),
      rendered,
    );

    const saved = yield* artifacts.save({ title: "Rendered", fromAttachmentId: attachmentId });
    expect((yield* artifacts.get({ id: saved.artifact.id, includeContent: true })).content).toBe(
      SAVED_PAGE,
    );

    expect(
      (yield* artifacts
        .save({ title: "Image", fromAttachmentId: "thread-1-0f8fad5b-d9cb-469f-a165-70867728950e" })
        .pipe(Effect.flip)).message,
    ).toContain("not on this server");
    expect(
      (yield* artifacts
        .save({ title: "Both", content: PAGE, fromAttachmentId: attachmentId })
        .pipe(Effect.flip)).message,
    ).toContain("not both");
    expect((yield* artifacts.save({ content: PAGE }).pipe(Effect.flip)).message).toContain(
      "needs a title",
    );
    expect(
      (yield* artifacts
        .save({ title: "Huge", content: "x".repeat(COMMAND_CENTER_ARTIFACT_MAX_BYTES + 1) })
        .pipe(Effect.flip)).message,
    ).toContain("at most 5 MiB");
  }).pipe(Effect.provide(layerTest())),
);

it.effect("pages, filters and archives the library, and streams it to subscribers", () =>
  Effect.gen(function* () {
    const artifacts = yield* ArtifactsService;
    const ids: Array<CommandCenterArtifactId> = [];
    for (const [index, projectId] of [projectA, projectA, projectB].entries()) {
      yield* TestClock.adjust("1 minute");
      const saved = yield* artifacts.save({
        title: index === 2 ? "Billing 100%" : `Page ${index}`,
        content: PAGE,
        projectId,
      });
      ids.push(saved.artifact.id);
    }

    const first = yield* artifacts.list({ limit: 2 });
    expect(first.artifacts.map((artifact) => artifact.id)).toEqual([ids[2], ids[1]]);
    expect(first.hasMore).toBe(true);
    const last = first.artifacts.at(-1);
    assert(last !== undefined);
    const second = yield* artifacts.list({
      limit: 2,
      before: last.id,
      beforeUpdatedAt: last.updatedAt,
    });
    expect(second).toMatchObject({ artifacts: [{ id: ids[0] }], hasMore: false });
    expect((yield* artifacts.list({ projectId: projectB })).artifacts.length).toBe(1);
    // `%` is matched literally, not as a wildcard.
    expect((yield* artifacts.list({ query: "100%" })).artifacts.map((a) => a.id)).toEqual([ids[2]]);
    expect((yield* artifacts.list({ query: "0%" })).artifacts.length).toBe(1);

    const subscribed = yield* Deferred.make<void>();
    const pages = yield* artifacts.subscribe({ projectId: projectA }).pipe(
      Stream.tap(() => Deferred.succeed(subscribed, undefined)),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(subscribed);
    const archived = yield* artifacts.setArchived({ id: ids[0]!, archived: true });
    expect(archived.archivedAt).not.toBeNull();
    const streamed: ReadonlyArray<CommandCenterArtifactListResult> = Array.from(
      yield* Fiber.join(pages),
    );
    expect(streamed.map((page) => page.artifacts.length)).toEqual([2, 1]);

    expect((yield* artifacts.list({ archived: true })).artifacts.map((a) => a.id)).toEqual([
      ids[0],
    ]);
    yield* artifacts.setArchived({ id: ids[0]!, archived: false });
    expect((yield* artifacts.list({ archived: true })).artifacts).toEqual([]);
    // A new version brings an archived artifact back too.
    yield* artifacts.setArchived({ id: ids[1]!, archived: true });
    yield* artifacts.save({ id: ids[1]!, content: PAGE });
    expect((yield* artifacts.list({})).artifacts.length).toBe(3);
  }).pipe(Effect.provide(layerTest())),
);

it.effect("refuses the artifact stream while Command Center is off", () =>
  Effect.gen(function* () {
    const artifacts = yield* ArtifactsService;
    const refused = yield* artifacts.subscribe({}).pipe(Stream.runDrain, Effect.flip);
    expect(refused.message).toContain("turned off");
  }).pipe(Effect.provide(layerTest({ enabled: false }))),
);

it.effect("captures each version's thumbnail once and caches it as an attachment", () => {
  let captures = 0;
  return Effect.gen(function* () {
    const artifacts = yield* ArtifactsService;
    const config = yield* ServerConfig.ServerConfig;
    const saved = yield* artifacts.save({ title: "Plan", content: PAGE });
    const input = { id: saved.artifact.id, version: 1 };
    const first = yield* artifacts.thumbnail(input);
    assert(first.attachmentId !== null);
    expect(yield* artifacts.thumbnail(input)).toEqual(first);
    expect(captures).toBe(1);
    expect(
      resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: first.attachmentId,
      }),
    ).toMatch(/\.webp$/);
  }).pipe(
    Effect.provide(
      layerTest({
        thumbnail: () =>
          Effect.sync(() => {
            captures += 1;
            return Option.some(Buffer.from("RIFF0000WEBP").toString("base64"));
          }),
      }),
    ),
  );
});

it.effect("returns no thumbnail without a browser, and stops retrying a page that fails", () => {
  let attempts = 0;
  return Effect.gen(function* () {
    const artifacts = yield* ArtifactsService;
    const saved = yield* artifacts.save({ title: "Notes", kind: "markdown", content: "# Hi" });
    const input = { id: saved.artifact.id, version: 1 };
    expect(yield* artifacts.thumbnail(input)).toEqual({ attachmentId: null });
    expect(yield* artifacts.thumbnail(input)).toEqual({ attachmentId: null });
    expect(attempts).toBe(1);
  }).pipe(
    Effect.provide(
      layerTest({
        thumbnail: () =>
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(new HtmlRenderBrowserError({ reason: "crashed" }));
          }),
      }),
    ),
  );
});

it.effect("places cards and edges on a project's canvas, with undo for removals", () =>
  Effect.gen(function* () {
    const artifacts = yield* ArtifactsService;
    const commandCenter = yield* CommandCenterService;
    const saved = yield* artifacts.save({ title: "Plan", content: PAGE, projectId: projectA });
    const note = yield* commandCenter.upsert({
      entity: "memory",
      value: {
        projectId: projectA,
        sectionId: null,
        threadId: null,
        kind: "note",
        text: "Old note",
        done: false,
        source: "user",
      },
    });

    const { items } = yield* artifacts.upsertCanvasItems({
      projectId: projectA,
      items: [
        { kind: "artifact", refId: saved.artifact.id, text: null, x: 0, y: 0, w: null, h: null },
        { kind: "memory", refId: note.value.id, text: null, x: 300, y: 0, w: 240, h: 120 },
        { kind: "note", refId: null, text: "Ask the client", x: 0, y: 300, w: null, h: null },
      ],
    });
    const [artifactCard, memoryCard, noteCard] = items;
    assert(artifactCard && memoryCard && noteCard);
    const { edges } = yield* artifacts.upsertCanvasEdges({
      projectId: projectA,
      edges: [
        { fromItemId: artifactCard.id, toItemId: memoryCard.id, label: "explains" },
        { fromItemId: noteCard.id, toItemId: artifactCard.id, label: null },
      ],
    });
    expect(edges.length).toBe(2);

    // Moving a card keeps its id and creation time.
    yield* TestClock.adjust("1 minute");
    const moved = yield* artifacts.upsertCanvasItems({
      projectId: projectA,
      items: [{ ...noteCard, x: 50 }],
    });
    expect(moved.items[0]).toMatchObject({ id: noteCard.id, x: 50, createdAt: noteCard.createdAt });

    const canvas = yield* artifacts.getCanvas({ projectId: projectA });
    expect(canvas.items.map((item) => item.id)).toEqual([
      artifactCard.id,
      memoryCard.id,
      noteCard.id,
    ]);
    expect(canvas.artifacts.map((artifact) => artifact.id)).toEqual([saved.artifact.id]);
    expect(canvas.memory.map((entry) => entry.text)).toEqual(["Old note"]);
    expect((yield* artifacts.getCanvas({ projectId: projectB })).items).toEqual([]);

    const removed = yield* artifacts.deleteCanvasEntries({
      projectId: projectA,
      itemIds: [artifactCard.id],
      edgeIds: [],
    });
    expect(removed.items.map((item) => item.id)).toEqual([artifactCard.id]);
    expect(removed.edges.length).toBe(2);
    expect((yield* artifacts.getCanvas({ projectId: projectA })).edges).toEqual([]);

    yield* artifacts.upsertCanvasItems({ projectId: projectA, items: removed.items });
    yield* artifacts.upsertCanvasEdges({ projectId: projectA, edges: removed.edges });
    const undone = yield* artifacts.getCanvas({ projectId: projectA });
    expect(undone.items.length).toBe(3);
    expect(undone.edges.map((edge) => edge.id).toSorted()).toEqual(
      removed.edges.map((edge) => edge.id).toSorted(),
    );
  }).pipe(Effect.provide(layerTest())),
);

it.effect("refuses canvas rows that would not resolve", () =>
  Effect.gen(function* () {
    const artifacts = yield* ArtifactsService;
    const missingRef = yield* artifacts
      .upsertCanvasItems({
        projectId: projectA,
        items: [{ kind: "section", refId: null, text: null, x: 0, y: 0, w: null, h: null }],
      })
      .pipe(Effect.flip);
    expect(missingRef.message).toContain("needs one");

    const { items } = yield* artifacts.upsertCanvasItems({
      projectId: projectA,
      items: [{ kind: "note", refId: null, text: "A", x: 0, y: 0, w: null, h: null }],
    });
    const [card] = items;
    assert(card !== undefined);
    const dangling = yield* artifacts
      .upsertCanvasEdges({
        projectId: projectA,
        edges: [
          { fromItemId: card.id, toItemId: CommandCenterCanvasItemId.make("gone"), label: null },
        ],
      })
      .pipe(Effect.flip);
    expect(dangling.message).toContain("Both ends");
    // A card id from one board cannot be overwritten from another.
    const stolen = yield* artifacts
      .upsertCanvasItems({ projectId: projectB, items: [{ ...card, text: "B" }] })
      .pipe(Effect.flip);
    expect(stolen.message).toContain("another project");
  }).pipe(Effect.provide(layerTest())),
);

describe("elideInlineData", () => {
  it("swaps long data URIs for numbered placeholders and puts them back", () => {
    const image = `data:image/png;base64,${"A".repeat(400)}`;
    const other = `data:image/webp;base64,${"B".repeat(300)}`;
    const page = `<img src="${image}"><img src="data:image/gif;base64,R0lG"><img src='${other}'>`;
    const elided = elideInlineData(page);
    expect(elided).toEqual({
      content:
        '<img src="data:t3-inline/0"><img src="data:image/gif;base64,R0lG"><img src=\'data:t3-inline/1\'>',
      count: 2,
    });
    const revised = elided.content.replace("<img", "<h1>New</h1><img");
    expect(restoreInlineData(revised, page)).toBe(page.replace("<img", "<h1>New</h1><img"));
    expect(restoreInlineData('<img src="data:t3-inline/7">', page)).toBeNull();
  });
});

it.effect("lists only global artifacts for a null project", () =>
  Effect.gen(function* () {
    const artifacts = yield* ArtifactsService;
    yield* artifacts.save({ title: "Scoped", content: PAGE, projectId: projectA });
    const global = yield* artifacts.save({ title: "Everywhere", content: PAGE });
    expect((yield* artifacts.list({ projectId: null })).artifacts.map((a) => a.id)).toEqual([
      global.artifact.id,
    ]);
  }).pipe(Effect.provide(layerTest())),
);

it.effect("moves cards by position only and caps a board's cards", () =>
  Effect.gen(function* () {
    const artifacts = yield* ArtifactsService;
    const { items } = yield* artifacts.upsertCanvasItems({
      projectId: projectA,
      items: [{ kind: "note", refId: null, text: "New text", x: 0, y: 0, w: 200, h: null }],
    });
    const [card] = items;
    assert(card !== undefined);
    const moved = yield* artifacts.upsertCanvasItems({
      projectId: projectA,
      items: [
        { id: card.id, x: 40, y: 80 },
        { id: CommandCenterCanvasItemId.make("removed-meanwhile"), x: 1, y: 1 },
      ],
    });
    expect(moved.items).toEqual([
      expect.objectContaining({ id: card.id, x: 40, y: 80, text: "New text", w: 200 }),
    ]);

    const note = { kind: "note" as const, refId: null, text: "n", x: 0, y: 0, w: null, h: null };
    yield* artifacts.upsertCanvasItems({
      projectId: projectA,
      items: Array.from({ length: COMMAND_CENTER_CANVAS_ITEM_LIMIT - 1 }, () => note),
    });
    const full = yield* artifacts
      .upsertCanvasItems({ projectId: projectA, items: [note] })
      .pipe(Effect.flip);
    expect(full.message).toContain(`at most ${COMMAND_CENTER_CANVAS_ITEM_LIMIT}`);
    expect((yield* artifacts.getCanvas({ projectId: projectA })).items.length).toBe(
      COMMAND_CENTER_CANVAS_ITEM_LIMIT,
    );
  }).pipe(Effect.provide(layerTest())),
);
