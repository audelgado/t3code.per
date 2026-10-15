import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  type CommandCenterSettings,
  type QuickAction,
  quickActionError,
  resolveCommandCenterSections,
} from "./customization";
import type { CommandCenterTab } from "./tabs";

/** Pinned projects the palette lists, like Home's Pinned block. */
export const PALETTE_PINNED_LIMIT = 8;

interface EntryBase {
  readonly value: string;
  readonly title: string;
  readonly searchTerms: ReadonlyArray<string>;
}

export type CommandCenterPaletteEntry = EntryBase &
  (
    | {
        readonly kind: "tab";
        readonly tab: CommandCenterTab;
        /** The first visible tab, where `commandCenter.open` lands. */
        readonly isDefault: boolean;
      }
    | { readonly kind: "quickAction"; readonly action: QuickAction }
    | { readonly kind: "project"; readonly projectId: ProjectId }
    | { readonly kind: "tidy" }
    | {
        readonly kind: "newWork";
        readonly projectId: ProjectId;
        readonly environmentId: EnvironmentId;
      }
  );

/**
 * Command palette entries for the Command Center: one per visible tab, per valid quick action and
 * per pinned project (at most `PALETTE_PINNED_LIMIT`, in pin order). Only reads settings and the
 * project list the client already has.
 */
export function commandCenterPaletteEntries({
  settings,
  projects,
  focusProjectId = null,
}: {
  readonly settings: Pick<CommandCenterSettings, "sections" | "quickActions" | "projects">;
  readonly focusProjectId?: ProjectId | null;
  readonly projects: ReadonlyArray<
    Pick<EnvironmentProject, "environmentId" | "id" | "title" | "workspaceRoot">
  >;
}): CommandCenterPaletteEntry[] {
  const tabs = resolveCommandCenterSections(settings.sections)
    .filter((section) => section.visible)
    .map((section, index): CommandCenterPaletteEntry => ({
      kind: "tab",
      value: `action:command-center:tab:${section.id}`,
      title: `Command Center: ${section.label}`,
      searchTerms: [
        "command center",
        section.label,
        section.id,
        ...(index === 0 ? ["open command center"] : []),
      ],
      tab: section.id,
      isDefault: index === 0,
    }));
  const actions = settings.quickActions.flatMap((action): CommandCenterPaletteEntry[] =>
    quickActionError(action) === null
      ? [
          {
            kind: "quickAction",
            value: `action:command-center:quick-action:${action.id}`,
            title: `Launch: ${action.label}`,
            searchTerms: ["command center", "quick action", "launch", action.label],
            action,
          },
        ]
      : [],
  );
  // Same key as Projects' pins (`projectEntryKey`): one entry per T3 project.
  const byKey = new Map(
    projects.map(
      (project) =>
        [scopedProjectKey(scopeProjectRef(project.environmentId, project.id)), project] as const,
    ),
  );
  const pinned = settings.projects
    .flatMap((entry): CommandCenterPaletteEntry[] => {
      const project = entry.pinned ? byKey.get(entry.key) : undefined;
      return project
        ? [
            {
              kind: "project",
              value: `action:command-center:project:${entry.key}`,
              title: `${project.title} in Command Center`,
              searchTerms: ["command center", "pinned", project.title, project.workspaceRoot],
              projectId: project.id,
            },
          ]
        : [];
    })
    .slice(0, PALETTE_PINNED_LIMIT);
  const focused = projects.find((project) => project.id === focusProjectId);
  const builtins: CommandCenterPaletteEntry[] = [
    {
      kind: "tidy",
      value: "action:command-center:tidy",
      title: "Command Center: Tidy branches",
      searchTerms: ["command center", "tidy", "branches", "cleanup"],
    },
    ...(focused
      ? [
          {
            kind: "newWork" as const,
            value: "action:command-center:new-work",
            title: `New work in ${focused.title}`,
            searchTerms: ["command center", "new work", "worktree", focused.title],
            projectId: focused.id,
            environmentId: focused.environmentId,
          },
        ]
      : []),
  ];
  return [...tabs, ...builtins, ...actions, ...pinned];
}
