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
import type {
  CommandCenterWorkflow,
  CommandCenterWorkflowEdge,
  CommandCenterWorkflowNode,
  CommandCenterWorkflowNodeId,
  CommandCenterWorkflowNodeKind,
} from "@t3tools/contracts";
import {
  BotIcon,
  CircleAlertIcon,
  GitForkIcon,
  MessageCircleQuestionIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SplineIcon,
  XIcon,
} from "lucide-react";
import { type KeyboardEvent, useId, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  boardSize,
  clampPosition,
  edgeSegment,
  type Point,
  type Rect,
} from "../canvas/canvasLogic";
import {
  NODE_HEIGHT,
  NODE_KIND_LABEL,
  NODE_WIDTH,
  type NodeRunState,
  nodeTitle,
  STEP_STATUS_LABEL,
  statusVariant,
} from "./workflowLogic";

export const NODE_KIND_ICON = {
  agent: BotIcon,
  skill: SparklesIcon,
  ask: MessageCircleQuestionIcon,
  parallel: GitForkIcon,
  gate: ShieldCheckIcon,
} as const satisfies Record<CommandCenterWorkflowNodeKind, unknown>;

const STATUS_BORDER = {
  pending: "",
  skipped: "border-dashed",
  running: "border-info/70",
  waiting: "border-warning/70",
  succeeded: "border-success/60",
  failed: "border-destructive/70",
  stopped: "border-dashed border-muted-foreground/60",
} as const satisfies Record<NodeRunState["status"], string>;

const edgeKey = (edge: CommandCenterWorkflowEdge) => `${edge.from}\u0000${edge.to}`;
const rectAt = (point: Point): Rect => ({ ...point, w: NODE_WIDTH, h: NODE_HEIGHT });

interface CanvasProps {
  readonly label: string;
  readonly workflow: CommandCenterWorkflow;
  readonly positions: ReadonlyMap<string, Point>;
  readonly selectedId: string | null;
  readonly onSelect: (id: CommandCenterWorkflowNodeId | null) => void;
  /** One line under each node's title. */
  readonly describe: (node: CommandCenterWorkflowNode) => string | null;
  /** Editor only: dragging, connecting, removing. */
  readonly edit?: {
    readonly problems: ReadonlyMap<string, ReadonlyArray<string>>;
    readonly onMove: (id: CommandCenterWorkflowNodeId, at: Point) => void;
    readonly onConnect: (
      from: CommandCenterWorkflowNodeId,
      to: CommandCenterWorkflowNodeId,
    ) => void;
    readonly onDisconnect: (edge: CommandCenterWorkflowEdge) => void;
    readonly onRemove: (id: CommandCenterWorkflowNodeId) => void;
  };
  /** Run view only: each node's step state. */
  readonly runStates?: ReadonlyMap<string, NodeRunState>;
}

/**
 * A workflow graph: nodes at their layout spots and SVG arrows for edges, with a dashed link
 * from each parallel node to the node it fans out. Static; nothing animates.
 */
