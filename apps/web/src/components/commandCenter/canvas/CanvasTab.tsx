import {
  type Announcements,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useDndMonitor,
  useDraggable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  CommandCenterCanvasDeleteResult,
  CommandCenterCanvasEdge,
  CommandCenterCanvasEdgeId,
  CommandCenterCanvasItem,
  CommandCenterCanvasItemId,
  CommandCenterCanvasItemKind,
  CommandCenterCanvasItemMove,
  CommandCenterCanvasUpsertItemsInput,
  ProjectId,
} from "@t3tools/contracts";
import {
  BrainIcon,
  FileTextIcon,
  ListChecksIcon,
  PlusIcon,
  SplineIcon,
  StickyNoteIcon,
  XIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { CollectionPager } from "../CollectionPager";
import { paginateCollection } from "../collectionPaging";
import { toastManager } from "../../ui/toast";
import { useDocumentVisible } from "../infra/useDocumentVisible";
import { FocusPrompt } from "../ProjectPicker";
import { useCommandCenter } from "../shared";
import { CanvasCardSheet, type CanvasSheetTarget } from "./CanvasCardSheet";
import {
  boardSize,
  CANVAS_ITEM_LIMIT,
  CANVAS_KIND_LABEL,
  CARD_HEIGHT,
  CARD_WIDTH,
  type CanvasCardView,
  type CanvasEdgeInput,
  type CanvasItemInput,
  type CanvasItemPositions,
  type CanvasLookups,
  cardRect,
  clampPosition,
  describeCard,
  edgeSegment,
  hasEdgeBetween,
  placeNewCard,
  type Point,
  pruneSettledPositions,
  type Rect,
  refKey,
  toEdgeInput,
  toItemInput,
} from "./canvasLogic";
import { CanvasPicker } from "./CanvasPicker";

/** Drops within this window go out as one write. */
const MOVE_WRITE_DELAY_MS = 400;

const KIND_ICON = {
  artifact: FileTextIcon,
  section: ListChecksIcon,
  memory: BrainIcon,
  note: StickyNoteIcon,
} as const satisfies Record<CommandCenterCanvasItemKind, unknown>;

/**
 * A project's canvas: cards for artifacts, sections, memory entries and notes, joined by edges.
 * One board per project: the page's project focus.
 */
export function CanvasTab() {
  const { projectId, projects } = useCommandCenter();
  const project = projects.find((candidate) => candidate.id === projectId);
  if (projectId === null || !project) {
    return (
      <FocusPrompt
        text={
          projectId === null
            ? "Choose a project to lay out its artifacts, sections and notes."
            : "This project is not available. It was removed or its machine is offline."
        }
      />
    );
  }
  // Keyed so local drag state never carries over to another project's board.
  return <CanvasBoard key={projectId} projectId={projectId} projectTitle={project.title} />;
}

/** Canvas writes against the primary environment; failures toast and resolve to null. */
function useCanvasCommands(projectId: ProjectId) {
  const { primaryEnvironmentId: environmentId } = useCommandCenter();
  const upsertItems = useAtomCommand(
    serverEnvironment.upsertCommandCenterCanvasItems,
    "command center canvas items",
  );
  const upsertEdges = useAtomCommand(
    serverEnvironment.upsertCommandCenterCanvasEdges,
    "command center canvas edges",
  );
  const remove = useAtomCommand(
    serverEnvironment.deleteCommandCenterCanvasEntries,
    "command center canvas delete",
  );
  return useMemo(() => {
    const report = <A, E>(result: AtomCommandResult<A, E>) => {
      if (result._tag === "Success") return result.value;
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not update the canvas",
          description: String(squashAtomCommandFailure(result)),
        });
      }
      return null;
    };
    return {
      upsertItems: (items: CommandCenterCanvasUpsertItemsInput["items"]) =>
        upsertItems({ environmentId, input: { projectId, items } }).then(report),
      upsertEdges: (edges: ReadonlyArray<CanvasEdgeInput>) =>
        upsertEdges({ environmentId, input: { projectId, edges } }).then(report),
      remove: (
        itemIds: ReadonlyArray<CommandCenterCanvasItemId>,
        edgeIds: ReadonlyArray<CommandCenterCanvasEdgeId>,
      ) => remove({ environmentId, input: { projectId, itemIds, edgeIds } }).then(report),
    };
  }, [environmentId, projectId, remove, upsertEdges, upsertItems]);
}

