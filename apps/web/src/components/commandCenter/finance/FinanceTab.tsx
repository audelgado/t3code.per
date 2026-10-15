import type { CommandCenterCost, CommandCenterIncome, ProjectId } from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ArchiveRestoreIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { useRelativeTimeTick } from "../../settings/settingsLayout";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { formatMoney, Money, useCommandCenter, useCommandCenterCommands } from "../shared";
import { CollectionPager } from "../CollectionPager";
import { paginateCollection } from "../collectionPaging";
import {
  costByProject,
  displayCurrency,
  financeSummary,
  filterIncome,
  filterCosts,
  NEXT_INCOME_STATUS,
  parseCents,
} from "./logic";

const STATUS_VARIANT = { pending: "warning", paid: "success", overdue: "error" } as const;
const STATUS_LABEL = { pending: "Pending", paid: "Paid", overdue: "Overdue" } as const;

const monthLabel = new Intl.DateTimeFormat(undefined, { month: "short" });

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
      <h2 className="font-medium text-sm">{title}</h2>
      {children}
    </section>
  );
}

function Kpi({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border bg-card p-4">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-semibold text-xl tracking-tight tabular-nums">{children}</span>
    </div>
  );
}

/** Finance tab: billing per client, recurring costs split across the projects they support. */
export function FinanceTab() {
  const { snapshot, projects, projectId, hidden } = useCommandCenter();
  const nowMs = useRelativeTimeTick(60_000);
  const [rankingPage, setRankingPage] = useState(1);
  const costs = useMemo(
    () => snapshot.costs.filter((cost) => cost.archivedAt === null),
    [snapshot.costs],
  );
  const archivedCosts = useMemo(
    () => snapshot.costs.filter((cost) => cost.archivedAt !== null),
    [snapshot.costs],
  );
  const income = useMemo(
    () => snapshot.income.toSorted((left, right) => right.date.localeCompare(left.date)),
    [snapshot.income],
  );
  const currency = displayCurrency(snapshot.income, costs);
  const summary = useMemo(
    () => financeSummary(snapshot.income, snapshot.costs, currency, new Date(nowMs)),
    [currency, nowMs, snapshot.costs, snapshot.income],
  );
  // The project focus narrows the ranking and the cost lists; totals stay whole.
  const perProject = useMemo(
    () =>
      [...costByProject(snapshot.costs, currency)]
        .filter(([id]) => projectId === null || id === projectId)
        .toSorted((left, right) => right[1] - left[1]),
    [currency, projectId, snapshot.costs],
  );
  const projectTitle = (id: ProjectId | null) =>
    id === null
      ? "No project"
      : (projects.find((project) => project.id === id)?.title ?? "Unknown project");
  const chartMax = Math.max(1, ...summary.months.flatMap((m) => [m.incomeCents, m.costCents]));
  const projectMax = Math.max(1, ...perProject.map(([, cents]) => cents));
  const rankedProjects = paginateCollection(perProject, rankingPage, 6);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Income this month">
          <Money cents={summary.incomeThisMonth} currency={currency} />
        </Kpi>
        <Kpi label="Fixed costs per month">
          <Money cents={summary.fixedCosts} currency={currency} />
        </Kpi>
        <Kpi label="Result">
          <span
            className={
              summary.resultCents < 0 ? "text-destructive-foreground" : "text-success-foreground"
            }
          >
            {summary.resultCents < 0 ? "-" : ""}
            <Money cents={Math.abs(summary.resultCents)} currency={currency} />
          </span>
        </Kpi>
        <Kpi label="Owed">
          <Money cents={summary.owedCents} currency={currency} />
          {summary.overdueCount > 0 ? (
            <span className="ms-2 font-normal text-destructive-foreground text-xs">
              {summary.overdueCount} overdue
            </span>
          ) : null}
        </Kpi>
      </div>
      {summary.otherCurrencyRows > 0 ? (
        <p className="text-muted-foreground text-xs">
          Totals are in {currency}. {summary.otherCurrencyRows} row(s) in other currencies are not
          included.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Income vs costs, last 6 months">
          <div className="flex h-40 items-end gap-3">
            {summary.months.map((month) => (
              <Tooltip key={month.key}>
                <TooltipTrigger
                  render={
                    // Focusable, and labelled with the same numbers the tooltip shows.
                    <button
                      type="button"
                      aria-label={
                        hidden
                          ? `${monthLabel.format(month.date)}: amounts hidden`
                          : `${monthLabel.format(month.date)}: income ${formatMoney(
                              month.incomeCents,
                              currency,
                            )}, costs ${formatMoney(month.costCents, currency)}`
                      }
                      className="flex h-full flex-1 flex-col items-center gap-1"
                    />
                  }
                >
                  <div aria-hidden className="flex w-full flex-1 items-end justify-center gap-1">
                    <div
                      className="w-3 rounded-t-sm bg-success"
                      style={{ height: `${(month.incomeCents / chartMax) * 100}%` }}
                    />
                    <div
                      className="w-3 rounded-t-sm bg-destructive/70"
                      style={{ height: `${(month.costCents / chartMax) * 100}%` }}
                    />
                  </div>
                  <span aria-hidden className="text-muted-foreground text-xs">
                    {monthLabel.format(month.date)}
                  </span>
                </TooltipTrigger>
                <TooltipPopup side="top">
                  <div className="flex flex-col">
                    <span>
                      Income: <Money cents={month.incomeCents} currency={currency} />
                    </span>
                    <span>
                      Costs: <Money cents={month.costCents} currency={currency} />
                    </span>
                  </div>
                </TooltipPopup>
              </Tooltip>
            ))}
          </div>
          <div className="flex gap-4 text-muted-foreground text-xs">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-success" /> Income
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-destructive/70" /> Costs
            </span>
          </div>
        </Section>

        <Section title="Cost to maintain each project">
          {perProject.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {projectId === null
                ? "Add recurring costs to see this."
                : "No recurring cost supports the focused project."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {rankedProjects.items.map(([id, cents]) => (
                <li key={id ?? "none"} className="flex flex-col gap-1">
                  <div className="flex justify-between gap-2 text-sm">
                    <span className="truncate">{projectTitle(id)}</span>
                    <Money cents={cents} currency={currency} />
                  </div>
                  <div className="h-1.5 rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(cents / projectMax) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <CollectionPager {...rankedProjects} label="projects" onPageChange={setRankingPage} />
        </Section>
      </div>

      <div className="grid gap-4 2xl:grid-cols-2">
        <IncomeSection income={income} currency={currency} />
        <CostsSection
          costs={costs}
          archivedCosts={archivedCosts}
          currency={currency}
          projectTitle={projectTitle}
        />
      </div>
    </div>
  );
}

function IncomeSection({
  income,
  currency,
}: {
  income: ReadonlyArray<CommandCenterIncome>;
  currency: string;
}) {
  const { canOperate } = useCommandCenter();
  const { upsert, removeWithUndo } = useCommandCenterCommands();
  const [concept, setConcept] = useState("");
  const [clientName, setClientName] = useState("");
  const [date, setDate] = useState(localToday);
  const [amount, setAmount] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<keyof typeof STATUS_LABEL | "all">("all");
  const [page, setPage] = useState(1);
  const incomePage = paginateCollection(filterIncome(income, query, status), page, 10);
  const amountCents = parseCents(amount);
  const valid =
    concept.trim() !== "" && clientName.trim() !== "" && date !== "" && amountCents !== null;

  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canOperate || !valid || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await upsert({
        entity: "income",
        value: {
          concept: concept.trim(),
          clientName: clientName.trim(),
          date,
          amountCents,
          currency,
          status: "pending",
        },
      });
      if (result._tag === "Success") {
        setConcept("");
        setAmount("");
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Section title="Income">
      <form
        className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_auto_6rem_auto]"
        onSubmit={submit}
      >
        <Input
          aria-label="Concept"
          placeholder="Concept"
          size="sm"
          value={concept}
          onChange={(e) => setConcept(e.target.value)}
          disabled={!canOperate || saving}
        />
        <Input
          aria-label="Client"
          placeholder="Client"
          size="sm"
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
          disabled={!canOperate || saving}
        />
        <Input
          aria-label="Date"
          type="date"
          size="sm"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          disabled={!canOperate || saving}
        />
        <Input
          aria-label={`Amount in ${currency}`}
          placeholder={currency}
          inputMode="decimal"
          size="sm"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={!canOperate || saving}
        />
        <Button type="submit" size="sm" disabled={!canOperate || !valid || saving}>
          <PlusIcon /> {saving ? "Saving…" : "Add"}
        </Button>
      </form>
      <div className="flex flex-wrap gap-2 border-t pt-3">
        <div className="min-w-40 flex-1">
          <Input
            size="sm"
            aria-label="Search income"
            placeholder="Search client or concept"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="min-w-36">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value ?? "all");
              setPage(1);
            }}
          >
            <SelectTrigger size="sm" aria-label="Income status">
              <SelectValue>{status === "all" ? "All statuses" : STATUS_LABEL[status]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All statuses</SelectItem>
              {(["pending", "paid", "overdue"] as const).map((value) => (
                <SelectItem key={value} value={value}>
                  {STATUS_LABEL[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
      {incomePage.total === 0 ? (
        <p className="py-4 text-muted-foreground text-sm">
          {income.length === 0 ? "No income yet." : "No income matches these filters."}
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {incomePage.items.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{row.concept}</span>
                <span className="truncate text-muted-foreground text-xs">
                  {row.clientName} · {row.date}
                </span>
              </div>
              <Money cents={row.amountCents} currency={row.currency} />
              <Badge
                variant={STATUS_VARIANT[row.status]}
                render={<button type="button" disabled={!canOperate} />}
                aria-label={`Status ${STATUS_LABEL[row.status]}, click to change`}
                onClick={() =>
                  void upsert({
                    entity: "income",
                    value: { ...pickIncome(row), status: NEXT_INCOME_STATUS[row.status] },
                  })
                }
              >
                {STATUS_LABEL[row.status]}
              </Badge>
              <Button
                size="icon-xs"
                variant="ghost-destructive"
                aria-label={`Delete ${row.concept}`}
                disabled={!canOperate}
                onClick={() =>
                  void removeWithUndo(
                    { entity: "income", id: row.id },
                    { entity: "income", value: pickIncome(row) },
                    `Deleted ${row.concept}`,
                  )
                }
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <CollectionPager {...incomePage} label="income entries" onPageChange={setPage} />
    </Section>
  );
}

function pickIncome({
  id,
  concept,
  clientName,
  date,
  amountCents,
  currency,
  status,
}: CommandCenterIncome) {
  return { id, concept, clientName, date, amountCents, currency, status };
}

function pickCost({
  id,
  concept,
  category,
  monthlyCents,
  currency,
  projectIds,
}: CommandCenterCost) {
  return { id, concept, category, monthlyCents, currency, projectIds };
}

/** Multi-select of T3 projects for a cost. */
function ProjectPicker({
  value,
  onChange,
  projectTitle,
  disabled = false,
}: {
  value: ReadonlyArray<ProjectId>;
  onChange: (next: ReadonlyArray<ProjectId>) => void;
  projectTitle: (id: ProjectId | null) => string;
  disabled?: boolean;
}) {
  const { projects, canOperate } = useCommandCenter();
  const [query, setQuery] = useState("");
  const listRef = useRef<LegendListRef | null>(null);
  const highlightedRef = useRef<ProjectId | null>(null);
  const projectIds = projects.map((project) => project.id);
  const matchingIds = projects
    .filter((project) =>
      project.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    )
    .map((project) => project.id);
  const label =
    value.length === 0
      ? "No project"
      : value.length === 1
        ? projectTitle(value[0]!)
        : `${value.length} projects`;
  return (
    <Combobox
      multiple
      disabled={!canOperate || disabled}
      virtualized
      autoHighlight
      items={projectIds}
      filteredItems={matchingIds}
      value={[...value]}
      itemToStringLabel={projectTitle}
      onValueChange={onChange}
      onItemHighlighted={(id, details) => {
        highlightedRef.current = id ?? null;
        if (details.reason === "keyboard" && details.index >= 0) {
          void listRef.current?.scrollIndexIntoView({ index: details.index, animated: false });
        }
      }}
      onOpenChange={(open) => {
        if (!open) {
          setQuery("");
          highlightedRef.current = null;
        }
      }}
    >
      <ComboboxTrigger
        aria-label={`Projects for this cost: ${label}`}
        render={
          <Button type="button" size="sm" variant="outline" disabled={!canOperate || disabled} />
        }
      >
        <span className="max-w-32 truncate">{label}</span>
      </ComboboxTrigger>
      <ComboboxPopup align="end">
        <ComboboxSearchInput
          aria-label="Find projects for this cost"
          placeholder="Search projects"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            void listRef.current?.scrollToOffset({ offset: 0, animated: false });
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229)
              return;
            event.preventDefault();
            event.stopPropagation();
            const id = highlightedRef.current;
            (
              event as typeof event & { preventBaseUIHandler?: () => void }
            ).preventBaseUIHandler?.();
            if (id === null || !matchingIds.includes(id)) return;
            onChange(
              value.includes(id) ? value.filter((selected) => selected !== id) : [...value, id],
            );
          }}
        />
        <ComboboxEmpty>
          {projects.length === 0 ? "No projects" : "No matching projects"}
        </ComboboxEmpty>
        <div className="h-64 max-h-(--available-height) min-h-0 w-80 max-w-full overflow-hidden">
          <ComboboxListVirtualized>
            <LegendList
              ref={listRef}
              data={matchingIds}
              keyExtractor={(id) => id}
              estimatedItemSize={32}
              drawDistance={160}
              className="h-full overflow-x-hidden overscroll-y-contain"
              renderItem={({ item: id, index }) => (
                <ComboboxItem value={id} index={index}>
                  {projectTitle(id)}
                </ComboboxItem>
              )}
            />
          </ComboboxListVirtualized>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}

function CostsSection({
  costs,
  archivedCosts,
  currency,
  projectTitle,
}: {
  costs: ReadonlyArray<CommandCenterCost>;
  archivedCosts: ReadonlyArray<CommandCenterCost>;
  currency: string;
  projectTitle: (id: ProjectId | null) => string;
}) {
  const { canOperate, projectId } = useCommandCenter();
  const { upsert, remove } = useCommandCenterCommands();
  const [concept, setConcept] = useState("");
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [projectIds, setProjectIds] = useState<ReadonlyArray<ProjectId>>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [archivePage, setArchivePage] = useState(1);
  const onFocus = (cost: CommandCenterCost) =>
    projectId === null || cost.projectIds.includes(projectId);
  const costPage = paginateCollection(
    filterCosts(costs, query, projectTitle).filter(onFocus),
    page,
    10,
  );
  const archivedPage = paginateCollection(
    filterCosts(archivedCosts, query, projectTitle).filter(onFocus),
    archivePage,
    10,
  );
  const monthlyCents = parseCents(amount);
  const valid = concept.trim() !== "" && monthlyCents !== null;

  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canOperate || !valid || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await upsert({
        entity: "cost",
        value: {
          concept: concept.trim(),
          category: category.trim(),
          monthlyCents,
          currency,
          projectIds,
        },
      });
      if (result._tag === "Success") {
        setConcept("");
        setCategory("");
        setAmount("");
        setProjectIds([]);
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Section title="Recurring costs">
      <form
        className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_6rem_auto_auto]"
        onSubmit={submit}
      >
        <Input
          aria-label="Concept"
          placeholder="Concept"
          size="sm"
          value={concept}
          onChange={(e) => setConcept(e.target.value)}
          disabled={!canOperate || saving}
        />
        <Input
          aria-label="Category"
          placeholder="Category"
          size="sm"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          disabled={!canOperate || saving}
        />
        <Input
          aria-label={`Monthly amount in ${currency}`}
          placeholder={`${currency}/mo`}
          inputMode="decimal"
          size="sm"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={!canOperate || saving}
        />
        <ProjectPicker
          value={projectIds}
          onChange={setProjectIds}
          projectTitle={projectTitle}
          disabled={saving}
        />
        <Button type="submit" size="sm" disabled={!canOperate || !valid || saving}>
          <PlusIcon /> {saving ? "Saving…" : "Add"}
        </Button>
      </form>
      <div className="border-t pt-3">
        <Input
          size="sm"
          aria-label="Search recurring costs"
          placeholder="Search concept, category or project"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
            setArchivePage(1);
          }}
        />
      </div>
      {costPage.total === 0 ? (
        <p className="py-4 text-muted-foreground text-sm">
          {costs.length === 0
            ? "No recurring costs yet."
            : query.trim() === ""
              ? "No recurring cost supports the focused project."
              : "No costs match this search."}
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {costPage.items.map((cost) => (
            <li key={cost.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{cost.concept}</span>
                {cost.category ? (
                  <span className="truncate text-muted-foreground text-xs">{cost.category}</span>
                ) : null}
              </div>
              <ProjectPicker
                value={cost.projectIds}
                projectTitle={projectTitle}
                onChange={(next) =>
                  void upsert({ entity: "cost", value: { ...pickCost(cost), projectIds: next } })
                }
              />
              <Money cents={cost.monthlyCents} currency={cost.currency} />
              <Button
                size="icon-xs"
                variant="ghost-destructive"
                aria-label={`Remove ${cost.concept}`}
                disabled={!canOperate}
                onClick={() => void remove({ entity: "cost", id: cost.id })}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <CollectionPager {...costPage} label="recurring costs" onPageChange={setPage} />
      {archivedCosts.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger render={<Button size="xs" variant="ghost-muted" />}>
            Archived ({archivedCosts.length})
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <ul className="flex flex-col divide-y">
              {archivedPage.items.map((cost) => (
                <li
                  key={cost.id}
                  className="flex items-center gap-3 py-2 text-muted-foreground text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{cost.concept}</span>
                  <Money cents={cost.monthlyCents} currency={cost.currency} />
                  {/* Upserting an archived row restores it. ponytail: the archived gap is
                      not kept, so past months count it again; add archive history if that
                      matters. */}
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Restore ${cost.concept}`}
                    disabled={!canOperate}
                    onClick={() => void upsert({ entity: "cost", value: pickCost(cost) })}
                  >
                    <ArchiveRestoreIcon />
                  </Button>
                </li>
              ))}
            </ul>
            <CollectionPager
              {...archivedPage}
              label="archived costs"
              onPageChange={setArchivePage}
            />
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </Section>
  );
}
