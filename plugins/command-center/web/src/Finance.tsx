import { clearCollectionDraft, useCollectionDraft, useCollectionState } from "./collectionHooks.ts";
import { financeAmount } from "./financeValidation.ts";
import { Eye, EyeOff, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Cost, FinanceView, Income, IncomeStatus } from "../../server/finance.ts";
import type { MachineProjects } from "../../server/types.ts";
import { call } from "./api.ts";
import { INCOME_STATUS, NEXT_STATUS, dayLabel, money, monthLabel } from "./financeView.ts";
import { projectColor } from "./look.ts";
import { paginateCollection } from "./pagination.ts";
import { Button } from "./ui/Button.tsx";
import { Chip } from "./ui/Chip.tsx";
import { cn } from "./ui/cn.ts";
import { Card, EmptyState, Field, Input, Select } from "./ui/fields.tsx";
import { Pager } from "./ui/Pager.tsx";
import { Panel } from "./ui/Panel.tsx";
import { ProjectDot } from "./ui/ProjectDot.tsx";
import { Sheet } from "./ui/Sheet.tsx";
import { Tabs } from "./ui/Tabs.tsx";
import { toast } from "./ui/Toast.tsx";

// The finance routes join the Api contract by augmentation in server/finance.ts, so call() is typed for them.
const api = call;

const HIDE_KEY = "cc.finance.hide";
const readHide = () => {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
};
const writeHide = (hide: boolean) => {
  try {
    localStorage.setItem(HIDE_KEY, hide ? "1" : "0");
  } catch {
    // Private mode or blocked storage: the toggle still works for this visit.
  }
};

/** Income and costs are history: eight rows a page. */
const PAGE_SIZE = 8;

type Editing = { kind: "income"; row: Income | null } | { kind: "cost"; row: Cost | null };
type Tab = "income" | "costs";

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Card className="grid gap-0.5 px-4 py-3">
      <span className="text-[13px] text-muted-fg">{label}</span>
      <span className={cn("text-xl font-bold tabular-nums md:text-[22px]", tone)}>{value}</span>
      {sub && <span className={cn("hidden text-xs md:block", tone ?? "text-muted-fg")}>{sub}</span>}
    </Card>
  );
}

function Bars({ view, hide }: { view: FinanceView; hide: boolean }) {
  const months = view.summary.months;
  const max = Math.max(1, ...months.flatMap((m) => [m.incomeCents, m.costCents]));
  const legend = (color: string, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2.5 rounded-[3px]" style={{ background: color }} />
      {label}
    </span>
  );
  return (
    <Panel title="Últimos 6 meses" action={<span className="flex gap-2.5 text-xs font-medium text-muted-fg">{legend("#15803d", "Ingresos")}{legend("#cfcbc2", "Costos")}</span>}>
      <div className="px-4 pt-4 pb-3">
        <div className="flex h-28 items-end gap-3" aria-hidden="true">
          {months.map((m, i) => (
            <div key={m.key} className="flex h-full flex-1 items-end justify-center gap-0.5">
              <div className={cn("w-full max-w-3.5 rounded-t bg-ok", i < months.length - 1 && "opacity-55")} style={{ height: `${hide ? 0 : (m.incomeCents / max) * 100}%` }} />
              <div className="w-full max-w-3.5 rounded-t bg-[#cfcbc2]" style={{ height: `${hide ? 0 : Math.max(m.costCents ? 4 : 0, (m.costCents / max) * 100)}%` }} />
            </div>
          ))}
        </div>
        <div className="mt-1.5 flex gap-3 text-center text-xs text-muted-fg">
          {months.map((m) => (
            <span key={m.key} className="flex-1">
              {monthLabel(m.key)}
            </span>
          ))}
        </div>
        <table className="mt-3 w-full text-left text-xs">
          <caption className="sr-only">Ingresos y costos fijos por mes</caption>
          <thead><tr><th scope="col">Mes</th><th scope="col">Ingresos</th><th scope="col">Costos</th></tr></thead>
          <tbody>{months.map((m) => <tr key={m.key}><th scope="row">{m.key}</th><td>{money(m.incomeCents, view.currency, hide)}</td><td>{money(m.costCents, view.currency, hide)}</td></tr>)}</tbody>
        </table>
      </div>
    </Panel>
  );
}

