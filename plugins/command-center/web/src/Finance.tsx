import { Eye, EyeOff, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Cost, FinanceView, Income, IncomeStatus } from "../../server/finance.ts";
import type { MachineProjects } from "../../server/types.ts";
import { call } from "./api.ts";
import { Button } from "./ui/Button.tsx";
import { cn } from "./ui/cn.ts";
import { Badge, Card, Empty, Field, Input, Section, Select } from "./ui/fields.tsx";
import { Sheet } from "./ui/Sheet.tsx";

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

const NEXT: Record<IncomeStatus, IncomeStatus> = { pending: "paid", paid: "overdue", overdue: "pending" };
const STATUS_TONE: Record<IncomeStatus, string> = { pending: "", paid: "text-ok", overdue: "text-bad" };

/** "12.5" or "12,5" -> 1250; null for anything that is not a non-negative amount. */
function toCents(s: string) {
  const v = Number(s.trim().replace(",", "."));
  return s.trim() === "" || !Number.isFinite(v) || v < 0 ? null : Math.round(v * 100);
}

const money = (cents: number, currency: string, hide: boolean) =>
  hide
    ? "••••"
    : new Intl.NumberFormat([], { style: "currency", currency }).format(cents / 100);

const monthLabel = (key: string) =>
  new Date(Number(key.slice(0, 4)), Number(key.slice(5)) - 1, 1).toLocaleDateString([], { month: "short" });

type Editing = { kind: "income"; row: Income | null } | { kind: "cost"; row: Cost | null };

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <Card className="grid gap-0.5">
      <span className="text-xs text-muted-fg">{label}</span>
      <span className={cn("text-lg font-semibold tabular-nums", tone)}>{value}</span>
    </Card>
  );
}