function CanvasBoard({
  projectId,
  projectTitle,
}: {
  readonly projectId: ProjectId;
  readonly projectTitle: string;
}) {
  const { snapshot, primaryEnvironmentId, canOperate } = useCommandCenter();
  const query = useEnvironmentQuery(
    serverEnvironment.commandCenterCanvas({
      environmentId: primaryEnvironmentId,
      input: { projectId },
    }),
  );
  const canvas = query.data;
  const commands = useCanvasCommands(projectId);
  // The canvas is a one-shot read. Every artifact change (an agent's new version, a rename, a
  // delete) pushes this one-row page, and the board re-reads its cards' rows. It runs only while
  // the window shows, and coming back re-reads too, which also picks up other devices' edits.
  const visible = useDocumentVisible();
  const artifactPulse = useEnvironmentQuery(
    visible
      ? serverEnvironment.commandCenterArtifactsLive({
          environmentId: primaryEnvironmentId,
          input: { limit: 1 },
        })
      : null,
  ).data;
  const refreshCanvas = query.refresh;
  const seenPulse = useRef(false);
  useEffect(() => {
    if (artifactPulse === null) return;
    if (seenPulse.current) refreshCanvas();
    seenPulse.current = true;
  }, [artifactPulse, refreshCanvas]);
  const items = canvas?.items;
  const edges = canvas?.edges;

  const lookups = useMemo(
    (): CanvasLookups => ({
      artifacts: new Map((canvas?.artifacts ?? []).map((row) => [row.id as string, row] as const)),
      sections: new Map(snapshot.sections.map((row) => [row.id as string, row] as const)),
      // The canvas carries the entries its cards point at; the snapshot fills in newer edits.
      memory: new Map(
        [...(canvas?.memory ?? []), ...snapshot.memory].map((row) => [row.id as string, row]),
      ),
    }),
    [canvas?.artifacts, canvas?.memory, snapshot.memory, snapshot.sections],
  );

  // Where this client has put cards the server has not confirmed yet.
  const [positions, setPositions] = useState<CanvasItemPositions>(() => new Map());
  const [seenItems, setSeenItems] = useState(items);
  if (seenItems !== items) {
    setSeenItems(items);
    if (items) setPositions((current) => pruneSettledPositions(current, items));
  }
  const [connectFrom, setConnectFrom] = useState<CommandCenterCanvasItemId | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<CommandCenterCanvasEdgeId | null>(null);
  const [sheet, setSheet] = useState<{
    readonly open: boolean;
    readonly target: CanvasSheetTarget | null;
  }>({ open: false, target: null });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [cardSearch, setCardSearch] = useState("");
  const [cardPage, setCardPage] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Used inside `url(#…)`, so keep only characters that need no escaping.
  const markerId = `cc-canvas-arrow-${useId().replace(/[^\w-]/g, "")}`;

  const itemsById = useMemo(
    () => new Map((items ?? []).map((item) => [item.id as string, item] as const)),
    [items],
  );
  const basePosition = useCallback(
    (item: CommandCenterCanvasItem): Point => positions.get(item.id) ?? item,
    [positions],
  );
  /** Every card's rect where it rests (`CanvasEdges` draws a card being dragged). */
  const rects = useMemo(() => cardRects(items ?? [], basePosition, null), [basePosition, items]);
  // Resolved once per data change, so cards keep their props (and skip rendering) while dragging.
  const views = useMemo(
    () => new Map((items ?? []).map((item) => [item.id as string, describeCard(item, lookups)])),
    [items, lookups],
  );
  const cardDirectory = useMemo(() => {
    const needle = cardSearch.trim().toLocaleLowerCase();
    const rows = (items ?? []).map((item) => ({ item, view: views.get(item.id) }));
    return rows
      .filter(({ item, view }) =>
        `${view?.title ?? ""} ${CANVAS_KIND_LABEL[item.kind]}`.toLocaleLowerCase().includes(needle),
      )
      .toSorted((left, right) => (left.view?.title ?? "").localeCompare(right.view?.title ?? ""));
  }, [cardSearch, items, views]);
  const directory = paginateCollection(cardDirectory, cardPage, 10);
  const size = boardSize(rects.values());
  const onBoard = useMemo(
    () =>
      new Set(
        (items ?? []).flatMap((item) =>
          item.refId === null ? [] : [refKey(item.kind, item.refId)],
        ),
      ),
    [items],
  );

  // Moves wait briefly so a burst of drops becomes one write. Only drops write; dragging never does.
  // Moves carry only the position, so a stale copy of a card never reverts its other fields.
  const pendingMoves = useRef(new Map<string, CommandCenterCanvasItemMove>());
  const moveTimer = useRef<number | null>(null);
  const flushMoves = useCallback(() => {
    moveTimer.current = null;
    const moves = [...pendingMoves.current.values()];
    pendingMoves.current.clear();
    if (moves.length === 0) return;
    void commands.upsertItems(moves).then((saved) => {
      if (saved) return;
      // Put the cards back where the server has them.
      setPositions((current) => {
        const next = new Map(current);
        for (const move of moves) next.delete(move.id);
        return next;
      });
    });
  }, [commands]);
  useEffect(
    () => () => {
      if (moveTimer.current === null) return;
      window.clearTimeout(moveTimer.current);
      flushMoves();
    },
    [flushMoves],
  );

  // New cards land in the middle of what the viewer sees; this remembers spots taken by adds the
  // server has not echoed yet, so quick repeated adds do not stack.
  const placed = useRef<{ items: typeof items; spots: Point[] }>({ items, spots: [] });
  const pendingAdds = () => {
    if (placed.current.items !== items) placed.current = { items, spots: [] };
    return placed.current.spots;
  };
  const nextSpot = () => {
    const scroller = scrollRef.current;
    const start = scroller
      ? {
          x: scroller.scrollLeft + scroller.clientWidth / 2 - CARD_WIDTH / 2,
          y: scroller.scrollTop + scroller.clientHeight / 2 - CARD_HEIGHT / 2,
        }
      : { x: 40, y: 40 };
    const spots = pendingAdds();
    const spot = placeNewCard(start, [...rects.values(), ...spots]);
    spots.push(spot);
    return spot;
  };
  const full = (items?.length ?? 0) >= CANVAS_ITEM_LIMIT;

  const addCard = async (
    card: Pick<CanvasItemInput, "kind" | "refId" | "text">,
  ): Promise<boolean> => {
    if ((items?.length ?? 0) + pendingAdds().length >= CANVAS_ITEM_LIMIT) {
      toastManager.add({
        type: "error",
        title: `A canvas holds up to ${CANVAS_ITEM_LIMIT} cards`,
        description: "Remove a card to make room.",
      });
      return false;
    }
    const spot = nextSpot();
    return (await commands.upsertItems([{ ...card, ...spot, w: null, h: null }])) !== null;
  };

  const restore = async (removed: CommandCenterCanvasDeleteResult) => {
    if (
      removed.items.length > 0 &&
      (await commands.upsertItems(removed.items.map((item) => toItemInput(item)))) === null
    ) {
      return;
    }
    if (removed.edges.length > 0) await commands.upsertEdges(removed.edges.map(toEdgeInput));
  };
  const removeEntries = async (
    itemIds: ReadonlyArray<CommandCenterCanvasItemId>,
    edgeIds: ReadonlyArray<CommandCenterCanvasEdgeId>,
    title: string,
  ) => {
    // A queued move would re-create the card under its id.
    for (const id of itemIds) pendingMoves.current.delete(id);
    const removed = await commands.remove(itemIds, edgeIds);
    if (!removed) return;
    if (connectFrom !== null && itemIds.includes(connectFrom)) setConnectFrom(null);
    if (selectedEdgeId !== null && edgeIds.includes(selectedEdgeId)) setSelectedEdgeId(null);
    const toastId = toastManager.add({
      type: "info",
      title,
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(toastId);
          void restore(removed);
        },
      },
    });
  };
  const removeCard = (id: CommandCenterCanvasItemId) =>
    void removeEntries([id], [], "Card removed from the canvas");
  const removeEdge = (id: CommandCenterCanvasEdgeId) =>
    void removeEntries([], [id], "Connection removed");

  const openCard = (id: CommandCenterCanvasItemId) => {
    if (connectFrom === null) {
      setSheet({ open: true, target: { type: "item", itemId: id } });
      return;
    }
    const from = connectFrom;
    setConnectFrom(null);
    if (from === id) return;
    if (hasEdgeBetween(edges ?? [], from, id)) {
      toastManager.add({ type: "info", title: "Those cards are already connected" });
      return;
    }
    void commands.upsertEdges([{ fromItemId: from, toItemId: id, label: null }]);
  };
  const startConnect = (id: CommandCenterCanvasItemId) => {
    setSelectedEdgeId(null);
    setConnectFrom((current) => (current === id ? null : id));
  };

  const sensors = useSensors(
    // A small threshold keeps a plain click as "open".
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Enter opens a card, so only Space picks one up.
    useSensor(KeyboardSensor, {
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );
  const titleOf = (id: string | number) => {
    const item = itemsById.get(String(id));
    return item ? (views.get(item.id) ?? describeCard(item, lookups)).title : "card";
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}.`,
    onDragOver: () => undefined,
    onDragEnd: ({ active }) => `Placed ${titleOf(active.id)}.`,
    onDragCancel: ({ active }) => `Stopped moving ${titleOf(active.id)}.`,
  };
  const onDragEnd = (event: DragEndEvent) => {
    const item = itemsById.get(String(event.active.id));
    if (!item || (event.delta.x === 0 && event.delta.y === 0)) return;
    const base = basePosition(item);
    const next = clampPosition({ x: base.x + event.delta.x, y: base.y + event.delta.y });
    setPositions((current) => new Map(current).set(item.id, next));
    pendingMoves.current.set(item.id, { id: item.id, ...next });
    if (moveTimer.current !== null) window.clearTimeout(moveTimer.current);
    moveTimer.current = window.setTimeout(flushMoves, MOVE_WRITE_DELAY_MS);
  };

  const onBoardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && (connectFrom !== null || selectedEdgeId !== null)) {
      event.stopPropagation();
      setConnectFrom(null);
      setSelectedEdgeId(null);
    } else if (
      (event.key === "Delete" || event.key === "Backspace") &&
      selectedEdgeId !== null &&
      canOperate &&
      event.target === event.currentTarget
    ) {
      event.preventDefault();
      removeEdge(selectedEdgeId);
    }
  };

  if (!canvas || !items || !edges) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground" role="status">
        {query.error ? `Could not load the canvas: ${query.error}` : "Loading the canvas…"}
      </p>
    );
  }

  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const selectedSegment = selectedEdge
    ? edgeSegment(
        rects.get(selectedEdge.fromItemId) ?? { x: 0, y: 0, w: 0, h: 0 },
        rects.get(selectedEdge.toItemId) ?? { x: 0, y: 0, w: 0, h: 0 },
      )
    : null;
  const sheetItem =
    sheet.target?.type === "item" ? (itemsById.get(sheet.target.itemId) ?? null) : null;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 truncate text-sm font-medium">{projectTitle}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {items.length} / {CANVAS_ITEM_LIMIT} cards
        </span>
        <div className="min-w-0 flex-1" />
        {connectFrom !== null ? (
          <p className="text-xs text-muted-foreground" role="status">
            Pick a card to connect to {titleOf(connectFrom)}. Esc cancels.
          </p>
        ) : null}
        {canOperate ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={full}
              onClick={() => setSheet({ open: true, target: { type: "new-note" } })}
            >
              <StickyNoteIcon />
              Add note
            </Button>
            <Button size="sm" variant="outline" disabled={full} onClick={() => setPickerOpen(true)}>
              <PlusIcon />
              Add existing
            </Button>
          </>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {canOperate
            ? "Add a note, or put this project's artifacts, sections and memory on the board. Drag cards to arrange them and connect related ones."
            : "This canvas is empty."}
        </p>
      ) : full ? (
        <p className="text-xs text-muted-foreground">
          This canvas is full. Remove a card to add another.
        </p>
      ) : null}

      {items.length > 0 ? (
        <details className="rounded-xl border bg-card p-3">
          <summary className="cursor-pointer text-sm font-medium focus-visible:outline-ring">
            Find a card · {items.length}
          </summary>
          <div className="pt-3">
            <Input
              type="search"
              aria-label="Search canvas cards"
              placeholder="Search card title or type"
              value={cardSearch}
              onChange={(event) => {
                setCardSearch(event.target.value);
                setCardPage(1);
              }}
            />
            {directory.total === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                No canvas cards match your search.
              </p>
            ) : null}
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {directory.items.map(({ item, view }) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-start text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    onClick={() => {
                      const scroller = scrollRef.current;
                      const rect = rects.get(item.id);
                      if (!scroller || !rect) return;
                      scroller.scrollTo({
                        left: Math.max(0, rect.x + rect.w / 2 - scroller.clientWidth / 2),
                        top: Math.max(0, rect.y + rect.h / 2 - scroller.clientHeight / 2),
                      });
                      scroller.scrollIntoView({ block: "nearest" });
                      scroller.focus({ preventScroll: true });
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{view?.title ?? "Card"}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {CANVAS_KIND_LABEL[item.kind]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <CollectionPager {...directory} label="canvas cards" onPageChange={setCardPage} />
          </div>
        </details>
      ) : null}

      <DndContext
        sensors={sensors}
        accessibility={{ announcements }}
        onDragStart={() => setSelectedEdgeId(null)}
        onDragEnd={onDragEnd}
      >
        {/* The board scrolls natively, so a wheel, trackpad or scrollbar pans it. */}
        <div
          ref={scrollRef}
          tabIndex={0}
          role="region"
          aria-label={`${projectTitle} canvas`}
          className="relative h-[min(70vh,720px)] overflow-auto overscroll-contain rounded-xl border bg-muted/30 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onKeyDown={onBoardKeyDown}
          onPointerDown={(event) => {
            if (
              event.target === event.currentTarget ||
              event.target === event.currentTarget.firstChild
            ) {
              setSelectedEdgeId(null);
            }
          }}
        >
          <div className="relative" style={{ width: size.width, height: size.height }}>
            <CanvasEdges
              items={items}
              edges={edges}
              positionOf={basePosition}
              size={size}
              markerId={markerId}
              selectedEdgeId={selectedEdgeId}
              canOperate={canOperate}
              onEdgeClick={(edgeId) => {
                setConnectFrom(null);
                setSelectedEdgeId((current) => (current === edgeId ? null : edgeId));
                scrollRef.current?.focus({ preventScroll: true });
              }}
            />
            {items.map((item) => (
              <CanvasCard
                key={item.id}
                item={item}
                position={basePosition(item)}
                view={views.get(item.id) ?? describeCard(item, lookups)}
                canOperate={canOperate}
                connectSource={connectFrom === item.id}
                connecting={connectFrom !== null}
                onOpen={openCard}
                onConnect={startConnect}
                onRemove={removeCard}
              />
            ))}
            {selectedEdge && selectedSegment ? (
              <Button
                size="icon-xs"
                variant="outline"
                aria-label="Remove connection"
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{
                  left: (selectedSegment.start.x + selectedSegment.end.x) / 2,
                  top: (selectedSegment.start.y + selectedSegment.end.y) / 2,
                }}
                onClick={() => removeEdge(selectedEdge.id)}
              >
                <XIcon />
              </Button>
            ) : null}
          </div>
        </div>
      </DndContext>

      <CanvasCardSheet
        open={sheet.open}
        onOpenChange={(open) => setSheet((current) => ({ ...current, open }))}
        target={sheet.target}
        item={sheetItem}
        view={sheetItem ? describeCard(sheetItem, lookups) : null}
        lookups={lookups}
        items={items}
        edges={edges}
        canOperate={canOperate}
        onCreateNote={async (text) => {
          const created = await addCard({ kind: "note", refId: null, text });
          if (created) setSheet((current) => ({ ...current, open: false }));
        }}
        onSaveNote={async (item, text) => {
          // This write carries the card's current spot, so a queued move is folded into it.
          pendingMoves.current.delete(item.id);
          await commands.upsertItems([{ ...toItemInput(item, basePosition(item)), text }]);
        }}
        onRemoveEdge={removeEdge}
      />
      {pickerOpen ? (
        <CanvasPicker
          projectId={projectId}
          onBoard={onBoard}
          onOpenChange={setPickerOpen}
          onAdd={(kind, refId) => addCard({ kind, refId, text: null })}
        />
      ) : null}
    </section>
  );
}

/** Rects of `items` at their resting spots, with the dragged card (if any) offset by its delta. */
function cardRects(
  items: ReadonlyArray<CommandCenterCanvasItem>,
  positionOf: (item: CommandCenterCanvasItem) => Point,
  drag: { readonly id: string; readonly delta: Point } | null,
) {
  const result = new Map<string, Rect>();
  for (const item of items) {
    const base = positionOf(item);
    result.set(
      item.id,
      cardRect(
        item,
        drag?.id === item.id ? { x: base.x + drag.delta.x, y: base.y + drag.delta.y } : base,
      ),
    );
  }
  return result;
}

/**
 * The connection lines. It follows a dragged card through dnd-kit's monitor itself, so a drag
 * re-renders this layer and the dragged card only, never every card on the board.
 */
function CanvasEdges({
  items,
  edges,
  positionOf,
  size,
  markerId,
  selectedEdgeId,
  canOperate,
  onEdgeClick,
}: {
  readonly items: ReadonlyArray<CommandCenterCanvasItem>;
  readonly edges: ReadonlyArray<CommandCenterCanvasEdge>;
  readonly positionOf: (item: CommandCenterCanvasItem) => Point;
  readonly size: { readonly width: number; readonly height: number };
  readonly markerId: string;
  readonly selectedEdgeId: CommandCenterCanvasEdgeId | null;
  readonly canOperate: boolean;
  readonly onEdgeClick: (edgeId: CommandCenterCanvasEdgeId) => void;
}) {
  const [drag, setDrag] = useState<{ readonly id: string; readonly delta: Point } | null>(null);
  useDndMonitor({
    onDragMove: (event) => setDrag({ id: String(event.active.id), delta: event.delta }),
    onDragEnd: () => setDrag(null),
    onDragCancel: () => setDrag(null),
  });
  const rects = useMemo(() => cardRects(items, positionOf, drag), [drag, items, positionOf]);
  return (
    <svg
      className="pointer-events-none absolute inset-0 overflow-visible"
      width={size.width}
      height={size.height}
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="8"
          markerHeight="8"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L8,4 L0,8 z" className="fill-muted-foreground" />
        </marker>
      </defs>
      {edges.map((edge) => {
        const from = rects.get(edge.fromItemId);
        const to = rects.get(edge.toItemId);
        const segment = from && to ? edgeSegment(from, to) : null;
        if (!segment) return null;
        const selected = edge.id === selectedEdgeId;
        return (
          <g key={edge.id}>
            <line
              x1={segment.start.x}
              y1={segment.start.y}
              x2={segment.end.x}
              y2={segment.end.y}
              className={cn("stroke-muted-foreground", selected && "stroke-primary")}
              strokeWidth={selected ? 2 : 1.5}
              markerEnd={`url(#${markerId})`}
            />
            {canOperate ? (
              // Wide invisible stroke so the thin line is easy to click.
              <line
                x1={segment.start.x}
                y1={segment.start.y}
                x2={segment.end.x}
                y2={segment.end.y}
                stroke="transparent"
                strokeWidth={12}
                className="pointer-events-auto cursor-pointer"
                onClick={() => onEdgeClick(edge.id)}
              />
            ) : null}
            {edge.label ? (
              <text
                x={(segment.start.x + segment.end.x) / 2}
                y={(segment.start.y + segment.end.y) / 2 - 6}
                textAnchor="middle"
                className="fill-muted-foreground text-2xs"
              >
                {edge.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function CanvasCard({
  item,
  position,
  view,
  canOperate,
  connectSource,
  connecting,
  onOpen,
  onConnect,
  onRemove,
}: {
  readonly item: CommandCenterCanvasItem;
  readonly position: Point;
  readonly view: CanvasCardView;
  readonly canOperate: boolean;
  readonly connectSource: boolean;
  readonly connecting: boolean;
  readonly onOpen: (id: CommandCenterCanvasItemId) => void;
  readonly onConnect: (id: CommandCenterCanvasItemId) => void;
  readonly onRemove: (id: CommandCenterCanvasItemId) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: item.id,
    disabled: !canOperate,
  });
  const rect = cardRect(item, position);
  const Icon = KIND_ICON[item.kind];
  const kindLabel = CANVAS_KIND_LABEL[item.kind];
  return (
    <div
      className={cn("group/card absolute", isDragging && "z-10")}
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        transform: CSS.Translate.toString(transform),
      }}
    >
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        aria-roledescription="canvas card"
        aria-label={`${kindLabel}: ${view.title}`}
        onClick={() => onOpen(item.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onOpen(item.id);
          } else if ((event.key === "Delete" || event.key === "Backspace") && canOperate) {
            event.preventDefault();
            onRemove(item.id);
          } else {
            listeners?.onKeyDown?.(event);
          }
        }}
        className={cn(
          "flex size-full cursor-pointer touch-none flex-col gap-1 overflow-hidden rounded-lg border bg-card p-3 pe-16 text-start shadow-xs outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          canOperate && "cursor-grab",
          isDragging && "cursor-grabbing shadow-md",
          connecting && !connectSource && "cursor-crosshair hover:border-primary",
          connectSource && "border-primary ring-2 ring-primary/40 ring-inset",
          view.missing && "border-dashed text-muted-foreground",
        )}
      >
        <span className="flex items-center gap-1.5 text-2xs font-medium text-muted-foreground">
          <Icon className="size-3.5 shrink-0" />
          {kindLabel}
        </span>
        <span className="line-clamp-2 text-sm leading-snug font-medium wrap-anywhere">
          {view.title}
        </span>
        {view.detail ? (
          <span className="truncate text-xs text-muted-foreground">{view.detail}</span>
        ) : null}
      </div>
      {canOperate ? (
        <div className="absolute end-1.5 top-1.5 flex gap-0.5 opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100 pointer-coarse:opacity-100">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={connectSource ? "Cancel connecting" : "Connect to another card"}
            aria-pressed={connectSource}
            onClick={() => onConnect(item.id)}
          >
            <SplineIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost-destructive"
            aria-label="Remove from canvas"
            onClick={() => onRemove(item.id)}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
