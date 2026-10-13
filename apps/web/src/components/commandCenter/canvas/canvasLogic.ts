import {
  COMMAND_CENTER_CANVAS_ITEM_LIMIT,
  type CommandCenterArtifact,
  type CommandCenterCanvasEdge,
  type CommandCenterCanvasItem,
  type CommandCenterCanvasItemKind,
  type CommandCenterCanvasItemMove,
  type CommandCenterCanvasUpsertEdgesInput,
  type CommandCenterCanvasUpsertItemsInput,
  type CommandCenterMemoryEntry,
  type CommandCenterSection,
} from "@t3tools/contracts";

import { SECTION_STATUS_LABEL } from "../projects/logic";

/** Default card size; a card with stored `w`/`h` uses those instead. */
export const CARD_WIDTH = 224;
export const CARD_HEIGHT = 96;
/** Cards per board (the server enforces it too). Every card renders; there is no virtualization. */
export const CANVAS_ITEM_LIMIT = COMMAND_CENTER_CANVAS_ITEM_LIMIT;
/** Empty space kept right of and below the furthest card, so there is room to drag into. */
const BOARD_PADDING = 480;
const BOARD_MIN_WIDTH = 1600;
const BOARD_MIN_HEIGHT = 900;
/** How far each new card steps from one already sitting at the same spot. */
const CASCADE_STEP = 24;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect extends Point {
  readonly w: number;
  readonly h: number;
}

export type CanvasItemPositions = ReadonlyMap<string, Point>;

export function cardRect(item: CommandCenterCanvasItem, position: Point = item): Rect {
  return { x: position.x, y: position.y, w: item.w ?? CARD_WIDTH, h: item.h ?? CARD_HEIGHT };
}

/** Positions are whole CSS pixels and never left of or above the board's origin. */
export function clampPosition(point: Point): Point {
  return { x: Math.max(0, Math.round(point.x)), y: Math.max(0, Math.round(point.y)) };
}

/** Size of the scrollable board: the furthest card plus padding, never below the minimum. */
export function boardSize(rects: Iterable<Rect>) {
  let width = BOARD_MIN_WIDTH;
  let height = BOARD_MIN_HEIGHT;
  for (const rect of rects) {
    width = Math.max(width, rect.x + rect.w + BOARD_PADDING);
    height = Math.max(height, rect.y + rect.h + BOARD_PADDING);
  }
  return { width, height };
}