function EditSheet({ editing, projects, currency, onClose, onSaved }: { editing: Editing; projects: { key: string; title: string }[]; currency: string; onClose: () => void; onSaved: () => void }) {
  const isIncome = editing.kind === "income";
  const inc = isIncome ? editing.row : null;
  const cost = isIncome ? null : editing.row;
  const draftKey = `finance.${editing.kind}.${editing.row?.id ?? "new"}`;
  const initial = {
    concept: inc?.concept ?? cost?.concept ?? "", client: inc?.clientName ?? "",
    date: inc?.date ?? new Date().toLocaleDateString("sv"), category: cost?.category ?? "",
    amount: inc ? String(inc.amountCents / 100) : cost ? String(cost.monthlyCents / 100) : "",
    cur: inc?.currency ?? cost?.currency ?? currency, status: (inc?.status ?? "pending") as IncomeStatus,
    projectIds: cost?.projectIds ?? [],
  };
  const [draft, setDraft] = useCollectionDraft(draftKey, initial);
  const { concept, client, date, category, amount, cur, status } = draft;
  const picked = new Set(draft.projectIds);
  const setConcept = (value: string) => setDraft((d) => ({ ...d, concept: value }));
  const setClient = (value: string) => setDraft((d) => ({ ...d, client: value }));
  const setDate = (value: string) => setDraft((d) => ({ ...d, date: value }));
  const setCategory = (value: string) => setDraft((d) => ({ ...d, category: value }));
  const setAmount = (value: string) => setDraft((d) => ({ ...d, amount: value }));
  const setCur = (value: string) => setDraft((d) => ({ ...d, cur: value }));
  const setStatus = (value: IncomeStatus) => setDraft((d) => ({ ...d, status: value }));
  const setPicked = (update: (value: Set<string>) => Set<string>) => setDraft((d) => ({ ...d, projectIds: [...update(new Set(d.projectIds))] }));
  const amountField = useRef<HTMLInputElement>(null);
  const [invalidAmount, setInvalidAmount] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      clearCollectionDraft(draftKey);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo completar la acción");
      setBusy(false);
    }
  };
  const save = () => {
    if (busy) return;
    const cents = financeAmount(amount);
    setInvalidAmount(cents === null);
    if (cents === null) {
      setError("Ingresa un importe válido, con hasta dos decimales y un máximo de 10.000.000.000.");
      amountField.current?.focus();
      return;
    }
    const params = { id: (inc ?? cost)?.id ?? "" };
    void act(() =>
      isIncome
        ? inc
          ? api("PATCH /api/finance/income/:id", { params, body: { concept, clientName: client, date, amountCents: cents, currency: cur, status } })
          : api("POST /api/finance/income", { body: { concept, clientName: client, date, amountCents: cents, currency: cur, status } })
        : cost
          ? api("PATCH /api/finance/costs/:id", { params, body: { concept, category, monthlyCents: cents, currency: cur, projectIds: [...picked] } })
          : api("POST /api/finance/costs", { body: { concept, category, monthlyCents: cents, currency: cur, projectIds: [...picked] } }),
    );
  };
  const del = () => {
    if (!confirm("¿Eliminar esta entrada? No se puede deshacer.")) return;
    const params = { id: (inc ?? cost)!.id };
    void act(() => (isIncome ? api("DELETE /api/finance/income/:id", { params }) : api("DELETE /api/finance/costs/:id", { params })));
  };

  const close = () => {
    if (busy) return;
    if (JSON.stringify(draft) !== JSON.stringify(initial) && !confirm("¿Descartar los cambios sin guardar?")) return;
    clearCollectionDraft(draftKey);
    onClose();
  };

  return (
    <Sheet
      title={`${inc || cost ? "Editar" : "Agregar"} ${isIncome ? "ingreso" : "costo"}`}
      onClose={close}
      footer={
        <div className="flex gap-2">
          {(inc || cost) && (
            <Button variant="danger" disabled={busy} onClick={del}>
              Eliminar
            </Button>
          )}
          <Button className="ml-auto" disabled={busy} onClick={close}>
            Cancelar
          </Button>
          <Button type="submit" form="finance-form" variant="primary" disabled={busy || !concept.trim()}>
            {busy ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      }
    >
      <form
        aria-busy={busy}
        id="finance-form"
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <fieldset disabled={busy} className="contents">
        <Field label="Concepto">
          <Input value={concept} onChange={(e) => setConcept(e.target.value)} maxLength={200} required />
        </Field>
        {isIncome ? (
          <>
            <Field label="Cliente">
              <Input value={client} onChange={(e) => setClient(e.target.value)} maxLength={120} />
            </Field>
            <Field label="Fecha">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </Field>
          </>
        ) : (
          <Field label="Categoría">
            <Input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={80} />
          </Field>
        )}
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <Field label={isIncome ? "Importe" : "Por mes"}>
              <Input ref={amountField} aria-invalid={invalidAmount || undefined} aria-describedby={invalidAmount ? "finance-error" : undefined} inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setInvalidAmount(false); }} placeholder="0,00…" required />
            </Field>
          </div>
          <div className="w-24">
            <Field label="Moneda">
              <Input value={cur} onChange={(e) => setCur(e.target.value.toUpperCase())} maxLength={3} autoCapitalize="characters" />
            </Field>
          </div>
        </div>
        {isIncome ? (
          <Field label="Estado">
            <Select value={status} onChange={(e) => setStatus(e.target.value as IncomeStatus)}>
              {(Object.keys(INCOME_STATUS) as IncomeStatus[]).map((s) => (
                <option key={s} value={s}>
                  {INCOME_STATUS[s].label}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-xs font-medium text-muted-fg">Proyectos (el costo se reparte en partes iguales; ninguno = general)</legend>
            {projects.map((p) => (
              <label key={p.key} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={picked.has(p.key)}
                  onChange={(e) => setPicked((s) => (e.target.checked ? new Set(s).add(p.key) : new Set([...s].filter((k) => k !== p.key))))}
                />
                <span className="min-w-0 truncate">{p.title}</span>
              </label>
            ))}
          </fieldset>
        )}
        {error && (
          <p id="finance-error" role="alert" className="text-fail">
            {error}
          </p>
        )}
        </fieldset>
      </form>
    </Sheet>
  );
}

/** Dinero: ingresos y costos recurrentes, con totales por mes, cliente y proyecto. Los importes se pueden ocultar por dispositivo. */
export function Finance() {
  const [view, setView] = useState<FinanceView | null>(null);
  const [month, setMonth] = useCollectionState("finance.month", "", (v) => v === "" || /^\d{4}-(0[1-9]|1[0-2])$/.test(v));
  const [hide, setHide] = useState(readHide);
  const [editing, setEditing] = useCollectionDraft<Editing | null>("finance.editing", null);
  const [projects, setProjects] = useState<{ key: string; title: string }[]>([]);
  const [tab, setTab] = useCollectionState<Tab>("finance.tab", "income", (v) => v === "income" || v === "costs");
  const [page, setPage] = useCollectionState("finance.page", 1);
  const [error, setError] = useState<string | null>(null);

  const reloadSeq = useRef(0);
  const reload = useCallback(async () => {
    const n = ++reloadSeq.current;
    try {
      const next = await call("GET /api/finance", { query: month ? { month } : undefined });
      if (n !== reloadSeq.current) return;
      setView(next);
      setError(null);
    } catch (e) {
      if (n === reloadSeq.current) setError(e instanceof Error ? e.message : "No se pudo cargar Dinero");
    }
  }, [month]);

  useEffect(() => { void reload(); return () => { reloadSeq.current++; }; }, [reload]);
  useEffect(() => {
    call("GET /api/projects").then(
      (list: MachineProjects[]) => setProjects(list.flatMap((m) => m.projects.map((p) => ({ key: `${m.machineId}:${p.id}`, title: `${m.machineLabel} · ${p.title}` })))),
      () => {},
    );
  }, []);

  const title = (key: string | null) => (key === null ? "Sin proyecto" : (projects.find((p) => p.key === key)?.title ?? key));
  const toggleHide = () => {
    writeHide(!hide);
    setHide(!hide);
  };
  const act = (fn: () => Promise<unknown>) => fn().then(reload, (e) => setError(e instanceof Error ? e.message : "No se pudo completar la acción"));
  const setIncomeStatus = (r: Income, next: IncomeStatus) =>
    act(async () => {
      await api("PATCH /api/finance/income/:id", { params: { id: r.id }, body: { status: next } });
      toast(`${r.concept}: ${INCOME_STATUS[next].label.toLowerCase()}`, { label: "Deshacer", onClick: () => void act(() => api("PATCH /api/finance/income/:id", { params: { id: r.id }, body: { status: r.status } })) });
    });

  const cur = view?.currency ?? "USD";
  const m = (c: number) => money(c, cur, hide);
  const s = view?.summary;
  const incomePage = paginateCollection(view?.income ?? [], page, PAGE_SIZE);
  const costPage = paginateCollection(view?.costs ?? [], page, PAGE_SIZE);
  const paged = tab === "income" ? incomePage : costPage;
  const activeCosts = view?.costs.filter((c) => !c.archivedAt).length ?? 0;
  const maxClient = Math.max(1, ...(view?.byClient.map((c) => c.cents) ?? []));
  const maxProject = Math.max(1, ...(view?.byProject.map((p) => p.cents) ?? []));

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 md:max-w-48 md:flex-none">
          <Field label="Mes">
            <Input
              type="month"
              value={month}
              onChange={(e) => {
                setMonth(e.target.value);
                setPage(1, true);
              }}
            />
          </Field>
        </div>
        {month && <Button onClick={() => setMonth("")}>Todo el período</Button>}
        <Button className="ml-auto" aria-pressed={hide} aria-label={hide ? "Mostrar importes" : "Ocultar importes"} onClick={toggleHide}>
          {hide ? <Eye className="size-4" aria-hidden /> : <EyeOff className="size-4" aria-hidden />}
          {hide ? "Mostrar" : "Ocultar"}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-fail">
          {error}
        </p>
      )}

      {s && view && (
        <>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <Kpi label={month ? "Ingresos del mes" : "Ingresos del mes (hoy)"} value={m(s.incomeThisMonth)} tone="text-ok" />
            <Kpi label="Costos fijos / mes" value={m(s.fixedCosts)} sub={`${activeCosts} ${activeCosts === 1 ? "costo activo" : "costos activos"}`} />
            <Kpi label="Resultado" value={m(s.resultCents)} sub="Ingresos − costos fijos" tone={s.resultCents < 0 ? "text-fail" : "text-ok"} />
            <Kpi label="Por cobrar" value={m(s.owedCents)} sub={s.overdueCount ? `${s.overdueCount} ${s.overdueCount === 1 ? "vencido" : "vencidos"}` : undefined} tone={s.overdueCount ? "text-need" : undefined} />
          </div>
          {s.otherCurrencyRows > 0 && <p className="text-xs text-muted-fg">{s.otherCurrencyRows} {s.otherCurrencyRows === 1 ? "entrada en otra moneda no se suma" : "entradas en otras monedas no se suman"} en los totales.</p>}

          <div className="grid items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
            <section className="overflow-hidden rounded-card border border-line bg-panel">
              <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
                <Tabs
                  label="Dinero"
                  value={tab}
                  onChange={(t) => {
                    setTab(t);
                    setPage(1, true);
                  }}
                  items={[
                    { id: "income", label: "Ingresos", count: view.income.length },
                    { id: "costs", label: "Costos recurrentes", count: view.costs.length },
                  ]}
                />
                <Button className="ml-auto" onClick={() => setEditing({ kind: tab === "income" ? "income" : "cost", row: null })}>
                  <Plus className="size-4" aria-hidden />
                  <span className="hidden sm:inline">{tab === "income" ? "Agregar ingreso" : "Agregar costo"}</span>
                  <span className="sm:hidden">Agregar</span>
                </Button>
              </header>
              <div className="divide-y divide-soft">
                {paged.total === 0 && (
                  <div className="p-4">
                    <EmptyState>{tab === "income" ? (month ? "Sin elementos: no hay ingresos este mes." : "Sin elementos: todavía no hay ingresos.") : "Sin elementos: no hay costos activos."}</EmptyState>
                  </div>
                )}
                {tab === "income"
                  ? incomePage.items.map((r) => {
                      const st = INCOME_STATUS[r.status];
                      return (
                        <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                          <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ background: projectColor(r.clientName) }} />
                          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing({ kind: "income", row: r })}>
                            <span className="block truncate font-semibold">{r.concept}</span>
                            <span className="block truncate text-xs text-muted-fg">
                              {r.clientName || "Sin cliente"} · {dayLabel(r.date)}
                            </span>
                          </button>
                          <div className="grid justify-items-end gap-1">
                            <b className="tabular-nums">{money(r.amountCents, r.currency, hide)}</b>
                            <button type="button" aria-label={`Estado: ${st.label}. Pulsa para cambiarlo`} onClick={() => void setIncomeStatus(r, NEXT_STATUS[r.status])}>
                              <Chip tone={st.tone} className="h-[18px] text-[10.5px] md:h-[22px] md:text-xs">{st.label}</Chip>
                            </button>
                          </div>
                          {r.status !== "paid" && (
                            <Button size="sm" className="hidden md:inline-flex" onClick={() => void setIncomeStatus(r, "paid")}>
                              Marcar cobrado
                            </Button>
                          )}
                        </div>
                      );
                    })
                  : costPage.items.map((r) => (
                      <div key={r.id} className={cn("flex items-center gap-3 px-4 py-3", r.archivedAt && "opacity-60")}>
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing({ kind: "cost", row: r })}>
                          <span className="block truncate font-semibold">{r.concept}</span>
                          <span className="block truncate text-xs text-muted-fg">
                            {r.category || "Sin categoría"} · {r.projectIds.length ? r.projectIds.map(title).join(", ") : "General"}
                          </span>
                        </button>
                        <b className="tabular-nums">
                          {money(r.monthlyCents, r.currency, hide)}
                          <span className="text-xs font-normal text-muted-fg">/mes</span>
                        </b>
                        <Button variant="ghost" size="sm" onClick={() => void act(() => api("PATCH /api/finance/costs/:id", { params: { id: r.id }, body: { archived: !r.archivedAt } }))}>
                          {r.archivedAt ? "Restaurar" : "Archivar"}
                        </Button>
                      </div>
                    ))}
              </div>
              <div className="grid gap-2 border-t border-line px-4 py-2.5">
                <p className="text-xs text-muted-fg">{tab === "income" ? "Pulsa un estado para cambiarlo." : "Los costos archivados no se suman."}</p>
                <Pager page={paged} onPageChange={setPage} label={tab === "income" ? "ingresos" : "costos"} />
              </div>
            </section>

            <div className="grid gap-4">
              <Bars view={view} hide={hide} />
              <Panel title="Por cliente" count={view.byClient.length}>
                {view.byClient.length === 0 ? (
                  <div className="p-4">
                    <EmptyState>{month ? "Sin elementos: no hay ingresos este mes." : "Sin elementos: todavía no hay ingresos."}</EmptyState>
                  </div>
                ) : (
                  view.byClient.map((c) => (
                    <div key={c.clientName} className="flex items-center gap-2.5 px-4 py-2.5">
                      <ProjectDot projectKey={c.clientName} />
                      <span className="w-32 truncate text-sm">{c.clientName || "Sin cliente"}</span>
                      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[#e7e5e0]">
                        <div className="h-full rounded-full" style={{ width: hide ? 0 : `${(c.cents / maxClient) * 100}%`, background: projectColor(c.clientName) }} />
                      </div>
                      <b className="min-w-16 text-right text-sm tabular-nums">{m(c.cents)}</b>
                    </div>
                  ))
                )}
              </Panel>
              <Panel title="Costos por proyecto" count={view.byProject.length}>
                {view.byProject.length === 0 ? (
                  <div className="p-4">
                    <EmptyState>Sin elementos: no hay costos activos.</EmptyState>
                  </div>
                ) : (
                  view.byProject.map((p) => (
                    <div key={p.projectId ?? "none"} className="flex items-center gap-2.5 px-4 py-2.5">
                      {p.projectId ? <ProjectDot projectKey={p.projectId} /> : <span aria-hidden className="size-2.5 shrink-0 rounded-[3px] bg-[#cfcbc2]" />}
                      <span className="min-w-0 flex-1 truncate text-sm">{title(p.projectId)}</span>
                      <div className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-[#e7e5e0] sm:block">
                        <div className="h-full rounded-full bg-[#a8a396]" style={{ width: hide ? 0 : `${(p.cents / maxProject) * 100}%` }} />
                      </div>
                      <b className="min-w-16 text-right text-sm tabular-nums">{m(p.cents)}</b>
                    </div>
                  ))
                )}
              </Panel>
            </div>
          </div>
        </>
      )}
      {!view && !error && <p className="text-muted-fg">Cargando…</p>}

      {editing && (
        <EditSheet
          editing={editing}
          projects={projects}
          currency={cur}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}
