// Data and actions shared by Hoy, Trabajo and the Tablero: branch status, project titles, task actions.
import { useCallback, useEffect, useState } from "react";
import type { RuntimeMode } from "../../server/types.ts";
import type { WorkApi, WorkMachine } from "../../server/work.ts";
import { call, refresh } from "./api.ts";

// ponytail: typed through this cast until the work routes are merged into Api (server/types.ts).
const work = call as unknown as <R extends keyof WorkApi>(route: R, opts?: { body?: WorkApi[R]["body"] }) => Promise<WorkApi[R]["res"]>;

/** Matches the server's cache window, so a poll never finds a fresh read pending. */
const POLL_MS = 30_000;

/** Branches and PRs per project and machine. Reads T3 only while a screen using it is mounted and the page is visible. */
export function useWork() {
  const [machines, setMachines] = useState<WorkMachine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      clearTimeout(timer);
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      work("GET /api/work")
        .then(
          (m) => {
            if (!live) return;
            setMachines(m);
            setError(null);
          },
          (e: unknown) => live && setError(e instanceof Error ? e.message : "Error desconocido"),
        )
        .finally(() => {
          busy = false;
          if (live) timer = setTimeout(load, POLL_MS);
        });
    };
    load();
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  return { machines, error };
}

/** Queues the agent task that tidies merged and stale branches of one project. */
export const askTidy = (machineId: string, projectId: string) => work("POST /api/work/tidy", { body: { machineId, projectId } });

// "<machineId>:<projectId>" -> title. One GET per page load, shared by every screen that names projects.
const titles = new Map<string, string>();
let loading: Promise<void> | null = null;
const loadTitles = () =>
  (loading ??= call("GET /api/projects").then(
    (groups) => groups.forEach((g) => g.projects.forEach((p) => titles.set(`${g.machineId}:${p.id}`, p.title))),
    () => void (loading = null),
  ));

/** Project titles by key; the map fills in after the first answer. */
export function useProjectTitles() {
  const [, rerender] = useState(0);
  useEffect(() => {
    let live = true;
    void loadTitles().then(() => live && rerender((n) => n + 1));
    return () => void (live = false);
  }, []);
  return titles;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Error desconocido");

/** Busy and error state of one action; the error stays next to the thing that failed. */
export function useAct() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useCallback(async (failure: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
      return true;
    } catch (e) {
      setError(`${failure}. ${errorMessage(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, act, clear: () => setError(null) };
}

export const taskCall = {
  approve: (id: string, runtimeMode: RuntimeMode) => call("POST /api/tasks/:id/approve", { params: { id }, body: { runtimeMode } }),
  reject: (id: string) => call("POST /api/tasks/:id/reject", { params: { id } }),
  retry: (id: string) => call("POST /api/tasks/:id/retry", { params: { id } }),
  cancel: (id: string) => call("POST /api/tasks/:id/cancel", { params: { id } }),
  priority: (id: string, priority: number) => call("PATCH /api/tasks/:id", { params: { id }, body: { priority } }),
};