export function WorkflowCanvas({
  label,
  workflow,
  positions,
  selectedId,
  onSelect,
  describe,
  edit,
  runStates,
}: CanvasProps) {
  const [connectFrom, setConnectFrom] = useState<CommandCenterWorkflowNodeId | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  // Used inside `url(#…)`, so keep only characters that need no escaping.
  const markerId = `cc-workflow-arrow-${useId().replace(/[^\w-]/g, "")}`;
  const positionOf = (id: string) => positions.get(id) ?? { x: 0, y: 0 };
  const size = boardSize([...positions.values()].map(rectAt));
  const byId = useMemo(
    () => new Map(workflow.nodes.map((node) => [node.id as string, node] as const)),
    [workflow.nodes],
  );
  const titleOf = (id: string | number) => {
    const node = byId.get(String(id));
    return node ? nodeTitle(node) : "step";
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Enter selects a node, so only Space picks one up.
    useSensor(KeyboardSensor, {
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}.`,
    onDragOver: () => undefined,
    onDragEnd: ({ active }) => `Placed ${titleOf(active.id)}.`,
    onDragCancel: ({ active }) => `Stopped moving ${titleOf(active.id)}.`,
  };
  const onDragEnd = (event: DragEndEvent) => {
    const node = byId.get(String(event.active.id));
    if (!edit || !node || (event.delta.x === 0 && event.delta.y === 0)) return;
    const base = positionOf(node.id);
    edit.onMove(node.id, clampPosition({ x: base.x + event.delta.x, y: base.y + event.delta.y }));
  };

  const activate = (id: CommandCenterWorkflowNodeId) => {
    setSelectedEdge(null);
    if (connectFrom === null || !edit) {
      onSelect(id);
      return;
    }
    setConnectFrom(null);
    if (connectFrom !== id) edit.onConnect(connectFrom, id);
  };

  const edgeToRemove = edit
    ? (workflow.edges.find((edge) => edgeKey(edge) === selectedEdge) ?? null)
    : null;
  const removeSegment = edgeToRemove
    ? edgeSegment(rectAt(positionOf(edgeToRemove.from)), rectAt(positionOf(edgeToRemove.to)))
    : null;

  const onBoardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && (connectFrom !== null || selectedEdge !== null)) {
      event.stopPropagation();
      setConnectFrom(null);
      setSelectedEdge(null);
    } else if (
      (event.key === "Delete" || event.key === "Backspace") &&
      edgeToRemove &&
      edit &&
      event.target === event.currentTarget
    ) {
      event.preventDefault();
      setSelectedEdge(null);
      edit.onDisconnect(edgeToRemove);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {connectFrom !== null ? (
        <p className="text-xs text-muted-foreground" role="status">
          Pick the step that runs after {titleOf(connectFrom)}. Esc cancels.
        </p>
      ) : null}
      <DndContext sensors={sensors} accessibility={{ announcements }} onDragEnd={onDragEnd}>
        {/* The board scrolls natively, so a wheel, trackpad or scrollbar pans it. */}
        <div
          tabIndex={0}
          role="region"
          aria-label={label}
          className="relative h-[min(65vh,680px)] overflow-auto overscroll-contain rounded-xl border bg-muted/30 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onKeyDown={onBoardKeyDown}
          onPointerDown={(event) => {
            if (
              event.target === event.currentTarget ||
              event.target === event.currentTarget.firstChild
            ) {
              setSelectedEdge(null);
              onSelect(null);
            }
          }}
        >
          <div className="relative" style={{ width: size.width, height: size.height }}>
            <CanvasEdges
              workflow={workflow}
              positions={positions}
              size={size}
              markerId={markerId}
              selectedEdge={selectedEdge}
              onEdgeClick={
                edit
                  ? (key) => {
                      setConnectFrom(null);
                      setSelectedEdge((current) => (current === key ? null : key));
                    }
                  : null
              }
            />
            {workflow.nodes.map((node) => (
              <CanvasNode
                key={node.id}
                node={node}
                position={positionOf(node.id)}
                detail={describe(node)}
                selected={selectedId === node.id}
                editable={edit !== undefined}
                problem={edit?.problems.has(node.id) ?? false}
                runState={runStates?.get(node.id) ?? null}
                connectSource={connectFrom === node.id}
                connecting={connectFrom !== null}
                onActivate={activate}
                onConnect={(id) => {
                  setSelectedEdge(null);
                  setConnectFrom((current) => (current === id ? null : id));
                }}
                onRemove={(id) => {
                  if (connectFrom === id) setConnectFrom(null);
                  edit?.onRemove(id);
                }}
              />
            ))}
            {edgeToRemove && removeSegment ? (
              <Button
                size="icon-xs"
                variant="outline"
                aria-label="Remove connection"
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{
                  left: (removeSegment.start.x + removeSegment.end.x) / 2,
                  top: (removeSegment.start.y + removeSegment.end.y) / 2,
                }}
                onClick={() => {
                  setSelectedEdge(null);
                  edit?.onDisconnect(edgeToRemove);
                }}
              >
                <XIcon />
              </Button>
            ) : null}
          </div>
        </div>
      </DndContext>
    </div>
  );
}

/** The arrows. Follows a dragged node through dnd-kit's monitor, so a drag re-renders only this. */
function CanvasEdges({
  workflow,
  positions,
  size,
  markerId,
  selectedEdge,
  onEdgeClick,
}: {
  readonly workflow: CommandCenterWorkflow;
  readonly positions: ReadonlyMap<string, Point>;
  readonly size: { readonly width: number; readonly height: number };
  readonly markerId: string;
  readonly selectedEdge: string | null;
  readonly onEdgeClick: ((key: string) => void) | null;
}) {
  const [drag, setDrag] = useState<{ readonly id: string; readonly delta: Point } | null>(null);
  useDndMonitor({
    onDragMove: (event) => setDrag({ id: String(event.active.id), delta: event.delta }),
    onDragEnd: () => setDrag(null),
    onDragCancel: () => setDrag(null),
  });
  const rectOf = (id: string) => {
    const base = positions.get(id);
    if (!base) return null;
    return rectAt(drag?.id === id ? { x: base.x + drag.delta.x, y: base.y + drag.delta.y } : base);
  };
  const segmentOf = (from: string, to: string) => {
    const a = rectOf(from);
    const b = rectOf(to);
    return a && b ? edgeSegment(a, b) : null;
  };
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
      {workflow.nodes.map((node) => {
        if (node.kind !== "parallel") return null;
        const segment = segmentOf(node.id, node.node);
        return segment ? (
          <line
            key={`body:${node.id}`}
            x1={segment.start.x}
            y1={segment.start.y}
            x2={segment.end.x}
            y2={segment.end.y}
            className="stroke-muted-foreground/70"
            strokeWidth={1.5}
            strokeDasharray="4 4"
          />
        ) : null;
      })}
      {workflow.edges.map((edge) => {
        const segment = segmentOf(edge.from, edge.to);
        if (!segment) return null;
        const key = edgeKey(edge);
        const selected = key === selectedEdge;
        return (
          <g key={key}>
            <line
              x1={segment.start.x}
              y1={segment.start.y}
              x2={segment.end.x}
              y2={segment.end.y}
              className={cn("stroke-muted-foreground", selected && "stroke-primary")}
              strokeWidth={selected ? 2 : 1.5}
              markerEnd={`url(#${markerId})`}
            />
            {onEdgeClick ? (
              // Wide invisible stroke so the thin line is easy to click.
              <line
                x1={segment.start.x}
                y1={segment.start.y}
                x2={segment.end.x}
                y2={segment.end.y}
                stroke="transparent"
                strokeWidth={12}
                className="pointer-events-auto cursor-pointer"
                onClick={() => onEdgeClick(key)}
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function CanvasNode({
  node,
  position,
  detail,
  selected,
  editable,
  problem,
  runState,
  connectSource,
  connecting,
  onActivate,
  onConnect,
  onRemove,
}: {
  readonly node: CommandCenterWorkflowNode;
  readonly position: Point;
  readonly detail: string | null;
  readonly selected: boolean;
  readonly editable: boolean;
  readonly problem: boolean;
  readonly runState: NodeRunState | null;
  readonly connectSource: boolean;
  readonly connecting: boolean;
  readonly onActivate: (id: CommandCenterWorkflowNodeId) => void;
  readonly onConnect: (id: CommandCenterWorkflowNodeId) => void;
  readonly onRemove: (id: CommandCenterWorkflowNodeId) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: node.id,
    disabled: !editable,
  });
  const Icon = NODE_KIND_ICON[node.kind];
  const title = nodeTitle(node);
  const status = runState?.status ?? null;
  const items = runState && runState.steps.length > 1 ? runState.steps : null;
  return (
    <div
      className={cn("group/node absolute", isDragging && "z-10")}
      style={{
        left: position.x,
        top: position.y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        transform: CSS.Translate.toString(transform),
      }}
    >
      <div
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        aria-roledescription="workflow step"
        aria-label={`${NODE_KIND_LABEL[node.kind]}: ${title}${status ? `, ${STEP_STATUS_LABEL[status]}` : ""}${problem ? ", has problems" : ""}`}
        aria-pressed={selected}
        onClick={() => onActivate(node.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onActivate(node.id);
          } else if ((event.key === "Delete" || event.key === "Backspace") && editable) {
            event.preventDefault();
            onRemove(node.id);
          } else {
            listeners?.onKeyDown?.(event);
          }
        }}
        className={cn(
          "flex size-full cursor-pointer flex-col gap-0.5 overflow-hidden rounded-lg border bg-card p-2.5 text-start shadow-xs outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          // Dragging owns touches only where nodes move; a run view still scrolls by touch.
          editable && "cursor-grab touch-none pe-14",
          isDragging && "cursor-grabbing shadow-md",
          status && STATUS_BORDER[status],
          problem && "border-destructive/70",
          selected && "ring-2 ring-primary/50 ring-inset",
          connecting && !connectSource && "cursor-crosshair hover:border-primary",
          connectSource && "border-primary",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-2xs font-medium text-muted-foreground">
          <Icon className="size-3.5 shrink-0" />
          <span className="truncate">{NODE_KIND_LABEL[node.kind]}</span>
          {problem ? <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" /> : null}
          {status ? (
            <Badge size="sm" variant={statusVariant(status)} className="ms-auto">
              {items
                ? `${items.filter((step) => step.status === "succeeded").length}/${items.length}`
                : STEP_STATUS_LABEL[status]}
            </Badge>
          ) : null}
        </span>
        <span className="truncate text-sm leading-snug font-medium">{title}</span>
        {detail ? <span className="truncate text-xs text-muted-foreground">{detail}</span> : null}
      </div>
      {editable ? (
        <div className="absolute end-1.5 top-1.5 flex gap-0.5 opacity-0 transition-opacity group-focus-within/node:opacity-100 group-hover/node:opacity-100 pointer-coarse:opacity-100">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={connectSource ? "Cancel connecting" : "Connect to the next step"}
            aria-pressed={connectSource}
            onClick={() => onConnect(node.id)}
          >
            <SplineIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost-destructive"
            aria-label="Delete step"
            onClick={() => onRemove(node.id)}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
