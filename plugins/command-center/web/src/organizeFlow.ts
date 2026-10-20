// Pure parts of "Ordenar con IA": polling the job and mapping the draft onto the Ask form.
import type { Coordinator, CoordinatorId, OrganizeDraft, OrganizeJob } from "../../server/organize.ts";

export const COORDINATOR_STORAGE_KEY = "cc.coordinator";
export const POLL_MS = 1500;
export const GIVE_UP_MS = 150_000;

/** The remembered coordinator if it is still available, else the first available one, else null. */
export function pickCoordinator(list: readonly Coordinator[], stored: string | null): CoordinatorId | null {
  return (list.find((c) => c.id === stored && c.available) ?? list.find((c) => c.available))?.id ?? null;
}

/** Step texts for the Plan editor. ponytail: the step titles are dropped, the server derives them from the prompt. */
export const draftSteps = (d: OrganizeDraft): string[] => (d.steps.length >= 2 ? d.steps.map((s) => s.prompt) : []);

interface PollOptions {
  signal: AbortSignal;
  intervalMs?: number;
  giveUpMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Follows a running job until it settles. Gives up after `giveUpMs`, after 3 failed reads in a row
 * (phone networks blip once, not three times), or when `signal` aborts (the abort is rethrown).
 */
export async function pollJob(first: OrganizeJob, get: (id: string) => Promise<OrganizeJob>, o: PollOptions): Promise<OrganizeJob> {
  const { signal, intervalMs = POLL_MS, giveUpMs = GIVE_UP_MS, sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)), now = Date.now } = o;
  const deadline = now() + giveUpMs;
  let job = first;
  let failures = 0;
  while (job.status === "running") {
    if (now() >= deadline) throw new Error("El coordinador tardó demasiado. Prueba de nuevo o encola tu texto original.");
    await sleep(intervalMs);
    signal.throwIfAborted();
    try {
      job = await get(job.id);
      failures = 0;
    } catch (e) {
      signal.throwIfAborted();
      if (++failures >= 3) throw e;
    }
  }
  return job;
}
