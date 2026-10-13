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
import { useCommandCenter } from "../shared";
import { RunWorkflowDialog } from "./RunWorkflowDialog";
import { useWorkflowCommands } from "./useWorkflowCommands";
import { WorkflowEditor } from "./WorkflowEditor";
import { WorkflowLibrary } from "./WorkflowLibrary";
import { WorkflowRunView } from "./WorkflowRunView";

type View =
  | { readonly type: "library" }
  | { readonly type: "editor"; readonly slug: CommandCenterWorkflowSlug }
  | { readonly type: "run"; readonly runId: CommandCenterWorkflowRunId };

type RunTarget = Pick<CommandCenterWorkflow, "slug" | "title" | "inputs">;

/** The last non-null value, so a paused or reconnecting feed keeps its rows on screen. */
function useKept<T>(value: T | null): T | null {
  const [kept, setKept] = useState(value);
  if (value !== null && value !== kept) setKept(value);
  return value ?? kept;
}

/**
 * Workflows (docs/command-center/WORKFLOWS.md): each project's `.t3/workflows` files, edited on a
 * canvas and run as agent threads. One project at a time, picked with the page's project filter.
 */
export function WorkflowsTab({
  runLink,
}: {
  /** A run to open first (a link from a Started toast), when it is in the picked project. */
  readonly runLink: {
    readonly projectId: ProjectId;
    readonly runId: CommandCenterWorkflowRunId;
  } | null;
}) {
  const { projectId, projects } = useCommandCenter();
  const project = projects.find((candidate) => candidate.id === projectId);
  if (projectId === null || !project) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Pick a project above to see its workflows. They are saved in the project under
        .t3/workflows.
      </p>
    );
  }
  const linkedRunId = runLink?.projectId === project.id ? runLink.runId : null;
  // Keyed so an open editor or run never carries over to another project, and a new link opens.
  return (
    <ProjectWorkflows
      key={`${project.environmentId}:${project.id}:${linkedRunId ?? ""}`}
      project={project}
      initialRunId={linkedRunId}
    />
  );
}

function ProjectWorkflows({
  project,
  initialRunId,
}: {
  readonly project: EnvironmentProject;
  readonly initialRunId: CommandCenterWorkflowRunId | null;
}) {
  const environmentId = project.environmentId;
  const projectId = project.id;
  const commands = useWorkflowCommands(environmentId, projectId);
  const [view, setView] = useState<View>(
    initialRunId === null ? { type: "library" } : { type: "run", runId: initialRunId },
  );
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
    const run = result.value;
    setView({ type: "run", runId: run.id });
    toastManager.add({ type: "success", title: `Started ${target.title}` });
    return true;
  };

  return (
    <>
      {view.type === "editor" ? (
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
      ) : view.type === "run" ? (
        <WorkflowRunView
          key={view.runId}
          environmentId={environmentId}
          runId={view.runId}
          live={runs}
          commands={commands}
          isSaved={(slug) =>
            list === null || list.workflows.some((workflow) => workflow.slug === slug)
          }
          onBack={() => setView({ type: "library" })}
          onEdit={(slug) => setView({ type: "editor", slug })}
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
          onOpenRun={(runId) => setView({ type: "run", runId })}
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
