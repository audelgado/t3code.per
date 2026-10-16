export const navigationGroups = [
  { label: "Workspace", items: [
    { route: "home", label: "Home", description: "What needs your attention across your workspace." },
    { route: "ask", label: "Ask", description: "Start a conversation or delegate work to an agent." },
    { route: "queue", label: "Queue", description: "Review approvals and manage pending tasks." },
    { route: "work", label: "Work", description: "Follow work across projects and machines." },
    { route: "projects", label: "Projects", description: "Find a project and continue working." },
    { route: "workflows", label: "Workflows", description: "Manage repeatable work and inspect runs." },
    { route: "memory", label: "Memory", description: "Search and manage saved knowledge." },
    { route: "artifacts", label: "Artifacts", description: "Browse the outputs of your work." },
    { route: "sections", label: "Sections", description: "Organize project context into sections." },
  ] },
  { label: "Business", items: [
    { route: "finance", label: "Finance", description: "Track income, costs, and budgets." },
  ] },
  { label: "System", items: [
    { route: "profiles", label: "Profiles", description: "Manage agent profiles and defaults." },
    { route: "infra", label: "Infra", description: "Inspect your infrastructure." },
    { route: "machines", label: "Machines", description: "Manage connected machines." },
    { route: "agents", label: "Agents", description: "Inspect available agents." },
    { route: "notifications", label: "Notifications", description: "Manage notifications for this device." },
    { route: "orca", label: "Orca", description: "Manage Orca terminals." },
  ] },
] as const;

export type NavigationRoute = (typeof navigationGroups)[number]["items"][number]["route"];
export const primaryNavigationRoutes = ["home", "ask", "queue", "work"] as const;
export type SecondaryNavigationRoute = Exclude<NavigationRoute, (typeof primaryNavigationRoutes)[number]>;

export function visibleNavigation(orca: boolean, surface: "all" | "desktop" | "more" = "all") {
  return navigationGroups.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      (orca || item.route !== "orca") &&
      (surface !== "desktop" || item.route !== "ask") &&
      (surface !== "more" || !primaryNavigationRoutes.some((route) => route === item.route)),
    ),
  })).filter((group) => group.items.length > 0);
}

export const navigationKeys = { h: "home", a: "ask", q: "queue", w: "work", p: "projects", m: "memory", f: "finance" } as const;

interface ShortcutContext {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  editable?: boolean;
  dialogOpen?: boolean;
  defaultPrevented?: boolean;
}

export type ShortcutAction = { type: "navigate"; route: string } | { type: "search" | "help" };

/** A short g-prefix sequence; interrupted or blocked input always clears it. */
export function resolveShortcut(event: ShortcutContext, prefixAt: number | null, now: number): { prefixAt: number | null; action?: ShortcutAction } {
  const clear = { prefixAt: null };
  if (event.defaultPrevented || event.editable || event.dialogOpen || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && event.key !== "?" && event.key !== "/")) return clear;
  if (event.key === "?") return { ...clear, action: { type: "help" } };
  if (event.key === "/") return { ...clear, action: { type: "search" } };
  if (prefixAt !== null && now >= prefixAt && now - prefixAt <= 1500 && Object.hasOwn(navigationKeys, event.key)) {
    return { ...clear, action: { type: "navigate", route: navigationKeys[event.key as keyof typeof navigationKeys] } };
  }
  return { prefixAt: event.key === "g" ? now : null };
}

/** Walk ancestors so nested rich text and controls inside buttons keep their keys. */
export function isShortcutEditing(target: { closest: (selector: string) => unknown } | null) {
  return !!target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]');
}
