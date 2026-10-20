import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { InfraApi, InfraMachine } from "../../server/infra.ts";
import type { MachineView } from "../../server/types.ts";
import { call, useLive } from "./api.ts";
import { LANES, gb, lanesByMachine, loadTone, tokenExpiring, type LaneId, type LaneItem } from "./fleetView.ts";
import { TONES, ago, at } from "./look.ts";
import { StatusDot } from "./StatusDot.tsx";
import { Card, EmptyState } from "./ui/fields.tsx";
import { Chip, StatusChip } from "./ui/Chip.tsx";
import { cn } from "./ui/cn.ts";
import { Panel } from "./ui/Panel.tsx";
import { ProjectDot } from "./ui/ProjectDot.tsx";

// ponytail: typed through this cast until the route is merged into Api (server/types.ts).
const infraApi = call as unknown as <R extends keyof InfraApi>(route: R) => Promise<InfraApi[R]["res"]>;

/** Matches the server's per-machine cache window, so a poll never finds a fresh read pending. */
const POLL_MS = 30_000;

/** CPU and memory per machine. Reads only while Flota is mounted and the page is visible. */
function useResources() {
  const [machines, setMachines] = useState<Map<string, InfraMachine> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      clearTimeout(timer);
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      infraApi("GET /api/infra")
        .then(
          (list) => {
            if (!live) return;
            setMachines(new Map(list.map((m) => [m.id, m])));
            setError(null);
          },
          (e: unknown) => {
            if (live) setError(e instanceof Error ? e.message : "No se pudieron leer los recursos");
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
  return { machines, error };
}

function Meter({ label, percent, detail, base }: { label: string; percent: number | null; detail: string; base: string }) {
  const value = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  const tone = loadTone(value);
  return (
    <div className="flex items-center gap-2.5 text-xs">
      <span className="w-14 text-muted-fg">{label}</span>
      <div
        role={percent === null ? "progressbar" : "meter"}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(value)}
        aria-valuetext={percent === null ? "Medición desconocida. " + detail : detail}
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[#e7e5e0]"
      >
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: tone === "ok" ? base : TONES[tone].fg }} />
      </div>
      <span className="min-w-14 text-right tabular-nums">{detail}</span>
    </div>
  );
}

