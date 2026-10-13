import {
  COMMAND_CENTER_ARTIFACT_MAX_BYTES,
  CommandCenterArtifactId,
  type CommandCenterArtifact,
  type CommandCenterArtifactVersion,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  artifactImportFileError,
  artifactImportTextError,
  livePageBoundary,
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

describe("livePageBoundary", () => {
  it("changes only when the oldest live row does", () => {
    const tail = artifact("z", "2026-10-01T00:00:00.000Z");
    const before = livePageBoundary([artifact("a", "2026-10-12T00:00:00.000Z"), tail]);
    expect(livePageBoundary([artifact("a", "2026-10-13T00:00:00.000Z"), tail])).toBe(before);
    expect(
      livePageBoundary([
        artifact("n", "2026-10-13T00:00:00.000Z"),
        artifact("a", "2026-10-12T00:00:00.000Z"),
      ]),
    ).not.toBe(before);
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
