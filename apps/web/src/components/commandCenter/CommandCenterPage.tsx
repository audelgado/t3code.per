import { useAtomValue } from "@effect/atom-react";
import type { CommandCenterSnapshot, ProjectId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { BrainIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { isElectron } from "~/env";
import { usePrimarySettings } from "~/hooks/useSettings";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { FinanceTab } from "./finance/FinanceTab";
import { InfraTab } from "./infra/InfraTab";
import { parseMemoryCommand } from "./logic";
import { MemoryDrawer } from "./memory/MemoryDrawer";
import { OrchestratorBar } from "./OrchestratorBar";
import { PlanDrawer, type PlanDrawerProps } from "./plan/PlanDrawer";
import { useStartOnboarding } from "./plan/useStartOnboarding";
import { ProjectsTab } from "./projects/ProjectsTab";
import {
  CommandCenterProvider,
  type CommandCenterContextValue,
  type CommandCenterPlanSeed,
  type CommandCenterTarget,
  focusOrchestrator,
  useCommandCenter,
  useCommandCenterCommands,
  useHideAmountsState,
} from "./shared";
import { COMMAND_CENTER_TABS, type CommandCenterTab } from "./tabs";
import { TeamTab } from "./team/TeamTab";

type PlanState = Pick<PlanDrawerProps, "request" | "projectId" | "target" | "seed"> & {
  readonly open: boolean;
  /** Bumped per opening so the drawer starts fresh even for the same request. */
  readonly nonce: number;
};

/** Page-level keys (`/` focuses the orchestrator, `H` hides amounts) never fire while typing. */
function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable ||
      target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]') !== null)
  );
}