function Bars({ view, hide }: { view: FinanceView; hide: boolean }) {
  const months = view.summary.months;
  const max = Math.max(1, ...months.flatMap((m) => [m.incomeCents, m.costCents]));
  return (
    <Card className="grid gap-2">
      <div className="flex h-24 items-end gap-2" role="img" aria-label="Income and costs, last six months">
        {months.map((m) => (
          <div key={m.key} className="flex h-full flex-1 items-end justify-center gap-0.5">
            <div className="w-full rounded-t bg-ok" style={{ height: `${hide ? 0 : (m.incomeCents / max) * 100}%` }} />
            <div className="w-full rounded-t bg-muted-fg/50" style={{ height: `${hide ? 0 : (m.costCents / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="flex gap-2 text-center text-xs text-muted-fg">
        {months.map((m) => (
          <span key={m.key} className="flex-1">
            {monthLabel(m.key)}
          </span>
        ))}
      </div>
      <p className="text-xs text-muted-fg">Income (green) and fixed costs (grey)</p>
    </Card>
  );
}

function EditSheet({ editing, projects, currency, onClose, onSaved }: { editing: Editing; projects: { key: string; title: string }[]; currency: string; onClose: () => void; onSaved: () => void }) {
  const isIncome = editing.kind === "income";
  const inc = isIncome ? editing.row : null;
  const cost = isIncome ? null : editing.row;
  const [concept, setConcept] = useState(inc?.concept ?? cost?.concept ?? "");
  const [client, setClient] = useState(inc?.clientName ?? "");
  const [date, setDate] = useState(inc?.date ?? new Date().toLocaleDateString("sv"));
  const [category, setCategory] = useState(cost?.category ?? "");
  const [amount, setAmount] = useState(inc ? String(inc.amountCents / 100) : cost ? String(cost.monthlyCents / 100) : "");
  const [cur, setCur] = useState(inc?.currency ?? cost?.currency ?? currency);
  const [status, setStatus] = useState<IncomeStatus>(inc?.status ?? "pending");
  const [picked, setPicked] = useState(new Set(cost?.projectIds ?? []));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
      setBusy(false);
    }
  };
  const save = () => {
    const cents = toCents(amount);
    if (cents === null) return setError("Enter a valid amount");
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
    if (!confirm("Delete this entry? This cannot be undone.")) return;
    const params = { id: (inc ?? cost)!.id };
    void act(() => (isIncome ? api("DELETE /api/finance/income/:id", { params }) : api("DELETE /api/finance/costs/:id", { params })));
  };

  return (
    <Sheet title={`${inc || cost ? "Edit" : "Add"} ${isIncome ? "income" : "cost"}`} onClose={onClose}>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Concept">
          <Input value={concept} onChange={(e) => setConcept(e.target.value)} maxLength={200} required />
        </Field>
        {isIncome ? (
          <>
            <Field label="Client">
              <Input value={client} onChange={(e) => setClient(e.target.value)} maxLength={120} />
            </Field>
            <Field label="Date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </Field>
          </>
        ) : (
          <Field label="Category">
            <Input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={80} />
          </Field>
        )}
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <Field label={isIncome ? "Amount" : "Per month"}>
              <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />
            </Field>
          </div>
          <div className="w-24">
            <Field label="Currency">
              <Input value={cur} onChange={(e) => setCur(e.target.value.toUpperCase())} maxLength={3} autoCapitalize="characters" />
            </Field>
          </div>
        </div>
        {isIncome ? (
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as IncomeStatus)}>
              <option value="pending">Pending</option>
              <option value="paid">Paid</option>
              <option value="overdue">Overdue</option>
            </Select>
          </Field>
        ) : (
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-xs font-medium text-muted-fg">Projects (cost is split evenly; none = general)</legend>
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
          <p role="alert" className="text-bad">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          {(inc || cost) && (
            <Button variant="danger" disabled={busy} onClick={del}>
              Delete
            </Button>
          )}
          <Button className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !concept.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

/** Income and recurring costs, with totals per month, client and project. Amounts can be hidden per device. */
export function Finance() {
  const [view, setView] = useState<FinanceView | null>(null);
  const [month, setMonth] = useState<string>("");
  const [hide, setHide] = useState(readHide);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [projects, setProjects] = useState<{ key: string; title: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setView(await call("GET /api/finance", { query: month ? { month } : undefined }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load finance");
    }
  }, [month]);

  useEffect(() => void reload(), [reload]);
  useEffect(() => {
    call("GET /api/projects").then(
      (list: MachineProjects[]) => setProjects(list.flatMap((m) => m.projects.map((p) => ({ key: `${m.machineId}:${p.id}`, title: `${m.machineLabel} · ${p.title}` })))),
      () => {},
    );
  }, []);

  const title = (key: string | null) => (key === null ? "No project" : (projects.find((p) => p.key === key)?.title ?? key));
  const toggleHide = () => {
    writeHide(!hide);
    setHide(!hide);
  };
  const act = (fn: () => Promise<unknown>) =>
    fn().then(reload, (e) => setError(e instanceof Error ? e.message : "Action failed"));

  const cur = view?.currency ?? "USD";
  const m = (c: number) => money(c, cur, hide);
  const s = view?.summary;

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <h1 className="flex-1 text-xl font-semibold">Finance</h1>
        <Button variant="ghost" size="icon" aria-label={hide ? "Show amounts" : "Hide amounts"} aria-pressed={hide} onClick={toggleHide}>
          {hide ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
      </div>

      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field label="Month">
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </Field>
        </div>
        <Button disabled={!month} onClick={() => setMonth("")}>
          All time
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-bad">
          {error}
        </p>
      )}

      {s && view && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Kpi label={month ? "Income this month" : "Income this month (now)"} value={m(s.incomeThisMonth)} tone="text-ok" />
            <Kpi label="Fixed costs / month" value={m(s.fixedCosts)} />
            <Kpi label="Result" value={m(s.resultCents)} tone={s.resultCents < 0 ? "text-bad" : undefined} />
            <Kpi label={s.overdueCount ? `Owed (${s.overdueCount} overdue)` : "Owed"} value={m(s.owedCents)} tone={s.overdueCount ? "text-warn" : undefined} />
          </div>
          {s.otherCurrencyRows > 0 && <p className="text-xs text-muted-fg">{s.otherCurrencyRows} entries in other currencies are not counted in the totals.</p>}
          <Bars view={view} hide={hide} />

          <Section title="By client">
            {view.byClient.length === 0 ? (
              <Empty>No income {month ? "this month" : "yet"}.</Empty>
            ) : (
              view.byClient.map((c) => (
                <Card key={c.clientName} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{c.clientName || "No client"}</span>
                  <span className="tabular-nums">{m(c.cents)}</span>
                </Card>
              ))
            )}
          </Section>

          <Section title="Costs by project">
            {view.byProject.length === 0 ? (
              <Empty>No active costs.</Empty>
            ) : (
              view.byProject.map((p) => (
                <Card key={p.projectId ?? "none"} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{title(p.projectId)}</span>
                  <span className="tabular-nums">{m(p.cents)}</span>
                </Card>
              ))
            )}
          </Section>

          <Section title="Income" count={view.income.length}>
            <Button onClick={() => setEditing({ kind: "income", row: null })}>
              <Plus className="size-4" /> Add income
            </Button>
            {view.income.map((r) => (
              <Card key={r.id} className="flex items-center gap-2">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing({ kind: "income", row: r })}>
                  <span className="block truncate font-medium">{r.concept}</span>
                  <span className="block truncate text-muted-fg">
                    {r.clientName || "No client"} · {r.date}
                  </span>
                </button>
                <div className="grid justify-items-end gap-1">
                  <span className="tabular-nums">{money(r.amountCents, r.currency, hide)}</span>
                  <button
                    type="button"
                    aria-label={`Status ${r.status}, tap to change`}
                    onClick={() => void act(() => api("PATCH /api/finance/income/:id", { params: { id: r.id }, body: { status: NEXT[r.status] } }))}
                  >
                    <Badge className={STATUS_TONE[r.status]}>{r.status}</Badge>
                  </button>
                </div>
              </Card>
            ))}
          </Section>

          <Section title="Recurring costs" count={view.costs.length}>
            <Button onClick={() => setEditing({ kind: "cost", row: null })}>
              <Plus className="size-4" /> Add cost
            </Button>
            {view.costs.map((r) => (
              <Card key={r.id} className={cn("flex items-center gap-2", r.archivedAt && "opacity-60")}>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing({ kind: "cost", row: r })}>
                  <span className="block truncate font-medium">{r.concept}</span>
                  <span className="block truncate text-muted-fg">
                    {r.category || "No category"} · {r.projectIds.length ? r.projectIds.map(title).join(", ") : "General"}
                  </span>
                </button>
                <div className="grid justify-items-end gap-1">
                  <span className="tabular-nums">{money(r.monthlyCents, r.currency, hide)}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void act(() => api("PATCH /api/finance/costs/:id", { params: { id: r.id }, body: { archived: !r.archivedAt } }))}
                  >
                    {r.archivedAt ? "Restore" : "Archive"}
                  </Button>
                </div>
              </Card>
            ))}
          </Section>
        </>
      )}
      {!view && !error && <p className="text-muted-fg">Loading...</p>}

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
