import { useEffect, useState } from "react";
import type { HomeView, ThreadItem } from "../../server/types.ts";
import type { ThreadActionApi, ThreadDetail } from "../../server/threadActions.ts";
import { call, refresh } from "./api.ts";
import { Button, LinkButton } from "./ui/Button.tsx";
import { Sheet } from "./ui/Sheet.tsx";
import { ago, at } from "./ui/cn.ts";

// ponytail: typed through this cast until the routes are merged into Api (server/types.ts).
const api = call as unknown as <R extends keyof ThreadActionApi>(
  route: R,
  opts: { params: Record<string, string>; body?: ThreadActionApi[R]["body"] },
) => Promise<ThreadActionApi[R]["res"]>;

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** Thread detail with the actions that make sense for its state. Replaces the inline sheet in Home. */
export function ThreadSheet({ item, view, onClose }: { item: ThreadItem; view: HomeView; onClose: () => void }) {
  const machine = view.machines.find((m) => m.id === item.machineId)?.label ?? item.machineId;
  const params = { machine: item.machineId, thread: item.threadId };
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Fetched on open (not in the view): the result text is read from T3 once per tap.
  useEffect(() => {
    let live = true;
    api("GET /api/threads/:machine/:thread", { params }).then(
      (d) => live && setDetail(d),
      (e: unknown) => live && setLoadError(e instanceof Error ? e.message : "Could not load"),
    );
    return () => void (live = false);
  }, [item.machineId, item.threadId]);

  const pending = detail?.pending ?? item.pending;
  const text = detail?.text ?? item.preview;
  const running = ACTIVE.has(item.status);

  async function run(fn: () => Promise<unknown>, closeAfter = false) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      refresh();
      if (closeAfter) onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }
  const respond = (decision: "accept" | "acceptForSession" | "decline") =>
    run(() => api("POST /api/threads/:machine/:thread/respond", { params, body: { requestId: pending!.id, decision } }), true);

  return (
    <Sheet title={item.title} onClose={onClose}>
      <div className="grid gap-3">
        <p className="text-muted-fg">
          {machine} · {item.status} · {ago(item.updatedAt)}
        </p>
        {pending && (
          <p className="break-words">
            {pending.kind}
            {pending.summary ? `: ${pending.summary}` : ""}
          </p>
        )}
        {item.waitingUntil && <p className="text-warn">Waiting on a usage limit until {at(item.waitingUntil)}</p>}
        {text && <p className="whitespace-pre-wrap break-words">{text}</p>}
        {loadError && !detail && <p className="text-muted-fg">{loadError}</p>}
        {error && (
          <p role="alert" className="text-bad">
            {error}
          </p>
        )}

        {pending && detail?.answerable && (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="primary" disabled={busy} onClick={() => respond("accept")}>
              Approve
            </Button>
            <Button disabled={busy} onClick={() => respond("acceptForSession")}>
              Approve for session
            </Button>
            <Button variant="danger" className="col-span-2" disabled={busy} onClick={() => respond("decline")}>
              Decline
            </Button>
          </div>
        )}
        {pending && detail && !detail.answerable && <p className="text-muted-fg">This one has to be answered in T3.</p>}

        <div className="grid grid-cols-2 gap-2">
          {running ? (
            <Button variant="danger" disabled={busy} onClick={() => run(() => api("POST /api/threads/:machine/:thread/stop", { params }))}>
              Stop
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => run(() => api("POST /api/threads/:machine/:thread/settle", { params }), true)}>
              Settle
            </Button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <LinkButton variant="primary" href={item.appUrl}>
            Open in T3
          </LinkButton>
          {item.webUrl ? (
            <LinkButton href={item.webUrl} target="_blank" rel="noreferrer">
              Open on web
            </LinkButton>
          ) : (
            <span />
          )}
        </div>
      </div>
    </Sheet>
  );
}
