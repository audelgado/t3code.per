import { useLive } from "./api.ts";
import { StatusDot } from "./StatusDot.tsx";
import { at } from "./ui/cn.ts";
import { Badge, Card, Empty } from "./ui/fields.tsx";

/** Read-only: machines are added and removed from the server CLI. */
export function Machines() {
  const { view } = useLive();
  const machines = view?.machines ?? [];
  const expiring = (iso: string | null) => iso !== null && Date.parse(iso) - Date.now() < 14 * 86400_000;
  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Machines</h1>
      {machines.length === 0 && <Empty>No machines yet.</Empty>}
      {machines.map((m) => (
        <Card key={m.id} className="grid gap-2">
          <div className="flex items-center gap-2">
            <StatusDot status={m.link.status} />
            <span className="min-w-0 flex-1 truncate font-medium">{m.label}</span>
            <Badge>{m.link.status}</Badge>
          </div>
          {m.link.message && <p className="text-muted-fg">{m.link.message}</p>}
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-fg">
            <dt>Running</dt>
            <dd className="text-right text-fg tabular-nums">
              {m.running} / {m.maxConcurrent}
            </dd>
            <dt>Queued</dt>
            <dd className="text-right text-fg tabular-nums">{m.queued}</dd>
            <dt>T3 version</dt>
            <dd className="text-right text-fg">{m.link.serverVersion ?? m.serverVersion ?? "unknown"}</dd>
            <dt>Token expires</dt>
            <dd className={expiring(m.tokenExpiresAt) ? "text-right text-warn" : "text-right text-fg"}>
              {m.tokenExpiresAt ? at(m.tokenExpiresAt) : "unknown"}
            </dd>
            {!m.enabled && (
              <>
                <dt>Dispatch</dt>
                <dd className="text-right text-fg">paused</dd>
              </>
            )}
          </dl>
          {m.link.degraded && <p className="text-warn">Some rows from this machine could not be read.</p>}
        </Card>
      ))}
      <p className="text-muted-fg">
        To add or remove a machine, run <code>machine add</code> on the server.
      </p>
    </div>
  );
}
