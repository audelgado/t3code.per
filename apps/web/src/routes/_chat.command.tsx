import { CommandCenterWorkflowRunId, ProjectId } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { CommandCenterPage } from "../components/commandCenter/CommandCenterPage";
import { parseCommandCenterSearch } from "../components/commandCenter/tabs";
import { resolveCommandCenterSections } from "../components/commandCenter/customization";
import { usePrimarySettings } from "../hooks/useSettings";

export const Route = createFileRoute("/_chat/command")({
  validateSearch: parseCommandCenterSearch,
  component: CommandCenterRouteView,
});

function CommandCenterRouteView() {
  const search = Route.useSearch();
  const sections = usePrimarySettings((settings) => settings.commandCenter.sections);
  const defaultTab = resolveCommandCenterSections(sections).find((section) => section.visible)!.id;
  const navigate = useNavigate({ from: Route.fullPath });
  // The focus travels with every tab change; a run or artifact belongs to the view it was opened in.
  const focus = search.project === undefined ? {} : { project: search.project };
  return (
    <CommandCenterPage
      tab={search.tab ?? defaultTab}
      onTabChange={(tab) => void navigate({ search: { tab, ...focus } })}
      projectId={search.project === undefined ? null : ProjectId.make(search.project)}
      onProjectChange={(project) =>
        void navigate({
          search: ({ run: _run, project: _project, ...rest }) =>
            project === null ? rest : { ...rest, project },
          replace: true,
        })
      }
      artifactId={search.artifact ?? null}
      onArtifactChange={(artifact) =>
        void navigate({
          search: { tab: "artifacts", ...focus, ...(artifact === null ? {} : { artifact }) },
          replace: true,
        })
      }
      workflowRunId={search.run === undefined ? null : CommandCenterWorkflowRunId.make(search.run)}
      onOpenWorkflowRun={(project, run) =>
        void navigate({ search: { tab: "workflows", project, run } })
      }
      onCloseWorkflowRun={() =>
        void navigate({ search: ({ run: _run, ...rest }) => rest, replace: true })
      }
      ask={search.ask ?? null}
      onAskHandled={() =>
        void navigate({ search: ({ ask: _ask, ...rest }) => rest, replace: true })
      }
    />
  );
}
