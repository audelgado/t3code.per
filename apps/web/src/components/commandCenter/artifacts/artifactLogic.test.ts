import {
  COMMAND_CENTER_ARTIFACT_MAX_BYTES,
  CommandCenterArtifactId,
  type CommandCenterArtifact,
  type CommandCenterArtifactVersion,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { paginateCollection, showLoadOlder } from "../collectionPaging";
import {
  ARTIFACT_PAGE_SIZE,
  artifactImportFileError,
  artifactImportTextError,
  mergeArtifactPages,
  nextArtifactCursor,
  previousArtifactVersion,
} from "./artifactLogic";

function artifact(id: string, updatedAt: string): CommandCenterArtifact {
  return {
    id: CommandCenterArtifactId.make(id),
    projectId: null,
    title: `Artifact ${id}`,
    kind: "html",
    currentVersion: 1,
    sourceThreadId: null,
    createdAt: updatedAt,
    updatedAt,
    archivedAt: null,
  };
}

function version(value: number): CommandCenterArtifactVersion {
  return {
    artifactId: CommandCenterArtifactId.make("a"),
    version: value,
    author: "agent",
    authorLabel: null,
    threadId: null,
    attachmentId: `cc-artifact-${value}-html`,
    sizeBytes: 10,
    createdAt: "2026-10-13T00:00:00.000Z",
  };
}

describe("mergeArtifactPages", () => {
  it("keeps the live copy of an artifact that moved up from an older page", () => {
    const live = [
      artifact("b", "2026-10-13T03:00:00.000Z"),
      artifact("c", "2026-10-13T02:00:00.000Z"),
    ];
    const older = [
      artifact("b", "2026-10-12T00:00:00.000Z"),
      artifact("d", "2026-10-11T00:00:00.000Z"),
    ];
    expect(mergeArtifactPages(live, older).map((row) => [row.id, row.updatedAt])).toEqual([
      ["b", "2026-10-13T03:00:00.000Z"],
      ["c", "2026-10-13T02:00:00.000Z"],
      ["d", "2026-10-11T00:00:00.000Z"],
    ]);
  });

  it("keeps a row a new artifact pushed out of the live page, so page 2 holds", () => {
    const a = artifact("a", "2026-10-13T03:00:00.000Z");
    const b = artifact("b", "2026-10-13T02:00:00.000Z");
    const c = artifact("c", "2026-10-13T01:00:00.000Z");
    // The live page [a, b] was shown when the older page [c] was fetched.
    const loaded = [a, b, c];
    const fresh = artifact("n", "2026-10-13T04:00:00.000Z");
    const ids = mergeArtifactPages([fresh, a], loaded).map((row) => row.id);
    expect(ids).toEqual(["n", "a", "b", "c"]);
    expect(paginateCollection(ids, 2, 2).items).toEqual(["b", "c"]);
  });

  it("drops a loaded row that left the live range, by updatedAt then id", () => {
    const loaded = [
      artifact("b", "2026-10-13T02:00:00.000Z"),
      artifact("x", "2026-10-13T01:00:00.000Z"),
      artifact("c", "2026-10-13T01:00:00.000Z"),
      artifact("d", "2026-10-12T00:00:00.000Z"),
    ];
    // "b" was archived, so the live page refilled with "x" from below.
    const live = [artifact("a", "2026-10-13T03:00:00.000Z"), loaded[1]!];
    expect(mergeArtifactPages(live, loaded).map((row) => row.id)).toEqual(["a", "x", "c", "d"]);
  });

  it("shows each loaded server page as one full client page before Load older", () => {
    const rows = (prefix: string, updatedAt: string) =>
      Array.from({ length: ARTIFACT_PAGE_SIZE }, (_, index) =>
        artifact(`${prefix}${index}`, updatedAt),
      );
    const loaded = mergeArtifactPages(
      rows("live", "2026-10-13T00:00:00.000Z"),
      rows("older", "2026-10-12T00:00:00.000Z"),
    );
    const first = paginateCollection(loaded, 1, ARTIFACT_PAGE_SIZE);
    const last = paginateCollection(loaded, 2, ARTIFACT_PAGE_SIZE);
    expect([first.items.length, last.items.length, last.pageCount]).toEqual([
      ARTIFACT_PAGE_SIZE,
      ARTIFACT_PAGE_SIZE,
      2,
    ]);
    expect([showLoadOlder(first, true), showLoadOlder(last, true)]).toEqual([false, true]);
  });
});

describe("nextArtifactCursor", () => {
  it("pages after the last row by id and updatedAt", () => {
    expect(nextArtifactCursor([])).toBeUndefined();
    expect(
      nextArtifactCursor([
        artifact("a", "2026-10-13T00:00:00.000Z"),
        artifact("b", "2026-10-12T00:00:00.000Z"),
      ]),
    ).toEqual({ before: "b", beforeUpdatedAt: "2026-10-12T00:00:00.000Z" });
  });
});

describe("previousArtifactVersion", () => {
  it("finds the nearest older version, even with gaps", () => {
    const versions = [version(5), version(3), version(1)];
    expect(previousArtifactVersion(versions, 5)).toBe(3);
    expect(previousArtifactVersion(versions, 3)).toBe(1);
    expect(previousArtifactVersion(versions, 1)).toBeNull();
  });
});

describe("artifact import checks", () => {
  it("accepts HTML and Markdown files by extension or type", () => {
    expect(artifactImportFileError({ name: "page.HTML", type: "", size: 10 })).toBeNull();
    expect(artifactImportFileError({ name: "notes", type: "text/markdown", size: 10 })).toBeNull();
    expect(artifactImportFileError({ name: "photo.png", type: "image/png", size: 10 })).toMatch(
      /not an HTML or Markdown/,
    );
    expect(artifactImportFileError({ name: "a.md", type: "", size: 0 })).toMatch(/empty/);
    expect(
      artifactImportFileError({
        name: "a.md",
        type: "",
        size: COMMAND_CENTER_ARTIFACT_MAX_BYTES + 1,
      }),
    ).toMatch(/larger/);
  });

  it("measures pasted text in UTF-8 bytes", () => {
    expect(artifactImportTextError("  \n")).toMatch(/Paste/);
    expect(artifactImportTextError("# Hi")).toBeNull();
    // Each "é" is two bytes, so this is over the limit by bytes but not by characters.
    expect(artifactImportTextError("é".repeat(COMMAND_CENTER_ARTIFACT_MAX_BYTES / 2 + 1))).toMatch(
      /larger/,
    );
  });
});
