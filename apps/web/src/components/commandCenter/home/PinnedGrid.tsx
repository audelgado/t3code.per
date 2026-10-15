import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { ProjectId } from "@t3tools/contracts";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Empty, EmptyDescription } from "../../ui/empty";
import { Kbd } from "../../ui/kbd";
import { StatusDot } from "../StatusDot";
import { projectEntryKey } from "../projects/projectDirectory";
import { useCommandCenterEnvironments } from "../shared";
import type { WorkItem } from "../work/workItems";
import { completedBuckets } from "./homeLogic";
import { Sparkline } from "./MiniCharts";

export function PinnedGrid({
  projects,
  shells,
  items,
  now,
  onOpen,
}: {
  readonly projects: readonly EnvironmentProject[];
  readonly shells: readonly EnvironmentThreadShell[];
  readonly items: readonly WorkItem[];
  readonly now: number;
  readonly onOpen: (id: ProjectId) => void;
}) {
  const environments = useCommandCenterEnvironments();
  if (!projects.length)
    return (
      <Empty>
        <EmptyDescription>Pin projects from Projects</EmptyDescription>
      </Empty>
    );
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {projects.map((project, index) => {
        const ownShells = shells.filter(
          (shell) =>
            shell.environmentId === project.environmentId && shell.projectId === project.id,
        );
        const latest = ownShells
          .filter((shell) => shell.archivedAt === null && shell.deletedAt === null)
          .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        const attention =
          latest &&
          (latest.hasPendingApprovals ||
            latest.hasPendingUserInput ||
            (latest.interactionMode === "plan" &&
              latest.hasActionableProposedPlan &&
              !threadRuntimeIsActive(latest.runtime)));
        const active = threadRuntimeIsActive(latest?.runtime);
        const count = items.filter((item) => item.projectKey === projectEntryKey(project)).length;
        return (
          <button
            key={projectEntryKey(project)}
            type="button"
            onClick={() => onOpen(project.id)}
            className="flex min-w-0 flex-col gap-3 rounded-lg border border-border/60 bg-card/40 p-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span
                aria-hidden="true"
                className="flex size-8 items-center justify-center rounded-md bg-muted text-sm font-medium"
              >
                {project.title.slice(0, 2).toUpperCase()}
              </span>
              <Kbd>{index + 1}</Kbd>
            </span>
            <span className="w-full truncate text-sm font-medium">{project.title}</span>
            <span className="flex w-full flex-wrap items-center justify-between gap-1">
              <StatusDot
                tone={attention ? "warning" : active ? "success" : "muted"}
                label={attention ? "Needs you" : active ? "Working" : "Idle"}
              />
              <span className="text-xs text-muted-foreground">
                {latest ? formatRelativeTimeLabel(latest.updatedAt) : "No threads"}
              </span>
            </span>
            <span className="flex w-full flex-wrap items-center justify-between gap-1">
              <Sparkline values={completedBuckets(ownShells, now)} />
              <span className="text-xs text-muted-foreground">
                {count} {count === 1 ? "branch" : "branches"}
              </span>
            </span>
            <span className="w-full truncate text-xs text-muted-foreground">
              {environments.find(
                (environment) => environment.environmentId === project.environmentId,
              )?.label ?? "Machine unavailable"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
