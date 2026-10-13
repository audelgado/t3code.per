import type {
  CommandCenterWorkflow,
  CommandCenterWorkflowListResult,
  CommandCenterWorkflowRunId,
  CommandCenterWorkflowRunsState,
  CommandCenterWorkflowSlug,
  CommandCenterWorkflowSummary,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { CopyIcon, PlayIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { Field } from "./NodePanel";
import { useDocumentVisible } from "../infra/useDocumentVisible";
import { SkillsPanel } from "./text/SkillsPanel";
import { SnippetsPanel } from "./text/SnippetsPanel";
import type { WorkflowCommands } from "./useWorkflowCommands";
import { lastRunBySlug, RUN_STATUS_LABEL, statusVariant, uniqueSlug } from "./workflowLogic";

type Section = "library" | "deleted" | "skills" | "snippets";
const isSection = (value: unknown): value is Section =>
  value === "library" || value === "deleted" || value === "skills" || value === "snippets";

/** Recent runs listed under the library; older ones stay reachable from each run's workflow. */
const RECENT_RUNS = 8;

/**
 * A project's workflows: cards with their inputs and last run, recent runs, built-in starters to
 * copy in, deleted workflows to restore, and the project's skills and snippets.
 */
export function WorkflowLibrary({
  environmentId,
  projectId,
  list,
  listError,
  runs,
  commands,
  onOpen,
  onRun,
  onOpenRun,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly list: CommandCenterWorkflowListResult | null;
  readonly listError: string | null;
  readonly runs: CommandCenterWorkflowRunsState | null;
  readonly commands: WorkflowCommands;
  readonly onOpen: (slug: CommandCenterWorkflowSlug) => void;
  readonly onRun: (workflow: Pick<CommandCenterWorkflow, "slug" | "title" | "inputs">) => void;
  readonly onOpenRun: (runId: CommandCenterWorkflowRunId) => void;
}) {
  const [section, setSection] = useState<Section>("library");
  const [creating, setCreating] = useState(false);
  const lastRuns = useMemo(() => lastRunBySlug(runs?.runs ?? []), [runs]);
  const taken = useMemo(
    () => new Set((list?.workflows ?? []).map((workflow) => workflow.slug as string)),
    [list],
  );

  const create = async (workflow: CommandCenterWorkflow) => {
    const result = await commands.save(workflow);
    if (result._tag !== "Success") return false;
    onOpen(result.value.slug);
    return true;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          aria-label="Which workflows"
          variant="segmented"
          value={[section]}
          onValueChange={(next) => {
            if (isSection(next[0])) setSection(next[0]);
          }}
        >
          <Toggle value="library">Library</Toggle>
          <Toggle value="deleted">Deleted</Toggle>
          <Toggle value="skills">Skills</Toggle>
          <Toggle value="snippets">Snippets</Toggle>
        </ToggleGroup>
        <div className="flex-1" />
        {commands.canWrite && section === "library" ? (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <PlusIcon />
            New workflow
          </Button>
        ) : null}
      </div>

      {section === "skills" ? (
        <SkillsPanel environmentId={environmentId} projectId={projectId} />
      ) : section === "snippets" ? (
        <SnippetsPanel environmentId={environmentId} projectId={projectId} />
      ) : section === "deleted" ? (
        <DeletedWorkflows environmentId={environmentId} projectId={projectId} commands={commands} />
      ) : list === null ? (
        <p className="py-12 text-center text-sm text-muted-foreground" role="status">
          {listError ? `Could not load workflows: ${listError}` : "Loading workflows…"}
        </p>
      ) : (
        <>
          {list.workflows.length === 0 ? (
            <p className="rounded-xl border border-dashed py-8 text-center text-sm text-muted-foreground">
              No workflows in this project yet. Copy a starter below, make a new one, or ask an
              agent to build one.
            </p>
          ) : (
            <ul
              aria-label="Workflows"
              className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3"
            >
              {list.workflows.map((workflow) => (
                <WorkflowCard
                  key={workflow.slug}
                  workflow={workflow}
                  lastRun={lastRuns.get(workflow.slug) ?? null}
                  canRun={commands.canRun}
                  onOpen={() => onOpen(workflow.slug)}
                  onRun={() => onRun(workflow)}
                  onOpenRun={onOpenRun}
                />
              ))}
            </ul>
          )}
          <RecentRuns runs={runs} onOpenRun={onOpenRun} />
          <Starters
            environmentId={environmentId}
            canWrite={commands.canWrite}
            taken={taken}
            onCopy={create}
          />
        </>
      )}

      {creating ? (
        <NewWorkflowDialog
          taken={taken}
          onClose={() => setCreating(false)}
          onCreate={(title, slug) =>
            create({
              slug,
              title,
              description: "",
              inputs: [],
              nodes: [],
              edges: [],
              layout: {},
            })
          }
        />
      ) : null}
    </div>
  );
}

function WorkflowCard({
  workflow,
  lastRun,
  canRun,
  onOpen,
  onRun,
  onOpenRun,
}: {
  readonly workflow: CommandCenterWorkflowSummary;
  readonly lastRun: CommandCenterWorkflowRunsState["runs"][number] | null;
  readonly canRun: boolean;
  readonly onOpen: () => void;
  readonly onRun: () => void;
  readonly onOpenRun: (runId: CommandCenterWorkflowRunId) => void;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-xl border bg-card p-3">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-col gap-1 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="truncate text-sm font-medium">{workflow.title}</span>
        {workflow.description ? (
          <span className="line-clamp-2 text-xs text-muted-foreground">{workflow.description}</span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {workflow.nodeCount} step{workflow.nodeCount === 1 ? "" : "s"} · edited{" "}
          {formatRelativeTimeLabel(workflow.updatedAt)}
        </span>
      </button>
      {workflow.error ? (
        <p className="line-clamp-3 text-xs text-destructive-foreground">{workflow.error}</p>
      ) : null}
      {workflow.inputs.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {workflow.inputs.map((input) => (
            <Badge key={input.name} size="sm" variant="outline">
              {input.label}
            </Badge>
          ))}
        </div>
      ) : null}
      <div className="mt-auto flex items-center gap-2">
        {lastRun ? (
          <button
            type="button"
            onClick={() => onOpenRun(lastRun.id)}
            className="flex min-w-0 items-center gap-1.5 rounded-md text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <Badge size="sm" variant={statusVariant(lastRun.status)}>
              {RUN_STATUS_LABEL[lastRun.status]}
            </Badge>
            <span className="truncate">{formatRelativeTimeLabel(lastRun.startedAt)}</span>
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">Never run</span>
        )}
        <div className="flex-1" />
        <Button size="xs" variant="outline" onClick={onOpen}>
          Edit
        </Button>
        <Button
          size="xs"
          disabled={!canRun || workflow.error !== null || workflow.nodeCount === 0}
          onClick={onRun}
        >
          <PlayIcon />
          Run
        </Button>
      </div>
    </li>
  );
}

function RecentRuns({
  runs,
  onOpenRun,
}: {
  readonly runs: CommandCenterWorkflowRunsState | null;
  readonly onOpenRun: (runId: CommandCenterWorkflowRunId) => void;
}) {
  const recent = (runs?.runs ?? []).slice(0, RECENT_RUNS);
  if (recent.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Recent runs</h3>
      <ul className="flex flex-col divide-y rounded-xl border">
        {recent.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => onOpenRun(run.id)}
              className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-start text-sm outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <Badge size="sm" variant={statusVariant(run.status)}>
                {RUN_STATUS_LABEL[run.status]}
              </Badge>
              <span className="min-w-0 flex-1 truncate">{run.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatRelativeTimeLabel(run.startedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Starters({
  environmentId,
  canWrite,
  taken,
  onCopy,
}: {
  readonly environmentId: EnvironmentId;
  readonly canWrite: boolean;
  readonly taken: ReadonlySet<string>;
  readonly onCopy: (workflow: CommandCenterWorkflow) => Promise<boolean>;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.commandCenterWorkflowStarters({ environmentId, input: {} }),
  );
  const [copying, setCopying] = useState<string | null>(null);
  const starters = query.data?.starters ?? [];
  if (starters.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Starters</h3>
      <p className="text-xs text-muted-foreground">
        Built-in workflows. Copy one into this project to run or change it.
      </p>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
        {starters.map((starter) => (
          <li
            key={starter.slug}
            className="flex flex-col gap-2 rounded-xl border border-dashed p-3"
          >
            <span className="truncate text-sm font-medium">{starter.title}</span>
            <span className="line-clamp-3 text-xs text-muted-foreground">
              {starter.description}
            </span>
            {canWrite ? (
              <div className="mt-auto">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={copying !== null}
                  onClick={async () => {
                    setCopying(starter.slug);
                    await onCopy({ ...starter, slug: uniqueSlug(starter.slug, taken) });
                    setCopying(null);
                  }}
                >
                  <CopyIcon />
                  {taken.has(starter.slug) ? "Copy again" : "Copy to project"}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DeletedWorkflows({
  environmentId,
  projectId,
  commands,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly commands: WorkflowCommands;
}) {
  // Like the library feed, it ends while the window is hidden.
  const visible = useDocumentVisible();
  const query = useEnvironmentQuery(
    visible
      ? serverEnvironment.commandCenterWorkflowsLive({
          environmentId,
          input: { projectId, trashed: true },
        })
      : null,
  );
  const [restoring, setRestoring] = useState<string | null>(null);
  if (query.data === null) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground" role="status">
        {query.error ? `Could not load deleted workflows: ${query.error}` : "Loading…"}
      </p>
    );
  }
  if (query.data.workflows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed py-8 text-center text-sm text-muted-foreground">
        Nothing deleted. Deleted workflows wait in .t3/workflows/.trash until you restore them.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y rounded-xl border">
      {query.data.workflows.map((workflow) => (
        <li key={workflow.slug} className="flex items-center gap-2 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm">{workflow.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatRelativeTimeLabel(workflow.updatedAt)}
          </span>
          {commands.canWrite ? (
            <Button
              size="xs"
              variant="outline"
              disabled={restoring !== null}
              onClick={async () => {
                setRestoring(workflow.slug);
                await commands.restore(workflow.slug);
                setRestoring(null);
              }}
            >
              <RotateCcwIcon />
              Restore
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function NewWorkflowDialog({
  taken,
  onClose,
  onCreate,
}: {
  readonly taken: ReadonlySet<string>;
  readonly onClose: () => void;
  readonly onCreate: (title: string, slug: CommandCenterWorkflowSlug) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const slug = uniqueSlug(title, taken);
  const save = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    const created = await onCreate(title.trim(), slug);
    setSaving(false);
    if (created) onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>New workflow</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Field label="Title" hint={`Saved as .t3/workflows/${slug}.json`}>
              <Input
                autoFocus
                value={title}
                disabled={saving}
                placeholder="Review and ship a PR"
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
              Cancel
            </DialogClose>
            <Button type="submit" size="sm" disabled={saving || !title.trim()}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
