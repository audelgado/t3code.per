import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  CommandCenterWorkflow,
  CommandCenterWorkflowNode,
  CommandCenterWorkflowRunId,
  CommandCenterWorkflowRunsState,
  CommandCenterWorkflowSlug,
  CommandCenterWorkflowStep,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useDiffPanelStore } from "~/diffPanelStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import type { Point } from "../canvas/canvasLogic";
import { useCommandCenter } from "../shared";
import type { WorkflowCommands } from "./useWorkflowCommands";
import { WorkflowCanvas } from "./WorkflowCanvas";
import {
  canResumeRun,
  canRetryStep,
  canStopRun,
  describeNode,
  mergeRunSteps,
  NODE_KIND_LABEL,
  nodePositions,
  nodeRunStates,
  nodeTitle,
  retryTarget,
  RUN_STATUS_LABEL,
  STEP_STATUS_LABEL,
  statusVariant,
} from "./workflowLogic";

/**
 * One run: the workflow as it started, each node colored by its step, and the selected node's
 * attempts with their thread, changes and retry. Updates arrive on the live runs feed.
 */
export function WorkflowRunView({
  environmentId,
  runId,
  live,
  commands,
  isSaved,
  onBack,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly runId: CommandCenterWorkflowRunId;
  /** The project's live runs; null while (re)connecting. */
  readonly live: CommandCenterWorkflowRunsState | null;
  readonly commands: WorkflowCommands;
  /** False when the project has no file for a workflow (a starter run, or deleted since). */
  readonly isSaved: (slug: CommandCenterWorkflowSlug) => boolean;
  readonly onBack: () => void;
  readonly onEdit: (slug: CommandCenterWorkflowSlug) => void;
}) {
  const { snapshot } = useCommandCenter();
  const query = useEnvironmentQuery(
    serverEnvironment.commandCenterWorkflowRun({ environmentId, input: { runId } }),
  );
  const detail = query.data;
  const liveRun = live?.runs.find((run) => run.id === runId) ?? null;
  // The live feed carries the run's status, not every step; re-read the run when it moves on
  // (a missed step change, or a restart that dropped the feed).
  const refresh = query.refresh;
  const requested = useRef<string | null>(null);
  const liveMark = liveRun ? `${liveRun.status}:${liveRun.finishedAt ?? ""}` : null;
  const detailMark = detail ? `${detail.run.status}:${detail.run.finishedAt ?? ""}` : null;
  useEffect(() => {
    if (liveMark === null || detailMark === null || liveMark === detailMark) return;
    if (requested.current === liveMark) return;
    requested.current = liveMark;
    refresh();
  }, [detailMark, liveMark, refresh]);
  const run =
    detail && liveRun
      ? liveRun.updatedAt >= detail.run.updatedAt
        ? liveRun
        : detail.run
      : (detail?.run ?? liveRun);
  const detailSteps = detail?.steps;
  const liveSteps = live?.steps;
  const steps = useMemo(
    () => (detailSteps ? mergeRunSteps(detailSteps, liveSteps ?? [], runId) : []),
    [detailSteps, liveSteps, runId],
  );
  const states = useMemo(() => nodeRunStates(steps), [steps]);
  const workflow = detail?.workflow ?? null;
  const positions = useMemo(
    () => (workflow ? nodePositions(workflow) : new Map<string, Point>()),
    [workflow],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!detail || !workflow || !run) {
    return (
      <section className="flex flex-col gap-3">
        <div>
          <Button size="sm" variant="ghost" onClick={onBack}>
            <ArrowLeftIcon />
            Workflows
          </Button>
        </div>
        <p className="py-12 text-center text-sm text-muted-foreground" role="status">
          {query.error ? `Could not open the run: ${query.error}` : "Opening the run…"}
        </p>
      </section>
    );
  }
  const selected = workflow.nodes.find((node) => node.id === selectedId) ?? null;
  // The live feed holds only the newest runs, so an older one gets no updates from it: re-read
  // the run after acting on it. ponytail: its later progress shows on reopen, not live.
  const act = async <A extends { readonly _tag: string }>(action: () => Promise<A>) => {
    setBusy(true);
    const result = await action();
    setBusy(false);
    if (liveRun === null) refresh();
    return result;
  };
  const inputs = Object.entries(run.inputs);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon />
          Workflows
        </Button>
        <h2 className="min-w-0 truncate text-sm font-medium">{run.title}</h2>
        <Badge variant={statusVariant(run.status)}>{RUN_STATUS_LABEL[run.status]}</Badge>
        <span className="text-xs text-muted-foreground">
          Started {formatRelativeTimeLabel(run.startedAt)}
          {run.finishedAt ? ` · finished ${formatRelativeTimeLabel(run.finishedAt)}` : ""}
        </span>
        <div className="min-w-0 flex-1" />
        {isSaved(run.slug) ? (
          <Button size="sm" variant="ghost" onClick={() => onEdit(run.slug)}>
            <PencilIcon />
            Edit workflow
          </Button>
        ) : null}
        {commands.canRun && canResumeRun(run.status) ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            title="Retries every failed or stopped step"
            onClick={() => void act(() => commands.resume(run.id))}
          >
            <PlayIcon />
            Resume
          </Button>
        ) : null}
        {commands.canRun && canStopRun(run.status) ? (
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={busy}
            onClick={() => void act(() => commands.stop(run.id))}
          >
            <SquareIcon />
            Stop
          </Button>
        ) : null}
      </div>
      {run.error ? (
        <Alert variant={run.status === "failed" ? "error" : "warning"}>
          <AlertTitle>{RUN_STATUS_LABEL[run.status]}</AlertTitle>
          <AlertDescription>{run.error}</AlertDescription>
        </Alert>
      ) : null}
      {inputs.length > 0 ? (
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {inputs.map(([name, value]) => (
            <div key={name} className="flex min-w-0 max-w-full gap-1">
              <dt className="text-muted-foreground">
                {workflow.inputs.find((input) => input.name === name)?.label ?? name}:
              </dt>
              <dd className="truncate">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <WorkflowCanvas
          label={`${run.title} run`}
          workflow={workflow}
          positions={positions}
          selectedId={selectedId}
          onSelect={setSelectedId}
          describe={(node) => describeNode(node, snapshot.agentProfiles)}
          runStates={states}
        />
        <aside className="flex min-w-0 flex-col gap-3 rounded-xl border p-3 lg:max-h-[min(65vh,680px)] lg:overflow-y-auto">
          {selected ? (
            <NodeSteps
              workflow={workflow}
              node={selected}
              steps={states.get(selected.id)?.steps ?? []}
              environmentId={run.environmentId}
              canRun={commands.canRun}
              onRetry={async (step) => {
                await act(() => commands.retry({ runId: run.id, ...retryTarget(workflow, step) }));
              }}
              onAnswer={async (nodeId, answer) =>
                (await act(() => commands.answer({ runId: run.id, nodeId, ...answer })))._tag ===
                "Success"
              }
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Select a step to see its result, open its thread or retry it.
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}

function NodeSteps({
  workflow,
  node,
  steps,
  environmentId,
  canRun,
  onRetry,
  onAnswer,
}: {
  readonly workflow: CommandCenterWorkflow;
  readonly node: CommandCenterWorkflowNode;
  readonly steps: ReadonlyArray<CommandCenterWorkflowStep>;
  readonly environmentId: EnvironmentId;
  readonly canRun: boolean;
  readonly onRetry: (step: CommandCenterWorkflowStep) => Promise<void>;
  readonly onAnswer: WorkflowStepAnswer;
}) {
  const parallel = node.kind === "parallel";
  return (
    <div className="flex flex-col gap-3">
      <h3 className="truncate text-sm font-medium">
        {NODE_KIND_LABEL[node.kind]} · {nodeTitle(node)}
      </h3>
      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">Has not started yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {steps.map((step) => (
            <li key={step.id} className="flex flex-col gap-1.5 rounded-lg border p-2.5">
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Badge size="sm" variant={statusVariant(step.status)}>
                  {STEP_STATUS_LABEL[step.status]}
                </Badge>
                {step.item !== null ? <span>Item {step.item + 1}</span> : null}
                {step.attempt > 1 ? <span>Attempt {step.attempt}</span> : null}
                {step.finishedAt ? (
                  <span>{formatRelativeTimeLabel(step.finishedAt)}</span>
                ) : step.startedAt ? (
                  <span>Started {formatRelativeTimeLabel(step.startedAt)}</span>
                ) : null}
              </div>
              {step.error ? (
                <p className="text-xs text-destructive-foreground">{step.error}</p>
              ) : null}
              {step.output ? (
                <p className="max-h-48 overflow-y-auto text-xs whitespace-pre-wrap wrap-anywhere">
                  {step.output}
                </p>
              ) : null}
              {step.status === "waiting" && step.item === null ? (
                <StepAnswer node={node} disabled={!canRun} onAnswer={onAnswer} />
              ) : null}
              <div className="flex flex-wrap gap-1.5">
                {step.threadId !== null ? (
                  <StepThreadActions environmentId={environmentId} threadId={step.threadId} />
                ) : null}
                {canRun && canRetryStep(step.status) ? (
                  <Button size="xs" variant="outline" onClick={() => void onRetry(step)}>
                    <RotateCcwIcon />
                    {parallel ? "Retry failed items" : "Retry"}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {parallel ? (
        <p className="text-xs text-muted-foreground">
          Select{" "}
          {workflow.nodes.find((candidate) => candidate.id === node.node)?.title ?? node.node} to
          see each item.
        </p>
      ) : null}
    </div>
  );
}

/** Answers a waiting ask or decides a manual gate; resolves true once the run took it. */
type WorkflowStepAnswer = (
  nodeId: CommandCenterWorkflowNode["id"],
  answer: { readonly answer?: string; readonly approved?: boolean },
) => Promise<boolean>;

/** Opens a step's thread, or its changes in the thread's diff panel. */
function StepThreadActions({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const shell = useThreadShell(threadRef);
  const open = (diff: boolean) => {
    if (diff) {
      const latestRun = shell?.latestRun ?? null;
      // In its own worktree everything since the base is the step's work; in a shared checkout
      // only its latest turn is.
      if ((shell?.worktreePath ?? null) === null && latestRun !== null) {
        useDiffPanelStore.getState().selectTurn(threadRef, latestRun.runId);
      } else {
        useDiffPanelStore.getState().selectGitScope(threadRef, "branch");
      }
      useRightPanelStore.getState().open(threadRef, "diff");
    }
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  };
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => open(false)}>
        <ExternalLinkIcon />
        Open thread
      </Button>
      <Button size="xs" variant="outline" disabled={shell === null} onClick={() => open(true)}>
        <FileDiffIcon />
        View changes
      </Button>
    </>
  );
}

/** A waiting ask (its choices, or a free answer) or manual gate (approve or reject). */
function StepAnswer({
  node,
  disabled,
  onAnswer,
}: {
  readonly node: CommandCenterWorkflowNode;
  readonly disabled: boolean;
  readonly onAnswer: WorkflowStepAnswer;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  if (node.kind !== "ask" && !(node.kind === "gate" && node.check === "manual")) return null;
  const question = node.kind === "ask" ? node.question : "Approve this step to continue the run.";
  const send = async (answer: { readonly answer?: string; readonly approved?: boolean }) => {
    setSending(true);
    const done = await onAnswer(node.id, answer);
    setSending(false);
    if (done) setText("");
  };
  const off = disabled || sending;
  const choices = node.kind === "ask" ? (node.choices ?? []) : [];
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">{question}</p>
      {choices.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {choices.map((choice, index) => (
            <Button
              key={choice}
              size="xs"
              variant={index === 0 ? "default" : "outline"}
              disabled={off}
              onClick={() => void send({ answer: choice })}
            >
              {choice}
            </Button>
          ))}
        </div>
      ) : (
        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (node.kind === "ask" ? text.trim() !== "" : true) {
              void send(node.kind === "ask" ? { answer: text } : { approved: true, answer: text });
            }
          }}
        >
          <Input
            size="sm"
            aria-label={node.kind === "ask" ? "Your answer" : "Note (optional)"}
            placeholder={node.kind === "ask" ? "Your answer" : "Note (optional)"}
            value={text}
            disabled={off}
            onChange={(event) => setText(event.target.value)}
          />
          {node.kind === "ask" ? (
            <Button size="sm" type="submit" disabled={off || text.trim() === ""}>
              Answer
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                type="button"
                variant="outline"
                disabled={off}
                onClick={() => void send({ approved: false, answer: text })}
              >
                Reject
              </Button>
              <Button size="sm" type="submit" disabled={off}>
                Approve
              </Button>
            </>
          )}
        </form>
      )}
    </div>
  );
}
