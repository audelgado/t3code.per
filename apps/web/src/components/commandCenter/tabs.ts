// Kept free of imports: the route's `validateSearch` loads eagerly, and anything it imports
// lands in the startup bundle instead of the code-split Command Center chunk.

export const COMMAND_CENTER_TABS = [
  { value: "team", label: "Team" },
  { value: "projects", label: "Projects" },
  { value: "infra", label: "Infra" },
  { value: "finance", label: "Finance" },
  { value: "artifacts", label: "Artifacts" },
  { value: "canvas", label: "Canvas" },
  { value: "workflows", label: "Workflows" },
] as const;
export type CommandCenterTab = (typeof COMMAND_CENTER_TABS)[number]["value"];
