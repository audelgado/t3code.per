// Infra: host CPU and memory per machine, read from T3 only while the Infra screen asks for it.
// Wire-up: `routes.push(...createInfra({ machines: () => view().machines, link: (id) => links.get(id)?.link }).routes)`.
import type { Route } from "./http.ts";
import type { HostLink, HostResources } from "./t3link.ts";
import type { MachineView, T3Link } from "./types.ts";

/** At most one T3 read per machine per window, however many screens are open. */
export const FRESH_MS = 30_000;
/** A slow machine never holds the screen longer than this; its read lands in the cache for the next poll. */
const WAIT_MS = 5_000;

export interface InfraMachine extends MachineView {
  /** Null while the machine is not online or has not answered yet. */
  resources: HostResources | null;
  /** Why the last read failed; null when it succeeded. */
  resourcesError: string | null;
}

/** Type contract for the web (merge into Api when wiring). */
export interface InfraApi {
  "GET /api/infra": { body: never; res: InfraMachine[] };
}

export interface InfraDeps {
  machines(): MachineView[];
  /** hostResources is optional so a plain T3Link (e.g. a test fake) reads as unsupported. */
  link(machineId: string): (T3Link & Partial<HostLink>) | undefined;
  now?: () => number;
}

interface Entry {
  at: number;
  resources: HostResources | null;
  error: string | null;
  inflight: Promise<void> | null;
}

export function createInfra(deps: InfraDeps) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, Entry>();

  function refresh(machineId: string): Promise<void> | null {
    const link = deps.link(machineId);
    if (link?.state.status !== "online") return null;
    let entry = cache.get(machineId);
    if (entry?.inflight) return entry.inflight;
    if (entry && now() - entry.at < FRESH_MS) return null;
    entry ??= { at: 0, resources: null, error: null, inflight: null };
    cache.set(machineId, entry);
    const e = entry;
    e.at = now();
    e.inflight = (link.hostResources ? link.hostResources() : Promise.reject(new Error("Not supported by this link.")))
      .then(
        (resources) => void Object.assign(e, { resources, error: null }),
        (error: unknown) => void Object.assign(e, { error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => (e.inflight = null));
    return e.inflight;
  }

  async function read(): Promise<InfraMachine[]> {
    const machines = deps.machines();
    const reads = machines.flatMap((m) => refresh(m.id) ?? []);
    if (reads.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(reads), new Promise((ok) => (timer = setTimeout(ok, WAIT_MS)))]);
      clearTimeout(timer);
    }
    return machines.map((m) => {
      const entry = cache.get(m.id);
      const online = m.link.status === "online";
      return { ...m, resources: online ? (entry?.resources ?? null) : null, resourcesError: online ? (entry?.error ?? null) : null };
    });
  }

  const routes: Route[] = [{ method: "GET", path: "/api/infra", auth: "cookie", handler: read }];
  return { read, routes };
}
