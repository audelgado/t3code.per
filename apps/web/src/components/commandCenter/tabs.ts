// Kept free of imports: the route's `validateSearch` loads eagerly, and anything it imports
// lands in the startup bundle instead of the code-split Command Center chunk.

export const COMMAND_CENTER_TABS = [
  { value: "home", label: "Home" },
  { value: "work", label: "Work" },
  { value: "team", label: "Team" },
  { value: "projects", label: "Projects" },
  { value: "infra", label: "Infra" },
  { value: "finance", label: "Finance" },
  { value: "artifacts", label: "Artifacts" },
  { value: "canvas", label: "Canvas" },
  { value: "workflows", label: "Workflows" },
] as const;
export type CommandCenterTab = (typeof COMMAND_CENTER_TABS)[number]["value"];

export interface CommandCenterSearch {
  readonly tab?: CommandCenterTab;
  /** Artifact open in the Artifacts tab's viewer, so other views can link straight to it. */
  readonly artifact?: string;
  /** The project focus every tab follows; in Projects it is the open detail. */
  readonly project?: string;
  /** Workflows: the open run of the focused project. */
  readonly run?: string;
  /** Text to add to Ask the team once (a prompt quick action from the command palette). */
  readonly ask?: string;
}

const searchText = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** `/command` search params: unknown tabs drop, `artifact` and `run` only where they apply. */
export function parseCommandCenterSearch(raw: Record<string, unknown>): CommandCenterSearch {
  const tab = COMMAND_CENTER_TABS.find((option) => option.value === raw.tab)?.value;
  const artifact = tab === "artifacts" ? searchText(raw.artifact) : undefined;
  const project = searchText(raw.project);
  const run = tab === "workflows" && project !== undefined ? searchText(raw.run) : undefined;
  const ask = searchText(raw.ask);
  return {
    ...(tab ? { tab } : {}),
    ...(artifact === undefined ? {} : { artifact }),
    ...(project === undefined ? {} : { project }),
    ...(run === undefined ? {} : { run }),
    ...(ask === undefined ? {} : { ask }),
  };
}
