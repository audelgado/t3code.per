import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  CommandCenterWorkflow,
  CommandCenterWorkflowRunId,
  CommandCenterWorkflowSlug,
  ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { toastManager } from "../../ui/toast";
import { useDocumentVisible } from "../infra/useDocumentVisible";
import { FocusPrompt, ProjectPicker } from "../ProjectPicker";
import { useCommandCenter } from "../shared";
import { RunWorkflowDialog } from "./RunWorkflowDialog";
import { useWorkflowCommands } from "./useWorkflowCommands";
import { WorkflowEditor } from "./WorkflowEditor";
import { WorkflowLibrary } from "./WorkflowLibrary";
import { WorkflowRunList } from "./WorkflowRunList";
import { WorkflowRunView } from "./WorkflowRunView";

type View =
  | { readonly type: "library" }
  | { readonly type: "editor"; readonly slug: CommandCenterWorkflowSlug };

type RunTarget = Pick<CommandCenterWorkflow, "slug" | "title" | "inputs">;

/** The last non-null value, so a paused or reconnecting feed keeps its rows on screen. */
function useKept<T>(value: T | null): T | null {
  const [kept, setKept] = useState(value);
  if (value !== null && value !== kept) setKept(value);
  return value ?? kept;
}

/**
 * Workflows (docs/command-center/WORKFLOWS.md): each project's `.t3/workflows` files, edited on a
 * canvas and run as agent threads. With a project focus, that project's library; without one,
 * the runs of every project on the primary server, so a waiting run is never out of sight.
 */
export function WorkflowsTab({
  runId,
  onOpenRun,
  onCloseRun,
}: {
  /** The open run of the focused project (`?run=`), so it survives reloads and links. */
  readonly runId: CommandCenterWorkflowRunId | null;
  /** Focuses a run's project and opens the run. */
  readonly onOpenRun: (projectId: ProjectId, runId: CommandCenterWorkflowRunId) => void;
  readonly onCloseRun: () => void;
}) {
  const { projectId, projects } = useCommandCenter();
  const project = projects.find((candidate) => candidate.id === projectId);
  if (projectId === null) return <AllRuns onOpenRun={onOpenRun} />;
  if (!project) {
    if (runId !== null) return <UnlistedProjectRun projectId={projectId} runId={runId} />;
    return (
      <FocusPrompt text="This project is not available. It was removed or its machine is offline." />
    );
  }
  // Keyed so an open editor never carries over to another project.
  return (
    <ProjectWorkflows
      key={`${project.environmentId}:${project.id}`}
      project={project}
      runId={runId}
      onOpenRun={(id) => onOpenRun(project.id, id)}
      onCloseRun={onCloseRun}
    />
  );
}

/**
 * A run whose project is not listed here (removed, or kept from a machine that is offline). The
 * runs on Home and in every project's runs come from the primary server, so the run opens there
 * by id, without a library to go back to: Back clears the focus, landing on every project's runs.
 */
function UnlistedProjectRun({
  projectId,
  runId,
}: {
  readonly projectId: ProjectId;
  readonly runId: CommandCenterWorkflowRunId;
}) {
  const { primaryEnvironmentId, setProjectFocus } = useCommandCenter();
  const commands = useWorkflowCommands(primaryEnvironmentId, projectId);
  const visible = useDocumentVisible();
  const runs = useKept(
    useEnvironmentQuery(
      visible
        ? serverEnvironment.commandCenterWorkflowRunsLive({
            environmentId: primaryEnvironmentId,
            input: { projectId },
          })
        : null,
    ).data,
  );
  return (
    <WorkflowRunView
      key={runId}
      environmentId={primaryEnvironmentId}
      runId={runId}
      live={runs}
      commands={commands}
      isSaved={() => false}
      onBack={() => setProjectFocus(null)}
      onEdit={() => undefined}
    />
  );
}

