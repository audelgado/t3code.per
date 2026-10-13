import type { CommandCenterCost, CommandCenterIncome, ProjectId } from "@t3tools/contracts";
import { ArchiveRestoreIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useRelativeTimeTick } from "../../settings/settingsLayout";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { Input } from "../../ui/input";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { formatMoney, Money, useCommandCenter, useCommandCenterCommands } from "../shared";
import {
  costByProject,
  displayCurrency,
  financeSummary,
  NEXT_INCOME_STATUS,
  parseCents,
} from "./logic";

const STATUS_VARIANT = { pending: "warning", paid: "success", overdue: "error" } as const;

const monthLabel = new Intl.DateTimeFormat(undefined, { month: "short" });

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <h2 className="font-medium text-sm">{title}</h2>
      {children}
    </section>
  );
}

function Kpi({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border bg-card p-4">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-semibold text-xl">{children}</span>
    </div>
  );
}

/** Finance tab: billing per client, recurring costs split across the projects they support. */
export function FinanceTab() {
  const { snapshot, projects, projectId, hidden } = useCommandCenter();
  const nowMs = useRelativeTimeTick(60_000);
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
  const perProject = useMemo(
    () =>
      [...costByProject(snapshot.costs, currency)].toSorted((left, right) => right[1] - left[1]),
    [currency, snapshot.costs],
  );
  const projectTitle = (id: ProjectId | null) =>
    id === null
      ? "No project"
      : (projects.find((project) => project.id === id)?.title ?? "Unknown project");
  const chartMax = Math.max(1, ...summary.months.flatMap((m) => [m.incomeCents, m.costCents]));
  const projectMax = Math.max(1, ...perProject.map(([, cents]) => cents));

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
            <p className="text-muted-foreground text-sm">Add recurring costs to see this.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {perProject.map(([id, cents]) => (
                <li
                  key={id ?? "none"}
                  className={cn(
                    "flex flex-col gap-1",
                    projectId !== null && id !== projectId && "opacity-40",
                  )}
                >
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
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
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
  const amountCents = parseCents(amount);
  const valid =
    concept.trim() !== "" && clientName.trim() !== "" && date !== "" && amountCents !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
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
          disabled={!canOperate}
        />
        <Input
          aria-label="Client"
          placeholder="Client"
          size="sm"
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
          disabled={!canOperate}
        />
        <Input
          aria-label="Date"
          type="date"
          size="sm"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          disabled={!canOperate}
        />
        <Input
          aria-label={`Amount in ${currency}`}
          placeholder={currency}
          inputMode="decimal"
          size="sm"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={!canOperate}
        />
        <Button type="submit" size="sm" disabled={!canOperate || !valid}>
          <PlusIcon /> Add
        </Button>
      </form>
      {income.length === 0 ? (
        <p className="text-muted-foreground text-sm">No income yet.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {income.map((row) => (
            <li key={row.id} className="flex items-center gap-3 py-2 text-sm">
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
                aria-label={`Status ${row.status}, click to change`}
                onClick={() =>
                  void upsert({
                    entity: "income",
                    value: { ...pickIncome(row), status: NEXT_INCOME_STATUS[row.status] },
                  })
                }
              >
                {row.status}
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
}: {
  value: ReadonlyArray<ProjectId>;
  onChange: (next: ReadonlyArray<ProjectId>) => void;
  projectTitle: (id: ProjectId | null) => string;
}) {
  const { projects, canOperate } = useCommandCenter();
  const label =
    value.length === 0
      ? "No project"
      : value.length === 1
        ? projectTitle(value[0]!)
        : `${value.length} projects`;
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" disabled={!canOperate} />}>
        <span className="max-w-32 truncate">{label}</span>
      </MenuTrigger>
      <MenuPopup align="end">
        {projects.length === 0 ? (
          <p className="px-2 py-1 text-muted-foreground text-sm">No projects</p>
        ) : (
          projects.map((project) => (
            <MenuCheckboxItem
              key={project.id}
              checked={value.includes(project.id)}
              onCheckedChange={(checked) =>
                onChange(checked ? [...value, project.id] : value.filter((id) => id !== project.id))
              }
            >
              {project.title}
            </MenuCheckboxItem>
          ))
        )}
      </MenuPopup>
    </Menu>
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
  const monthlyCents = parseCents(amount);
  const valid = concept.trim() !== "" && monthlyCents !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
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
          disabled={!canOperate}
        />
        <Input
          aria-label="Category"
          placeholder="Category"
          size="sm"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          disabled={!canOperate}
        />
        <Input
          aria-label={`Monthly amount in ${currency}`}
          placeholder={`${currency}/mo`}
          inputMode="decimal"
          size="sm"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={!canOperate}
        />
        <ProjectPicker value={projectIds} onChange={setProjectIds} projectTitle={projectTitle} />
        <Button type="submit" size="sm" disabled={!canOperate || !valid}>
          <PlusIcon /> Add
        </Button>
      </form>
      {costs.length === 0 ? (
        <p className="text-muted-foreground text-sm">No recurring costs yet.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {costs.map((cost) => (
            <li
              key={cost.id}
              className={cn(
                "flex items-center gap-3 py-2 text-sm",
                projectId !== null && !cost.projectIds.includes(projectId) && "opacity-40",
              )}
            >
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
      {archivedCosts.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger render={<Button size="xs" variant="ghost-muted" />}>
            Archived ({archivedCosts.length})
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <ul className="flex flex-col divide-y">
              {archivedCosts.map((cost) => (
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
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </Section>
  );
}
