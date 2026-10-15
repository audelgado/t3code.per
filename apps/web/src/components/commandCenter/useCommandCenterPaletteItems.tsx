import { useMatch, useNavigate } from "@tanstack/react-router";
import { PinIcon, RocketIcon } from "lucide-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";

import { usePrimarySettings } from "~/hooks/useSettings";
import { useProjects } from "~/state/entities";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../CommandPalette.logic";
import { COMMAND_CENTER_SECTION_INFO, openQuickActionLink } from "./customization";
import { commandCenterPaletteEntries } from "./paletteItems";
import { COMMAND_CENTER_TABS } from "./tabs";

/**
 * The Command Center's command palette actions: its visible tabs (the default one carries the
 * `commandCenter.open` shortcut), quick actions and pinned projects. Empty while it is off.
 */
export function useCommandCenterPaletteItems(): CommandPaletteActionItem[] {
  const settings = usePrimarySettings((current) => current.commandCenter);
  const projects = useProjects();
  const navigate = useNavigate();
  const newThread = useNewThreadHandler();
  // On the Command Center its project focus (and, for a prompt, its tab) carries over, as with
  // the in-page controls.
  const current = useMatch({
    from: "/_chat/command",
    shouldThrow: false,
    select: (match) => match.search,
  });
  const focus = current?.project === undefined ? {} : { project: current.project };
  if (!settings.enabled) return [];
  return commandCenterPaletteEntries({
    settings,
    projects,
    focusProjectId: projects.find((project) => project.id === current?.project)?.id ?? null,
  }).map((entry) => {
    const base = { kind: "action" as const, value: entry.value, title: entry.title };
    const searchTerms = [...entry.searchTerms];
    switch (entry.kind) {
      case "tidy":
        return {
          ...base,
          searchTerms,
          icon: <RocketIcon className={ITEM_ICON_CLASS} />,
          run: async () => {
            await navigate({ to: "/command", search: { tab: "work", ...focus } });
          },
        };
      case "newWork":
        return {
          ...base,
          searchTerms,
          icon: <RocketIcon className={ITEM_ICON_CLASS} />,
          run: async () => {
            await newThread(scopeProjectRef(entry.environmentId, entry.projectId), {
              envMode: "worktree",
            });
          },
        };
      case "tab": {
        const Icon = COMMAND_CENTER_SECTION_INFO[entry.tab].icon;
        return {
          ...base,
          searchTerms,
          icon: <Icon className={ITEM_ICON_CLASS} />,
          ...(entry.isDefault ? { shortcutCommand: "commandCenter.open" as const } : {}),
          run: async () => {
            await navigate({ to: "/command", search: { tab: entry.tab, ...focus } });
          },
        };
      }
      case "project":
        return {
          ...base,
          searchTerms,
          icon: <PinIcon className={ITEM_ICON_CLASS} />,
          run: async () => {
            await navigate({
              to: "/command",
              search: { tab: "projects", project: entry.projectId },
            });
          },
        };
      case "quickAction": {
        const { kind, target } = entry.action;
        return {
          ...base,
          searchTerms,
          icon: <RocketIcon className={ITEM_ICON_CLASS} />,
          run: async () => {
            if (kind === "link") await openQuickActionLink(target, navigate);
            // A prompt waits in Ask the team for review, like the Launch menu.
            else if (kind === "prompt") {
              const tab = current?.tab === undefined ? {} : { tab: current.tab };
              await navigate({ to: "/command", search: { ...tab, ...focus, ask: target } });
            } else {
              const tab = COMMAND_CENTER_TABS.find((item) => item.value === target)?.value;
              await navigate({ to: "/command", search: tab ? { tab, ...focus } : focus });
            }
          },
        };
      }
    }
  });
}
