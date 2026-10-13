import { CommandCenterWorkflowRunId, ProjectId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { CommandCenterPage } from "../components/commandCenter/CommandCenterPage";
import { COMMAND_CENTER_TABS, type CommandCenterTab } from "../components/commandCenter/tabs";

export interface CommandCenterSearch {
  readonly tab?: CommandCenterTab;
  /** Artifact open in the Artifacts tab's viewer, so other views can link straight to it. */
  readonly artifact?: string;
  /** A run to open in the Workflows tab, with the project it belongs to. */
  readonly project?: string;
  readonly run?: string;
}

const searchText = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

export const Route = createFileRoute("/_chat/command")({
  validateSearch: (raw: Record<string, unknown>): CommandCenterSearch => {
    const tab = COMMAND_CENTER_TABS.find((option) => option.value === raw.tab);
    const artifact = tab?.value === "artifacts" ? searchText(raw.artifact) : undefined;
    const project = tab?.value === "workflows" ? searchText(raw.project) : undefined;
    const run = project === undefined ? undefined : searchText(raw.run);
    // Team is the default, so it stays out of the URL.
    return {
      ...(tab && tab.value !== "team" ? { tab: tab.value } : {}),
      ...(artifact === undefined ? {} : { artifact }),
      ...(project === undefined || run === undefined ? {} : { project, run }),
    };
  },
  component: CommandCenterRouteView,
});

function CommandCenterRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const workflowRun = useMemo(
    () =>
      search.project === undefined || search.run === undefined
        ? null
        : {
            projectId: ProjectId.make(search.project),
            runId: CommandCenterWorkflowRunId.make(search.run),
          },
    [search.project, search.run],
  );
  return (
    <CommandCenterPage
      tab={search.tab ?? "team"}
      onTabChange={(tab) => void navigate({ search: tab === "team" ? {} : { tab }, replace: true })}
      artifactId={search.artifact ?? null}
      workflowRun={workflowRun}
      onArtifactChange={(artifact) =>
        void navigate({
          search: artifact === null ? { tab: "artifacts" } : { tab: "artifacts", artifact },
          replace: true,
        })
      }
    />
  );
}
