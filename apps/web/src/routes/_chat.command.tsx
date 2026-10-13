import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { CommandCenterPage } from "../components/commandCenter/CommandCenterPage";
import { COMMAND_CENTER_TABS, type CommandCenterTab } from "../components/commandCenter/tabs";

export interface CommandCenterSearch {
  readonly tab?: CommandCenterTab;
}

export const Route = createFileRoute("/_chat/command")({
  validateSearch: (raw: Record<string, unknown>): CommandCenterSearch => {
    const tab = COMMAND_CENTER_TABS.find((option) => option.value === raw.tab);
    // Team is the default, so it stays out of the URL.
    return tab && tab.value !== "team" ? { tab: tab.value } : {};
  },
  component: CommandCenterRouteView,
});

function CommandCenterRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <CommandCenterPage
      tab={search.tab ?? "team"}
      onTabChange={(tab) => void navigate({ search: tab === "team" ? {} : { tab }, replace: true })}
    />
  );
}