/** Every project's runs from the primary server's feed, which ends while the window is hidden. */
function AllRuns({
  onOpenRun,
}: {
  readonly onOpenRun: (projectId: ProjectId, runId: CommandCenterWorkflowRunId) => void;
}) {
  const { primaryEnvironmentId, projects, setProjectFocus } = useCommandCenter();
  const visible = useDocumentVisible();
  const runs = useKept(
    useEnvironmentQuery(
      visible
        ? serverEnvironment.commandCenterWorkflowRunsLive({
            environmentId: primaryEnvironmentId,
            input: {},
          })
        : null,
    ).data,
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          Runs in every project. Choose a project to open its workflow library.
        </p>
        <ProjectPicker
          projects={projects}
          value={null}
          onValueChange={setProjectFocus}
          allowEmpty={false}
          placeholder="Choose a project"
          ariaLabel="Project focus"
        />
      </div>
      <section className="flex flex-col gap-2" aria-label="Runs in every project">
        <h2 className="text-sm font-medium">Runs</h2>
        <WorkflowRunList
          environmentId={primaryEnvironmentId}
          live={runs}
          projectTitle={(id) =>
            projects.find((project) => project.id === id)?.title ?? "Unknown project"
          }
          onOpenRun={(run) => onOpenRun(run.projectId, run.id)}
        />
      </section>
    </div>
  );
}

/** One project's library and editor (local state) and its open run (from the URL). */
function ProjectWorkflows({
  project,
  runId,
  onOpenRun,
  onCloseRun,
}: {
  readonly project: EnvironmentProject;
  readonly runId: CommandCenterWorkflowRunId | null;
  readonly onOpenRun: (runId: CommandCenterWorkflowRunId) => void;
  readonly onCloseRun: () => void;
}) {
  const environmentId = project.environmentId;
  const projectId = project.id;
  const commands = useWorkflowCommands(environmentId, projectId);
  const [view, setView] = useState<View>({ type: "library" });
  const [running, setRunning] = useState<RunTarget | null>(null);
  // Both feeds end while the window is hidden (the server stops watching the folder), and
  // resubscribe with a fresh snapshot when it shows again.
  const visible = useDocumentVisible();
  const listQuery = useEnvironmentQuery(
    visible
      ? serverEnvironment.commandCenterWorkflowsLive({ environmentId, input: { projectId } })
      : null,
  );
  const runsQuery = useEnvironmentQuery(
    visible
      ? serverEnvironment.commandCenterWorkflowRunsLive({ environmentId, input: { projectId } })
      : null,
  );
  const list = useKept(listQuery.data);
  const runs = useKept(runsQuery.data);

  const start = async (target: RunTarget, inputs: Record<string, string>) => {
    const result = await commands.start(target.slug, inputs);
    if (result._tag !== "Success") return false;
    onOpenRun(result.value.id);
    toastManager.add({ type: "success", title: `Started ${target.title}` });
    return true;
  };

  return (
    <>
      {runId !== null ? (
        <WorkflowRunView
          key={runId}
          environmentId={environmentId}
          runId={runId}
          live={runs}
          commands={commands}
          isSaved={(slug) =>
            list === null || list.workflows.some((workflow) => workflow.slug === slug)
          }
          onBack={onCloseRun}
          onEdit={(slug) => {
            setView({ type: "editor", slug });
            onCloseRun();
          }}
        />
      ) : view.type === "editor" ? (
        <WorkflowEditor
          key={view.slug}
          environmentId={environmentId}
          projectId={projectId}
          slug={view.slug}
          fileUpdatedAt={
            list === null
              ? undefined
              : (list.workflows.find((workflow) => workflow.slug === view.slug)?.updatedAt ?? null)
          }
          commands={commands}
          onBack={() => setView({ type: "library" })}
          onRun={setRunning}
        />
      ) : (
        <WorkflowLibrary
          environmentId={environmentId}
          projectId={projectId}
          list={list}
          listError={listQuery.error}
          runs={runs}
          commands={commands}
          onOpen={(slug) => setView({ type: "editor", slug })}
          onRun={setRunning}
          onOpenRun={onOpenRun}
        />
      )}
      {running ? (
        <RunWorkflowDialog
          title={running.title}
          inputs={running.inputs}
          onClose={() => setRunning(null)}
          onStart={(inputs) => start(running, inputs)}
        />
      ) : null}
    </>
  );
}