/** Where a straight line from the rect's centre towards `direction` leaves the rect. */
function exitPoint(rect: Rect, dx: number, dy: number): Point {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : rect.w / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : rect.h / 2 / Math.abs(dy),
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/**
 * The visible part of an edge: from the border of `from` to the border of `to`, along the line
 * between their centres. Null when the cards overlap, since no line would show between them.
 */
export function edgeSegment(from: Rect, to: Rect): { start: Point; end: Point } | null {
  const overlap =
    from.x < to.x + to.w &&
    to.x < from.x + from.w &&
    from.y < to.y + to.h &&
    to.y < from.y + from.h;
  if (overlap) return null;
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  return { start: exitPoint(from, dx, dy), end: exitPoint(to, -dx, -dy) };
}

/** True when the two cards are already connected, in either direction. */
export function hasEdgeBetween(
  edges: ReadonlyArray<{ readonly fromItemId: string; readonly toItemId: string }>,
  a: string,
  b: string,
) {
  return edges.some(
    (edge) =>
      (edge.fromItemId === a && edge.toItemId === b) ||
      (edge.fromItemId === b && edge.toItemId === a),
  );
}

/**
 * Spot for a new card: `start` (the middle of what the viewer sees), stepped down and right past
 * any card already sitting exactly there, so repeated adds stay visible instead of stacking.
 */
export function placeNewCard(start: Point, taken: Iterable<Point>): Point {
  const occupied = new Set<string>();
  for (const point of taken) occupied.add(`${point.x},${point.y}`);
  let next = clampPosition(start);
  for (let step = 0; step < 50 && occupied.has(`${next.x},${next.y}`); step++) {
    next = { x: next.x + CASCADE_STEP, y: next.y + CASCADE_STEP };
  }
  return next;
}

/** A whole card to create or replace; a move (`{ id, x, y }`) is the other upsert shape. */
export type CanvasItemInput = Exclude<
  CommandCenterCanvasUpsertItemsInput["items"][number],
  CommandCenterCanvasItemMove
>;

/** A stored card as upsert input, optionally moved; re-saving it under its id restores it. */
export function toItemInput(
  item: CommandCenterCanvasItem,
  position: Point = item,
): CanvasItemInput {
  return {
    id: item.id,
    kind: item.kind,
    refId: item.refId,
    text: item.text,
    x: position.x,
    y: position.y,
    w: item.w,
    h: item.h,
  };
}

export type CanvasEdgeInput = CommandCenterCanvasUpsertEdgesInput["edges"][number];

export function toEdgeInput(edge: CommandCenterCanvasEdge): CanvasEdgeInput {
  return { id: edge.id, fromItemId: edge.fromItemId, toItemId: edge.toItemId, label: edge.label };
}

export interface CanvasLookups {
  readonly artifacts: ReadonlyMap<string, CommandCenterArtifact>;
  readonly sections: ReadonlyMap<string, CommandCenterSection>;
  readonly memory: ReadonlyMap<string, CommandCenterMemoryEntry>;
}

export interface CanvasCardView {
  readonly title: string;
  readonly detail: string | null;
  /** The artifact, section or memory entry it points at is gone. */
  readonly missing: boolean;
}

export const CANVAS_KIND_LABEL = {
  artifact: "Artifact",
  section: "Section",
  memory: "Memory",
  note: "Note",
} as const satisfies Record<CommandCenterCanvasItemKind, string>;

const clip = (text: string, max: number) => {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What a card shows, resolved from the row it points at. */
export function describeCard(
  item: CommandCenterCanvasItem,
  lookups: CanvasLookups,
): CanvasCardView {
  const missing = (title: string) => ({ title, detail: null, missing: true });
  switch (item.kind) {
    case "note":
      return { title: clip(item.text ?? "", 160) || "Empty note", detail: null, missing: false };
    case "artifact": {
      const artifact = item.refId === null ? undefined : lookups.artifacts.get(item.refId);
      if (!artifact) return missing("Artifact no longer exists");
      const kind = artifact.kind === "html" ? "HTML" : "Markdown";
      return {
        title: artifact.title,
        detail: `${kind} · v${artifact.currentVersion}${artifact.archivedAt ? " · deleted" : ""}`,
        missing: false,
      };
    }
    case "section": {
      const section = item.refId === null ? undefined : lookups.sections.get(item.refId);
      if (!section) return missing("Section no longer exists");
      return {
        title: section.name,
        detail: `${SECTION_STATUS_LABEL[section.status]} · ${section.tasksDone}/${section.tasksTotal} tasks`,
        missing: false,
      };
    }
    case "memory": {
      const entry = item.refId === null ? undefined : lookups.memory.get(item.refId);
      if (!entry) return missing("Memory entry no longer exists");
      return {
        title: clip(entry.text, 160),
        detail: entry.kind.charAt(0).toUpperCase() + entry.kind.slice(1),
        missing: false,
      };
    }
  }
}

/** Key for "is this row already on the board", shared by the board and the picker. */
export const refKey = (kind: CommandCenterCanvasItemKind, refId: string) => `${kind}:${refId}`;

/** Drops the local positions the server has caught up with; keeps the identity when nothing did. */
export function pruneSettledPositions(
  positions: CanvasItemPositions,
  items: ReadonlyArray<CommandCenterCanvasItem>,
): CanvasItemPositions {
  if (positions.size === 0) return positions;
  const byId = new Map(items.map((item) => [item.id as string, item] as const));
  const next = new Map<string, Point>();
  for (const [id, point] of positions) {
    const item = byId.get(id);
    if (item && (item.x !== point.x || item.y !== point.y)) next.set(id, point);
  }
  return next.size === positions.size ? positions : next;
}
