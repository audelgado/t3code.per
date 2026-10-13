import type { CommandCenterCanvasItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardSize,
  CARD_HEIGHT,
  CARD_WIDTH,
  cardRect,
  clampPosition,
  describeCard,
  edgeSegment,
  hasEdgeBetween,
  placeNewCard,
  pruneSettledPositions,
  toItemInput,
} from "./canvasLogic";

const item = (id: string, x: number, y: number): CommandCenterCanvasItem =>
  ({
    id,
    projectId: "p1",
    kind: "note",
    refId: null,
    text: "hi",
    x,
    y,
    w: null,
    h: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as CommandCenterCanvasItem;

describe("edgeSegment", () => {
  it("runs from border to border between side-by-side cards", () => {
    const segment = edgeSegment({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 0, w: 100, h: 50 });
    expect(segment).toEqual({ start: { x: 100, y: 25 }, end: { x: 300, y: 25 } });
  });

  it("leaves through the top or bottom when the cards are stacked", () => {
    const segment = edgeSegment({ x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 200, w: 100, h: 50 });
    expect(segment).toEqual({ start: { x: 50, y: 50 }, end: { x: 50, y: 200 } });
  });

  it("clips diagonals to the nearer border", () => {
    const segment = edgeSegment({ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 400, w: 100, h: 100 });
    // Mostly vertical: exits through the bottom edge, half a card down.
    expect(segment?.start).toEqual({ x: 75, y: 100 });
    expect(segment?.end).toEqual({ x: 225, y: 400 });
  });

  it("draws nothing between overlapping cards", () => {
    expect(edgeSegment({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 })).toBe(
      null,
    );
  });
});

describe("placement", () => {
  it("steps past cards sitting at the same spot", () => {
    expect(
      placeNewCard({ x: 100.4, y: 50 }, [
        { x: 100, y: 50 },
        { x: 124, y: 74 },
      ]),
    ).toEqual({ x: 148, y: 98 });
  });

  it("keeps positions whole and on the board", () => {
    expect(clampPosition({ x: -20, y: 10.6 })).toEqual({ x: 0, y: 11 });
  });

  it("grows the board past the furthest card", () => {
    expect(boardSize([])).toEqual({ width: 1600, height: 900 });
    const size = boardSize([cardRect(item("a", 2000, 1000))]);
    expect(size.width).toBe(2000 + CARD_WIDTH + 480);
    expect(size.height).toBe(1000 + CARD_HEIGHT + 480);
  });
});

describe("edges and positions", () => {
  it("treats a connection as undirected when checking for duplicates", () => {
    const edges = [{ fromItemId: "a", toItemId: "b" }];
    expect(hasEdgeBetween(edges, "b", "a")).toBe(true);
    expect(hasEdgeBetween(edges, "a", "c")).toBe(false);
  });

  it("keeps a moved card's id and content when re-saving it", () => {
    expect(toItemInput(item("a", 1, 2), { x: 30, y: 40 })).toEqual({
      id: "a",
      kind: "note",
      refId: null,
      text: "hi",
      x: 30,
      y: 40,
      w: null,
      h: null,
    });
  });

  it("drops local positions once the server has them", () => {
    const local = new Map([
      ["a", { x: 10, y: 10 }],
      ["b", { x: 99, y: 99 }],
      ["gone", { x: 1, y: 1 }],
    ]);
    const pruned = pruneSettledPositions(local, [item("a", 10, 10), item("b", 0, 0)]);
    expect([...pruned.keys()]).toEqual(["b"]);
    const unchanged = new Map([["b", { x: 99, y: 99 }]]);
    expect(pruneSettledPositions(unchanged, [item("b", 0, 0)])).toBe(unchanged);
  });
});

describe("describeCard", () => {
  const lookups = { artifacts: new Map(), sections: new Map(), memory: new Map() };

  it("shows a note's first line", () => {
    const note = { ...item("n", 0, 0), text: "  Ship it\nthen rest" };
    expect(describeCard(note, lookups)).toEqual({ title: "Ship it", detail: null, missing: false });
  });

  it("marks a card whose row was deleted", () => {
    const card = { ...item("a", 0, 0), kind: "artifact" as const, refId: "gone", text: null };
    expect(describeCard(card, lookups)).toMatchObject({ missing: true });
  });

  it("summarises a section's status and tasks", () => {
    const section = { id: "s1", name: "Auth", status: "in_progress", tasksDone: 2, tasksTotal: 5 };
    const card = { ...item("s", 0, 0), kind: "section" as const, refId: "s1", text: null };
    expect(
      describeCard(card, {
        ...lookups,
        sections: new Map([["s1", section as never]]),
      }),
    ).toEqual({ title: "Auth", detail: "In progress · 2/5 tasks", missing: false });
  });
});
