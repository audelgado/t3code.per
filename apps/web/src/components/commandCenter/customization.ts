import type { ServerSettings } from "@t3tools/contracts";
import type { useNavigate } from "@tanstack/react-router";
import {
  FilesIcon,
  FolderKanbanIcon,
  GitBranchIcon,
  HouseIcon,
  LayoutDashboardIcon,
  NetworkIcon,
  UsersIcon,
  WalletIcon,
  WorkflowIcon,
} from "lucide-react";

import { readLocalApi } from "~/localApi";
import { toastManager } from "../ui/toast";
import { COMMAND_CENTER_TABS } from "./tabs";

export type CommandCenterSettings = ServerSettings["commandCenter"];
export type QuickAction = CommandCenterSettings["quickActions"][number];

// Section icons and descriptions, and link quick actions, live here rather than in the
// components: the command palette (in the startup bundle) needs them without the page's UI.

/** Each tab's icon and tooltip description, for the section strip and the command palette. */
export const COMMAND_CENTER_SECTION_INFO = {
  home: {
    icon: HouseIcon,
    description: "What needs you, your pinned projects, open todos and quick actions.",
  },
  work: {
    icon: GitBranchIcon,
    description:
      "Rotate active branches, see each one's progress, and tidy merged or stale branches.",
  },
  team: {
    icon: UsersIcon,
    description: "See who is working on each machine, their teams and handoffs.",
  },
  projects: {
    icon: FolderKanbanIcon,
    description: "Find a project, review its progress and open the work that matters.",
  },
  infra: {
    icon: NetworkIcon,
    description: "Check your machines, connections and the projects running on each.",
  },
  finance: {
    icon: WalletIcon,
    description: "Review income, recurring costs and the projects behind the numbers.",
  },
  artifacts: {
    icon: FilesIcon,
    description: "Find shared deliverables, review their versions and send them to an agent.",
  },
  canvas: {
    icon: LayoutDashboardIcon,
    description: "Organize a project's sections, notes and artifacts on one board.",
  },
  workflows: {
    icon: WorkflowIcon,
    description: "Choose a reusable workflow and follow its runs, questions and checks.",
  },
} as const;

/**
 * Stored order wins. A tab missing from older settings (such as Home) is inserted right after
 * its canonical predecessor, or first when it has none, so new tabs land where they belong.
 */
export function resolveCommandCenterSections(sections: CommandCenterSettings["sections"]) {
  const seen = new Set<string>();
  const resolved = sections.flatMap((section) => {
    const base = COMMAND_CENTER_TABS.find((tab) => tab.value === section.id);
    if (!base || seen.has(section.id)) return [];
    seen.add(section.id);
    return [{ ...section, label: section.label.trim() || base.label }];
  });
  COMMAND_CENTER_TABS.forEach((tab, index) => {
    if (seen.has(tab.value)) return;
    const previous = COMMAND_CENTER_TABS[index - 1]?.value;
    const at = resolved.findIndex((section) => section.id === previous) + 1;
    resolved.splice(at, 0, { id: tab.value, label: tab.label, visible: true });
  });
  // A stale or manually edited configuration must never leave navigation empty.
  if (!resolved.some((section) => section.visible)) resolved[0]!.visible = true;
  return resolved;
}

export function quickActionError(action: Pick<QuickAction, "label" | "kind" | "target">) {
  if (!action.label.trim()) return "Enter a name for this action.";
  if (!action.target.trim()) return "Enter a destination or instruction.";
  if (
    action.kind === "section" &&
    !COMMAND_CENTER_TABS.some((tab) => tab.value === action.target)
  ) {
    return "Choose an existing tab.";
  }
  if (action.kind === "link" && !isHttpUrl(action.target) && !isAppPath(action.target)) {
    return "Enter a complete http:// or https:// link, or an app path such as /usage.";
  }
  return null;
}

/**
 * A path inside T3 Code (`/usage`, `/command?tab=finance`) that a link quick action opens with the
 * router. One leading slash only: `//host` and `/\host` would leave the app.
 */
export function isAppPath(target: string) {
  return /^\/(?![/\\])\S*$/.test(target.trim());
}

/** Quick action and project links: a complete http(s) address with a host, as settings accept. */
export function isHttpUrl(target: string) {
  const value = target.trim();
  if (!/^https?:\/\/[^\s/?#]\S*$/i.test(value)) return false;
  try {
    return new URL(value).hostname !== "";
  } catch {
    return false;
  }
}

/**
 * Opens a link quick action: an app path (`/usage`) in this window through the router, an
 * http(s) link in the system browser on desktop or a new tab on the web.
 */
export async function openQuickActionLink(
  target: string,
  navigate: ReturnType<typeof useNavigate>,
) {
  try {
    if (isAppPath(target)) {
      await navigate({ href: target.trim() });
      return;
    }
    const api = readLocalApi();
    if (api) await api.shell.openExternal(target);
    else window.open(target, "_blank", "noopener,noreferrer");
  } catch {
    toastManager.add({ type: "error", title: "Could not open quick action link" });
  }
}