function PageShell({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Command Center breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Command Center</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <div className="min-w-0 flex-1" />
          {actions}
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded" className="gap-4">
            {children}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

export function CommandCenterPage({
  tab,
  onTabChange,
}: {
  readonly tab: CommandCenterTab;
  readonly onTabChange: (tab: CommandCenterTab) => void;
}) {
  const primary = usePrimaryEnvironment();
  const primaryEnvironmentId = primary?.environmentId ?? null;
  const connected = primary?.connection.phase === "connected";
  const enabled = usePrimarySettings((settings) => settings.commandCenter.enabled);
  // Not gated on `connected`: the subscription follows the connection and resumes on its own.
  const query = useEnvironmentQuery(
    primaryEnvironmentId !== null && enabled
      ? serverEnvironment.commandCenterLive({ environmentId: primaryEnvironmentId, input: {} })
      : null,
  );
  // The last snapshot stays on screen through a reconnect instead of blanking the page.
  const [kept, setKept] = useState<{
    readonly environmentId: string;
    readonly snapshot: CommandCenterSnapshot;
  } | null>(null);
  if (query.data !== null && primaryEnvironmentId !== null && kept?.snapshot !== query.data) {
    setKept({ environmentId: primaryEnvironmentId, snapshot: query.data });
  }
  const canOperate = useAtomValue(
    serverEnvironment.upsertCommandCenter.permissionAtom(primaryEnvironmentId),
  );
  const allProjects = useProjects();
  const projects = useMemo(() => {
    const seen = new Set<ProjectId>();
    return allProjects.filter((project) => {
      if (project.isScratch || seen.has(project.id)) return false;
      seen.add(project.id);
      return true;
    });
  }, [allProjects]);
  const { hidden, toggle: toggleHidden } = useHideAmountsState();
  const [projectId, setProjectId] = useState<ProjectId | null>(null);

  const [draft, setDraft] = useState("");
  const [draftProjectId, setDraftProjectId] = useState<ProjectId | null>(null);
  // Kept after closing so the drawer keeps its content while it animates out.
  const [plan, setPlan] = useState<PlanState>({
    open: false,
    nonce: 0,
    request: "",
    projectId: null,
    target: "auto",
  });
  const openPlan = useCallback((seed: CommandCenterPlanSeed) => {
    setPlan((current) => ({
      open: true,
      nonce: current.nonce + 1,
      request: seed.steps.map((step) => step.text).join("\n"),
      projectId: seed.projectId,
      target: "auto",
      seed,
    }));
  }, []);

  const snapshot =
    query.data ?? (kept?.environmentId === primaryEnvironmentId ? kept.snapshot : null);
  const context = useMemo(
    (): CommandCenterContextValue | null =>
      snapshot && primaryEnvironmentId !== null
        ? {
            snapshot,
            primaryEnvironmentId,
            projects,
            projectId,
            hidden,
            canOperate: canOperate && connected,
            openPlan,
          }
        : null,
    [canOperate, connected, hidden, openPlan, primaryEnvironmentId, projectId, projects, snapshot],
  );

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      isCommandPaletteOpen() ||
      isTypingTarget(event.target)
    ) {
      return;
    }
    if (event.key === "/") {
      event.preventDefault();
      focusOrchestrator();
    } else if (event.key === "h" || event.key === "H") {
      event.preventDefault();
      toggleHidden();
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!enabled) {
    return (
      <PageShell>
        <p className="text-sm text-muted-foreground" role="status">
          Command Center is turned off on this server. Turn it on in{" "}
          <Link to="/settings/general" className="text-foreground underline underline-offset-4">
            Settings
          </Link>
          .
        </p>
      </PageShell>
    );
  }

  if (context === null) {
    return (
      <PageShell>
        <p className="text-sm text-muted-foreground" role="status">
          {primary === null
            ? "Connect an environment to use the Command Center."
            : !connected
              ? `Reconnect ${primary.label} to load the Command Center.`
              : query.error
                ? `Could not load the Command Center: ${query.error}`
                : "Loading the Command Center…"}
        </p>
      </PageShell>
    );
  }

  return (
    <CommandCenterProvider value={context}>
      <CommandCenterBody
        tab={tab}
        onTabChange={onTabChange}
        onProjectFilterChange={setProjectId}
        onToggleHidden={toggleHidden}
        draft={draft}
        onDraftChange={setDraft}
        draftProjectId={draftProjectId}
        onDraftProjectChange={setDraftProjectId}
        plan={plan}
        onPlanChange={setPlan}
        reconnecting={
          connected || primary === null
            ? null
            : `Reconnecting to ${primary.label}… changes are paused.`
        }
      />
    </CommandCenterProvider>
  );
}

function CommandCenterBody({
  tab,
  onTabChange,
  onProjectFilterChange,
  onToggleHidden,
  draft,
  onDraftChange,
  draftProjectId,
  onDraftProjectChange,
  plan,
  onPlanChange,
  reconnecting,
}: {
  readonly tab: CommandCenterTab;
  readonly onTabChange: (tab: CommandCenterTab) => void;
  readonly onProjectFilterChange: (projectId: ProjectId | null) => void;
  readonly onToggleHidden: () => void;
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
  readonly draftProjectId: ProjectId | null;
  readonly onDraftProjectChange: (projectId: ProjectId | null) => void;
  readonly plan: PlanState;
  readonly onPlanChange: Dispatch<SetStateAction<PlanState>>;
  readonly reconnecting: string | null;
}) {
  const { projects, projectId, hidden, canOperate } = useCommandCenter();
  const commands = useCommandCenterCommands();
  const startOnboarding = useStartOnboarding();
  const [target, setTarget] = useState<CommandCenterTarget>("auto");
  const [saving, setSaving] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);

  const submit = async () => {
    const text = draft.trim();
    if (!text || saving) return;
    // `onboard` uses the bar's project; `onboard <project title>` names one. Anything else
    // starting with "onboard" ("onboard the new hire docs") is ordinary work for the plan.
    const onboard = /^onboard(?:\s+(.+))?$/i.exec(text);
    const name = onboard?.[1]?.trim().toLowerCase();
    const onboardProjectId = !onboard
      ? undefined
      : name
        ? projects.find((project) => project.title.toLowerCase() === name)?.id
        : draftProjectId;
    if (onboard && (name === undefined || onboardProjectId !== undefined)) {
      if (!onboardProjectId) {
        toastManager.add({ type: "error", title: "Pick a project to onboard" });
        return;
      }
      if (!canOperate) {
        toastManager.add({ type: "error", title: "You cannot write to this environment" });
        return;
      }
      setSaving(true);
      const started = await startOnboarding(onboardProjectId);
      setSaving(false);
      if (started) onDraftChange("");
      return;
    }
    const note = parseMemoryCommand(text);
    if (note === null) {
      onPlanChange((current) => ({
        open: true,
        nonce: current.nonce + 1,
        request: text,
        projectId: draftProjectId,
        target,
      }));
      return;
    }
    if (!canOperate) {
      toastManager.add({ type: "error", title: "You cannot write to this environment" });
      return;
    }
    setSaving(true);
    const result = await commands.upsert({
      entity: "memory",
      value: {
        projectId: draftProjectId,
        sectionId: null,
        threadId: null,
        kind: "note",
        text: note,
        done: false,
        source: "user",
      },
    });
    setSaving(false);
    if (result._tag === "Success") {
      onDraftChange("");
      toastManager.add({ type: "success", title: "Saved to memory", description: note });
    }
  };

  return (
    <PageShell
      actions={
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Hide amounts"
                  aria-pressed={hidden}
                  onClick={onToggleHidden}
                >
                  {hidden ? <EyeOffIcon /> : <EyeIcon />}
                </Button>
              }
            />
            <TooltipPopup side="bottom">
              {hidden ? "Show amounts (H)" : "Hide amounts (H)"}
            </TooltipPopup>
          </Tooltip>
          <Button size="sm" variant="ghost" onClick={() => setMemoryOpen(true)}>
            <BrainIcon />
            Memory
          </Button>
        </>
      }
    >
      {reconnecting ? (
        <p className="text-xs text-muted-foreground" role="status">
          {reconnecting}
        </p>
      ) : null}
      <OrchestratorBar
        draft={draft}
        onDraftChange={onDraftChange}
        projectId={draftProjectId}
        onProjectChange={onDraftProjectChange}
        target={target}
        onTargetChange={setTarget}
        busy={saving}
        onSubmit={() => void submit()}
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="max-w-full overflow-x-auto">
          <ToggleGroup
            aria-label="Command Center view"
            variant="segmented"
            value={[tab]}
            onValueChange={(next) => {
              const value = COMMAND_CENTER_TABS.find((option) => option.value === next[0]);
              if (value) onTabChange(value.value);
            }}
          >
            {COMMAND_CENTER_TABS.map((option) => (
              <Toggle key={option.value} value={option.value}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
        {projects.length > 0 ? (
          <div className="max-w-full min-w-0 flex-1 overflow-x-auto">
            <ToggleGroup
              aria-label="Filter by project"
              value={[projectId ?? "all"]}
              onValueChange={(next) =>
                onProjectFilterChange(
                  projects.find((project) => project.id === next[0])?.id ?? null,
                )
              }
            >
              <Toggle value="all" variant="pill" size="xs">
                All projects
              </Toggle>
              {projects.map((project) => (
                <Toggle key={project.id} value={project.id} variant="pill" size="xs">
                  {project.title}
                </Toggle>
              ))}
            </ToggleGroup>
          </div>
        ) : null}
      </div>

      {tab === "team" ? (
        <TeamTab />
      ) : tab === "projects" ? (
        <ProjectsTab />
      ) : tab === "infra" ? (
        <InfraTab />
      ) : (
        <FinanceTab />
      )}

      <PlanDrawer
        key={plan.nonce}
        open={plan.open}
        onOpenChange={(open) => onPlanChange((current) => ({ ...current, open }))}
        request={plan.request}
        projectId={plan.projectId}
        target={plan.target}
        {...(plan.seed ? { seed: plan.seed } : {})}
      />
      <MemoryDrawer open={memoryOpen} onOpenChange={setMemoryOpen} />
    </PageShell>
  );
}
