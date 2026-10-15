import { useEffect, useState } from "react";
import type { InfraApi, InfraMachine } from "../../server/infra.ts";
import { call } from "./api.ts";
import { StatusDot } from "./StatusDot.tsx";
import { ago, cn } from "./ui/cn.ts";
import { Badge, Card, Empty } from "./ui/fields.tsx";

// ponytail: typed through this cast until the route is merged into Api (server/types.ts).
const api = call as unknown as <R extends keyof InfraApi>(route: R) => Promise<InfraApi[R]["res"]>;

/** Matches the server's per-machine cache window, so a poll never finds a fresh read pending. */
const POLL_MS = 30_000;

const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;

/** Machines with host CPU and memory. Reads only while this screen is mounted and the page is visible. */
export function Infra() {
  const [machines, setMachines] = useState<InfraMachine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      clearTimeout(timer);
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      api("GET /api/infra")
        .then(
          (m) => {
            if (!live) return;
            setMachines(m);
            setError(null);
          },
          (e: unknown) => {
            if (live) setError(e instanceof Error ? e.message : "Could not load");
          },
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

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Infra</h1>
      {error && <p className="text-bad">{error}</p>}
      {machines === null && !error && <p className="text-muted-fg">Loading...</p>}
      {machines?.length === 0 && <Empty>No machines yet.</Empty>}
      {machines?.map((m) => <MachineCard key={m.id} m={m} />)}
    </div>
  );
}

function MachineCard({ m }: { m: InfraMachine }) {
  const r = m.resources;
  const used = r ? r.totalMemoryBytes - r.availableMemoryBytes : 0;
  return (
    <Card className="grid gap-3">
      <div className="flex items-center gap-2">
        <StatusDot status={m.link.status} />
        <span className="min-w-0 flex-1 truncate font-medium">{m.label}</span>
        <Badge>{m.link.status}</Badge>
      </div>
      {m.link.message && <p className="text-muted-fg">{m.link.message}</p>}
      {m.link.status === "online" && (
        <div className="grid gap-2">
          <Meter
            label="CPU"
            percent={r?.cpuUtilization == null ? null : r.cpuUtilization * 100}
            detail={!r ? "Reading..." : r.cpuUtilization == null ? "Sampling..." : `${Math.round(r.cpuUtilization * 100)}% of ${r.cpuCount} cores`}
          />
          <Meter
            label="Memory"
            percent={r && r.totalMemoryBytes > 0 ? (used / r.totalMemoryBytes) * 100 : null}
            detail={r ? `${gb(used)} of ${gb(r.totalMemoryBytes)}` : "Reading..."}
          />
          {m.resourcesError && (
            <p className="text-warn">
              {r ? `Showing the reading from ${ago(r.sampledAt)}: ` : "Could not read resources: "}
              {m.resourcesError}
            </p>
          )}
        </div>
      )}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-fg">
        <dt>Running</dt>
        <dd className="text-right text-fg tabular-nums">
          {m.running} / {m.maxConcurrent}
        </dd>
        <dt>Queued</dt>
        <dd className="text-right text-fg tabular-nums">{m.queued}</dd>
        <dt>T3 version</dt>
        <dd className="text-right text-fg">{m.link.serverVersion ?? m.serverVersion ?? "unknown"}</dd>
        {!m.enabled && (
          <>
            <dt>Dispatch</dt>
            <dd className="text-right text-fg">paused</dd>
          </>
        )}
      </dl>
    </Card>
  );
}

function Meter({ label, percent, detail }: { label: string; percent: number | null; detail: string }) {
  const value = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-fg tabular-nums">{detail}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value)}
        className="h-1.5 overflow-hidden rounded-full bg-accent"
      >
        <div
          className={cn("h-full rounded-full", value >= 90 ? "bg-bad" : value >= 70 ? "bg-warn" : "bg-ok")}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}
