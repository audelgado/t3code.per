// Pure helpers for Flota / Máquinas: which lane each task or thread sits in, per machine, and meter colours.
import type { HomeView, ThreadItem } from "../../server/types.ts";
import type { Tone } from "./look.ts";
import { hashes } from "./navigation.ts";

export type LaneId = "queued" | "running" | "needs" | "failed" | "done";

/** Lane order and colour. The design's "PR abierto" lane is left out: tasks do not carry PR data. */
export const LANES: readonly { id: LaneId; label: string; tone: Tone }[] = [
  { id: "queued", label: "En cola", tone: "queue" },
  { id: "running", label: "En curso", tone: "run" },
  { id: "needs", label: "Te necesita", tone: "need" },
  { id: "failed", label: "Falló", tone: "fail" },
  { id: "done", label: "Listo", tone: "ok" },
];

export interface LaneItem {
  key: string;
  lane: LaneId;
  title: string;
  /** "<machineId>:<projectId>": colours the item's dot. */
  projectKey: string;
  href: string;
}

const TASK_LANE: Partial<Record<string, LaneId>> = {
  pending_approval: "needs", needs_you: "needs", queued: "queued", starting: "running", running: "running", waiting: "running", failed: "failed",
};

/**
 * Where each CC task and each loose thread is right now, grouped by machine. Cancelled and done tasks are not lanes
 * (done work shows as its finished thread). Threads that belong to a task are covered by the task itself.
 */
export function lanesByMachine(view: HomeView): Map<string, Record<LaneId, LaneItem[]>> {
  const out = new Map<string, Record<LaneId, LaneItem[]>>();
  const add = (machineId: string, item: LaneItem) => {
    let lanes = out.get(machineId);
    if (!lanes) out.set(machineId, (lanes = { queued: [], running: [], needs: [], failed: [], done: [] }));
    lanes[item.lane].push(item);
  };
  for (const t of view.queue) {
    const lane = TASK_LANE[t.status];
    if (lane) add(t.machineId, { key: `task:${t.id}`, lane, title: t.title, projectKey: `${t.machineId}:${t.projectId}`, href: hashes.task(t.id) });
  }
  const thread = (lane: LaneId, t: ThreadItem) =>
    add(t.machineId, { key: `thread:${t.key}`, lane, title: t.title, projectKey: `${t.machineId}:${t.projectId}`, href: hashes.thread(t.key) });
  for (const n of view.needsYou) if (n.kind === "thread" && n.thread.taskId === null) thread("needs", n.thread);
  for (const t of view.running) if (t.taskId === null) thread("running", t);
  for (const t of view.done) thread("done", t);
  return out;
}

/** Green below 70 %, amber from 70, red from 90. */
export const loadTone = (percent: number): Tone => (percent >= 90 ? "fail" : percent >= 70 ? "need" : "ok");

/** True when the token ends within two weeks (or already ended). */
export const tokenExpiring = (iso: string | null, now = Date.now()) => iso !== null && Date.parse(iso) - now < 14 * 86_400_000;

export const gb = (bytes: number) => `${(bytes / 2 ** 30).toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