/** Phone: one coloured segment per lane, as wide as its count. Desktop shows the full lane grid instead. */
function LaneBar({ lanes }: { lanes: Record<LaneId, LaneItem[]> | undefined }) {
  return (
    <div className="grid gap-1.5 md:hidden">
      <div className="flex gap-1" role="img" aria-label={LANES.map((l) => `${l.label}: ${lanes?.[l.id].length ?? 0}`).join(", ")}>
        {LANES.map((l) => {
          const n = lanes?.[l.id].length ?? 0;
          return <span key={l.id} style={{ flex: Math.max(n, 0.3), background: n ? TONES[l.tone].fg : "#e7e5e0" }} className="h-1.5 rounded-[3px]" />;
        })}
      </div>
      <div className="flex flex-wrap gap-x-2.5 text-[11px] text-muted-fg">
        {LANES.map((l) => (
          <span key={l.id} className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full" style={{ background: TONES[l.tone].fg }} />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function MachineCard({ m, infra, lanes }: { m: MachineView; infra: InfraMachine | undefined; lanes: Record<LaneId, LaneItem[]> | undefined }) {
  const online = m.link.status === "online";
  const r = infra?.resources ?? null;
  const used = r ? r.totalMemoryBytes - r.availableMemoryBytes : 0;
  const version = m.link.serverVersion ?? m.serverVersion;
  const expiring = tokenExpiring(m.tokenExpiresAt);
  const warning = !online ? (m.link.message ?? "Sin conexión.") : null;
  return (
    <Card className={cn("grid content-start gap-2.5 px-4 py-3.5", !online && "bg-[#faf9f7]")}>
      <div className="flex items-center gap-2">
        <StatusDot status={m.link.status} className="size-2.5" />
        <b className="min-w-0 flex-1 truncate">{m.label}</b>
        <span className="text-xs text-muted-fg md:hidden">{online ? `${m.running}/${m.maxConcurrent} en curso` : `sin conexión · ${ago(m.link.since)}`}</span>
        <StatusChip status={m.link.status} className="hidden md:inline-flex" />
      </div>
      <p className="hidden text-xs text-muted-fg md:block">{version ? `T3 ${version}` : "Versión de T3 desconocida"}</p>
      {online && (
        <>
          <Meter
            label="CPU"
            base={TONES.run.fg}
            percent={r?.cpuUtilization == null ? null : r.cpuUtilization * 100}
            detail={!r ? "Leyendo…" : r.cpuUtilization == null ? "Midiendo…" : `${Math.round(r.cpuUtilization * 100)}%`}
          />
          <div className="hidden md:block">
            <Meter label="Memoria" base={TONES.teal.fg} percent={r && r.totalMemoryBytes > 0 ? (used / r.totalMemoryBytes) * 100 : null} detail={r ? gb(used) : "Leyendo…"} />
          </div>
          {r && (
            <p className="hidden text-xs text-muted-fg md:block">
              {r.cpuCount} núcleos · {gb(r.totalMemoryBytes)} de memoria
            </p>
          )}
          {infra?.resourcesError && (
            <p className="text-xs text-need">
              {r ? `Mostrando la lectura de ${ago(r.sampledAt)}: ` : "No se pudieron leer los recursos: "}
              {infra.resourcesError}
            </p>
          )}
        </>
      )}
      {warning && (
        <p className="flex items-start gap-2 rounded-lg bg-need-bg px-2.5 py-1.5 text-[12.5px] text-[#7c3d06]">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {warning}
            {m.queued > 0 && ` · ${m.queued} ${m.queued === 1 ? "tarea espera" : "tareas esperan"}`}
          </span>
        </p>
      )}
      {m.link.degraded && <p className="text-xs text-need">No se pudieron leer algunas filas de esta máquina.</p>}
      <LaneBar lanes={lanes} />
      <div className="hidden flex-wrap items-center gap-x-1.5 gap-y-1 text-xs md:flex">
        <b className="tabular-nums">
          {m.running}/{m.maxConcurrent}
        </b>
        <span className="text-muted-fg">en curso ·</span>
        <b className="tabular-nums">{m.queued}</b>
        <span className="text-muted-fg">en cola</span>
        {!m.enabled && <Chip tone="need" className="ml-auto h-5 text-[11px]">Despacho en pausa</Chip>}
      </div>
      {!m.enabled && <Chip tone="need" className="h-5 w-fit text-[11px] md:hidden">Despacho en pausa</Chip>}
      {m.tokenExpiresAt && (
        <p className={cn("text-xs", expiring ? "text-need" : "text-muted-fg")}>
          Token {Date.parse(m.tokenExpiresAt) < Date.now() ? "vencido" : "vence"} {at(m.tokenExpiresAt)}
        </p>
      )}
    </Card>
  );
}

/** Desktop: where each task is right now, one row per machine and one column per lane. */
function LaneGrid({ machines, lanes }: { machines: MachineView[]; lanes: ReturnType<typeof lanesByMachine> }) {
  const cell = "flex min-w-0 flex-col justify-center gap-1.5 border-b border-soft p-2";
  return (
    <Panel title="Flujo por máquina" action={<span className="text-xs font-normal text-muted-fg">dónde está cada tarea ahora</span>} className="hidden md:block">
      <div role="table" aria-label="Flujo por máquina" className="grid grid-cols-[130px_repeat(5,minmax(0,1fr))]">
        <div role="row" className="contents">
        <div role="columnheader" className="border-r border-b border-line bg-[#faf9f7] px-3 py-2 text-[11.5px] font-semibold tracking-wide text-muted-fg uppercase">Máquina</div>
        {LANES.map((l) => (
          <div role="columnheader" key={l.id} className="flex items-center gap-1.5 border-b border-line bg-[#faf9f7] px-3 py-2 text-[11.5px] font-semibold tracking-wide text-muted-fg uppercase">
            <span className="size-1.5 rounded-full" style={{ background: TONES[l.tone].fg }} />
            {l.label}
          </div>
        ))}
        </div>
        {machines.map((m) => {
          const online = m.link.status === "online";
          const ml = lanes.get(m.id);
          return (
            <div role="row" key={m.id} className="contents">
              <div role="rowheader" className={cn("flex flex-col justify-center gap-0.5 border-r border-b border-line px-3 py-2.5", !online && "opacity-50")}>
                <b className="flex items-center gap-1.5 text-sm">
                  <StatusDot status={m.link.status} />
                  <span className="truncate">{m.label}</span>
                </b>
                <span className="text-xs text-muted-fg">{online ? `${m.running} en curso` : "sin conexión"}</span>
              </div>
              {LANES.map((l) => {
                const items = ml?.[l.id] ?? [];
                return (
                  <div role="cell" key={l.id} className={cn(cell, !online && "opacity-50")}>
                    {items.slice(0, 2).map((i) => (
                      <a key={i.key} href={i.href} title={i.title} style={{ background: TONES[l.tone].bg }} className="flex items-center gap-1.5 overflow-hidden rounded-[7px] px-2 py-1 text-xs">
                        <ProjectDot projectKey={i.projectKey} className="size-2" />
                        <span className="truncate">{i.title}</span>
                      </a>
                    ))}
                    {items.length > 2 && <span className="px-2 text-[11px] text-muted-fg">+{items.length - 2} más</span>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/** Flota / Máquinas: estado y recursos de cada máquina, y por carriles qué está haciendo cada una. */
export function Fleet() {
  const { view } = useLive();
  const { machines: infra, error } = useResources();
  const machines = view?.machines ?? [];
  const lanes = view ? lanesByMachine(view) : new Map<string, Record<LaneId, LaneItem[]>>();
  return (
    <div className="grid gap-4">
      {view && machines.length === 0 && <EmptyState>Sin elementos: todavía no hay máquinas.</EmptyState>}
      {error && !infra && (
        <p role="alert" className="text-fail">
          No se pudieron cargar los recursos: {error}
        </p>
      )}
      {machines.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {machines.map((m) => (
            <MachineCard key={m.id} m={m} infra={infra?.get(m.id)} lanes={lanes.get(m.id)} />
          ))}
        </div>
      )}
      {machines.length > 0 && <LaneGrid machines={machines} lanes={lanes} />}
      <p className="text-xs text-muted-fg">
        Para sumar o quitar una máquina, ejecuta <code>machine add</code> en el servidor.
      </p>
    </div>
  );
}
