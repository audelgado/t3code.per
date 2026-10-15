import { useAtomValue } from "@effect/atom-react";
import type {
  CommandCenterSnapshot,
  CommandCenterWorkflowRunId,
  ProjectId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BrainIcon,
  EyeIcon,
  EyeOffIcon,
  MessageSquareIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import {
  type Dispatch,
  lazy,
  type ReactNode,
  type SetStateAction,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { isElectron } from "~/env";
import { usePrimarySettings } from "~/hooks/useSettings";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useProjects, useThreadShells } from "~/state/entities";
import { usePrimaryEnvironment } from "~/state/environments";
import { parseWorkflowCommand } from "~/workflowCommand";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { requestWorkflowRun } from "../RunWorkflowDialog";
import { DictationButton } from "../dictation/DictationButton";
import { insertIntoInput } from "../dictation/webDictation";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { FinanceTab } from "./finance/FinanceTab";
import { InfraTab } from "./infra/InfraTab";
import { parseMemoryCommand } from "./logic";
import { MemoryDrawer } from "./memory/MemoryDrawer";
import type { MemoryProjectFilter } from "./memory/memoryLogic";
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
  ORCHESTRATOR_TOGGLE_ID,
  ORCHESTRATOR_INPUT_ID,
  useCommandCenter,
  useCommandCenterCommands,
  useCommandCenterAttention,
  useHideAmountsState,
} from "./shared";
import { COMMAND_CENTER_TABS, type CommandCenterTab } from "./tabs";
import {
  openQuickActionLink,
  quickActionError,
  resolveCommandCenterSections,
  type QuickAction,
} from "./customization";
import { ProjectPicker } from "./ProjectPicker";
import { TeamTab } from "./team/TeamTab";
import { SectionNavigation } from "./SectionNavigation";
import { LAUNCH_TRIGGER_ID, LaunchMenu } from "./LaunchMenu";
import { HomeTab } from "./home/HomeTab";
import { resolvePageKey } from "./pageKeys";
import { deriveWorkItems } from "./work/workItems";
import { PhoneCommandCenter, type PhoneScreen } from "./phone/PhoneCommandCenter";
import { PhoneAskBar } from "./phone/PhoneAskBar";
import { PhoneRoute } from "./phone/PhoneRoute";

const WorkTab = lazy(() =>
  import("./work/WorkTab").then((module) => ({ default: module.WorkTab })),
);
const WorkQuickSwitch = lazy(() =>
  import("./work/WorkQuickSwitch").then((module) => ({ default: module.WorkQuickSwitch })),
);

// Artifacts, Canvas and Workflows carry their own heavier views; load them only when opened.
const ArtifactsTab = lazy(() =>
  import("./artifacts/ArtifactsTab").then((module) => ({ default: module.ArtifactsTab })),
);
const CanvasTab = lazy(() =>
  import("./canvas/CanvasTab").then((module) => ({ default: module.CanvasTab })),
);
const WorkflowsTab = lazy(() =>
  import("./workflows/WorkflowsTab").then((module) => ({ default: module.WorkflowsTab })),
);

type PlanState = Pick<PlanDrawerProps, "request" | "projectId" | "target" | "seed"> & {
  readonly open: boolean;
  /** Bumped per opening so the drawer starts fresh even for the same request. */
  readonly nonce: number;
};

/** Page-level keys (`/`, `H`, `M`, `1`–`8`) never fire while typing. */
function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable)
  );
}

/** An open drawer, dialog or popup owns the keyboard even when focus stayed on the page. */
function overlayOpen() {
  return (
    document.querySelector('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]') !== null
  );
}

function PageShell({
  actions,
  children,
  phone = false,
}: {
  actions?: ReactNode;
  children: ReactNode;
  phone?: boolean;
}) {
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
        {phone ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-4">
            {children}
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <WorkspacePageContainer width="expanded" className="gap-4">
              {children}
            </WorkspacePageContainer>
          </ScrollArea>
        )}
      </div>
    </SidebarInset>
  );
}

/** Adds `text` as a new line of the Ask the team draft. */
const appendLine = (draft: string, text: string) =>
  draft.trim() ? `${draft.trimEnd()}\n${text}` : text;

interface CommandCenterPageProps {
  readonly tab: CommandCenterTab;
  readonly onTabChange: (tab: CommandCenterTab) => void;
  /** Project focus (`?project=`); every tab follows it. */
  readonly projectId: ProjectId | null;
  readonly onProjectChange: (projectId: ProjectId | null) => void;
  /** Artifact open in the Artifacts tab (from the URL). */
  readonly artifactId: string | null;
  readonly onArtifactChange: (artifactId: string | null) => void;
  /** A run of the focused project the Workflows tab opens (from the URL). */
  readonly workflowRunId: CommandCenterWorkflowRunId | null;
  readonly onOpenWorkflowRun: (projectId: ProjectId, runId: CommandCenterWorkflowRunId) => void;
  readonly onCloseWorkflowRun: () => void;
  /** Text handed over in `?ask=`, added to Ask the team once. */
  readonly ask: string | null;
  readonly onAskHandled: () => void;
}

export function CommandCenterPage({
  tab,
  onTabChange,
  projectId,
  onProjectChange,
  artifactId,
  onArtifactChange,
  workflowRunId,
  onOpenWorkflowRun,
  onCloseWorkflowRun,
  ask,
  onAskHandled,
}: CommandCenterPageProps) {
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

  const [draft, setDraft] = useState("");
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
            setProjectFocus: onProjectChange,
            hidden,
            canOperate: canOperate && connected,
            openPlan,
          }
        : null,
    [
      canOperate,
      connected,
      hidden,
      onProjectChange,
      openPlan,
      primaryEnvironmentId,
      projectId,
      projects,
      snapshot,
    ],
  );

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
        artifactId={artifactId}
        onArtifactChange={onArtifactChange}
        workflowRunId={workflowRunId}
        onOpenWorkflowRun={onOpenWorkflowRun}
        onCloseWorkflowRun={onCloseWorkflowRun}
        ask={ask}
        onAskHandled={onAskHandled}
        onToggleHidden={toggleHidden}
        draft={draft}
        onDraftChange={setDraft}
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
  artifactId,
  onArtifactChange,
  workflowRunId,
  onOpenWorkflowRun,
  onCloseWorkflowRun,
  ask,
  onAskHandled,
  onToggleHidden,
  draft,
  onDraftChange,
  plan,
  onPlanChange,
  reconnecting,
}: Pick<
  CommandCenterPageProps,
  | "tab"
  | "onTabChange"
  | "artifactId"
  | "onArtifactChange"
  | "workflowRunId"
  | "onOpenWorkflowRun"
  | "onCloseWorkflowRun"
  | "ask"
  | "onAskHandled"
> & {
  readonly onToggleHidden: () => void;
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
  readonly plan: PlanState;
  readonly onPlanChange: Dispatch<SetStateAction<PlanState>>;
  readonly reconnecting: string | null;
}) {
  // Ask the team works on the focused project; there is no second project picker.
  const { projects, projectId, setProjectFocus, hidden, canOperate } = useCommandCenter();
  const navigate = useNavigate();
  const customization = usePrimarySettings((settings) => settings.commandCenter);
  const sections = resolveCommandCenterSections(customization.sections);
  const tabs = sections.filter((section) => section.visible || section.id === tab);
  const commands = useCommandCenterCommands();
  const startOnboarding = useStartOnboarding();
  const [target, setTarget] = useState<CommandCenterTarget>("auto");
  const [saving, setSaving] = useState(false);
  // Kept after closing so the drawer keeps its filter while it animates out.
  // No project means the drawer starts on the focused project.
  const [memory, setMemory] = useState<{
    open: boolean;
    kind: "all" | "todo";
    project?: MemoryProjectFilter;
  }>({
    open: false,
    kind: "all",
  });
  const [orchestratorOpen, setOrchestratorOpen] = useState(tab === "home");
  const phone = useMediaQuery("max-sm");
  const [phoneScreen, setPhoneScreen] = useState<PhoneScreen>(tab === "work" ? "work" : "today");
  const attention = useCommandCenterAttention();
  const shells = useThreadShells();
  const activeWorkCount = useMemo(
    () => deriveWorkItems(shells, projects).length,
    [shells, projects],
  );
  const chordAt = useRef<number | null>(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  const activeSection = tabs.find((section) => section.id === tab)!;

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      isCommandPaletteOpen() ||
      isTypingTarget(event.target) ||
      overlayOpen()
    ) {
      return;
    }
    const key = event.key.toLowerCase();
    const shortcut = resolvePageKey(key, event.timeStamp, chordAt.current, tab);
    chordAt.current = shortcut.chordAt;
    if (shortcut.tab) {
      event.preventDefault();
      if (shortcut.tab !== tab) onTabChange(shortcut.tab);
      if (shortcut.tab === "work") setPhoneScreen("work");
      else if (shortcut.tab === "home") setPhoneScreen("today");
    } else if (key === "g") {
      event.preventDefault();
    } else if (key === "/") {
      event.preventDefault();
      focusOrchestrator();
    } else if (key === "h") {
      event.preventDefault();
      onToggleHidden();
    } else if (key === "m") {
      event.preventDefault();
      setMemory({ open: true, kind: "all" });
    }
  });
  useEffect(() => {
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // A prompt quick action from the command palette arrives as `?ask=`; it joins the draft once.
  const handledAsk = useRef<string | null>(null);
  const takeAsk = useEffectEvent((text: string) => {
    onDraftChange(appendLine(draft, text));
    onAskHandled();
    focusOrchestrator();
  });
  useEffect(() => {
    if (ask === null) handledAsk.current = null;
    else if (handledAsk.current !== ask) {
      handledAsk.current = ask;
      takeAsk(ask);
    }
  }, [ask]);

  const runQuickAction = async (action: QuickAction) => {
    const error = quickActionError(action);
    if (error) {
      toastManager.add({ type: "error", title: "Quick action unavailable", description: error });
      return;
    }
    if (action.kind === "section") {
      const section = COMMAND_CENTER_TABS.find((item) => item.value === action.target);
      if (section) onTabChange(section.value);
    } else if (action.kind === "prompt") {
      onDraftChange(appendLine(draft, action.target));
      focusOrchestrator();
    } else {
      await openQuickActionLink(action.target, navigate);
    }
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || saving) return;
    const workflowCommand = parseWorkflowCommand(text);
    if (workflowCommand !== null) {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (!project) {
        toastManager.add({ type: "error", title: "Set the project focus to run a workflow in" });
        return;
      }
      // The run starts where the project lives; the request asks for anything missing.
      requestWorkflowRun({
        environmentId: project.environmentId,
        projectId: project.id,
        command: workflowCommand,
      });
      onDraftChange("");
      return;
    }
    // `onboard` uses the project focus; `onboard <project title>` names one. Anything else
    // starting with "onboard" ("onboard the new hire docs") is ordinary work for the plan.
    const onboard = /^onboard(?:\s+(.+))?$/i.exec(text);
    const name = onboard?.[1]?.trim().toLowerCase();
    const onboardProjectId = !onboard
      ? undefined
      : name
        ? projects.find((project) => project.title.toLowerCase() === name)?.id
        : projectId;
    if (onboard && (name === undefined || onboardProjectId !== undefined)) {
      if (!onboardProjectId) {
        toastManager.add({
          type: "error",
          title: "Set the project focus, or type onboard <project title>",
        });
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
        projectId,
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
        projectId,
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
      phone={phone && (tab === "home" || tab === "work")}
      actions={
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={hidden ? "Show amounts" : "Hide amounts"}
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
          <Button
            size="sm"
            variant="ghost"
            aria-label="Open memory"
            onClick={() => setMemory({ open: true, kind: "all" })}
          >
            <BrainIcon />
            <span className="hidden sm:inline">Memory</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Customize Command Center"
            onClick={() => void navigate({ to: "/settings/command-center" })}
          >
            <SettingsIcon />
            <span className="hidden sm:inline">Customize</span>
          </Button>
        </>
      }
    >
      {reconnecting ? (
        <p className="text-xs text-muted-foreground" role="status">
          {reconnecting}
        </p>
      ) : null}
      {phone && (tab === "home" || tab === "work") ? (
        <Suspense fallback={<p role="status">Loading Command Center…</p>}>
          <PhoneCommandCenter
            screen={tab === "work" ? "work" : phoneScreen === "work" ? "today" : phoneScreen}
            onScreenChange={(screen) => {
              setPhoneScreen(screen);
              onTabChange(screen === "work" ? "work" : "home");
            }}
            sections={tabs}
            onOpenSection={onTabChange}
            work={<WorkQuickSwitch />}
            route={<PhoneRoute />}
            askBar={
              <PhoneAskBar
                draft={draft}
                onDraftChange={onDraftChange}
                target={target}
                onTargetChange={setTarget}
                projectId={projectId}
                onProjectChange={setProjectFocus}
                busy={saving}
                onSubmit={() => void submit()}
                mic={
                  <DictationButton
                    key={`${tab}:${phoneScreen}:${projectId}`}
                    onText={(text) =>
                      onDraftChange(insertIntoInput(ORCHESTRATOR_INPUT_ID, draft, text))
                    }
                  />
                }
              />
            }
          />
        </Suspense>
      ) : (
        <>
          <Collapsible open={orchestratorOpen} onOpenChange={setOrchestratorOpen}>
            <div className="flex min-w-0 items-center gap-2 border-b pb-3">
              <div className="min-w-0 flex-1">
                <SectionNavigation
                  sections={tabs}
                  active={tab}
                  onChange={onTabChange}
                  badges={{ home: attention.length, work: activeWorkCount }}
                />
              </div>
              {projects.length > 0 || projectId !== null ? (
                <div className="flex shrink-0 items-center">
                  {projects.length > 0 ? (
                    <ProjectPicker
                      projects={projects}
                      value={projectId}
                      onValueChange={setProjectFocus}
                      ariaLabel="Project focus"
                      compact
                    />
                  ) : null}
                  {/* Also without projects, so a link's focus on a missing project can be cleared. */}
                  {projectId !== null ? (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Clear project focus"
                      onClick={() => setProjectFocus(null)}
                    >
                      <XIcon />
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <LaunchMenu
                actions={customization.quickActions}
                open={launchOpen}
                onOpenChange={setLaunchOpen}
                onRun={(action) => void runQuickAction(action)}
                onEdit={() => void navigate({ to: "/settings/command-center" })}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <CollapsibleTrigger
                      id={ORCHESTRATOR_TOGGLE_ID}
                      render={<Button size="sm" variant="default" aria-label="Ask the team" />}
                    />
                  }
                >
                  <MessageSquareIcon />
                  <span className="max-lg:hidden">Ask the team</span>
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  {draft.trim()
                    ? "Your draft is kept while you navigate (/)"
                    : "Plan work, save a note or run a workflow (/)"}
                </TooltipPopup>
              </Tooltip>
            </div>
            <CollapsiblePanel keepMounted animate={false}>
              <div className="pt-3">
                <OrchestratorBar
                  key={`${tab}:${projectId}`}
                  draft={draft}
                  onDraftChange={onDraftChange}
                  target={target}
                  onTargetChange={setTarget}
                  busy={saving}
                  onSubmit={() => void submit()}
                />
              </div>
            </CollapsiblePanel>
          </Collapsible>

          {tab === "home" ? (
            <HomeTab
              quickActions={customization.quickActions}
              onRunQuickAction={(action) => void runQuickAction(action)}
              onMoreQuickActions={() => {
                // The menu anchors to its trigger in the header, which may be scrolled away.
                document.getElementById(LAUNCH_TRIGGER_ID)?.scrollIntoView({ block: "nearest" });
                setLaunchOpen(true);
              }}
              onTabChange={onTabChange}
              onOpenTodos={() => setMemory({ open: true, kind: "todo", project: "all" })}
            />
          ) : tab === "team" ? (
            <TeamTab />
          ) : tab === "projects" ? (
            <ProjectsTab />
          ) : tab === "infra" ? (
            <InfraTab />
          ) : tab === "finance" ? (
            <FinanceTab />
          ) : (
            <Suspense
              fallback={
                <div className="space-y-3 rounded-xl border bg-card p-4" role="status">
                  <p className="text-sm text-muted-foreground">Loading {activeSection.label}…</p>
                  <div className="grid gap-3 sm:grid-cols-2" aria-hidden="true">
                    <div className="h-24 rounded-lg bg-muted/40" />
                    <div className="h-24 rounded-lg bg-muted/40" />
                  </div>
                </div>
              }
            >
              {tab === "work" ? (
                <WorkTab />
              ) : tab === "artifacts" ? (
                <ArtifactsTab
                  openId={artifactId}
                  onOpenChange={onArtifactChange}
                  onSendToAgent={(text, artifactProjectId) => {
                    // Appended, so a request already being typed keeps its words.
                    onDraftChange(draft.trim() === "" ? text : `${draft.trimEnd()} ${text}`);
                    if (artifactProjectId !== null) setProjectFocus(artifactProjectId);
                    focusOrchestrator();
                  }}
                />
              ) : tab === "canvas" ? (
                <CanvasTab />
              ) : (
                <WorkflowsTab
                  runId={workflowRunId}
                  onOpenRun={onOpenWorkflowRun}
                  onCloseRun={onCloseWorkflowRun}
                />
              )}
            </Suspense>
          )}
        </>
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
      <MemoryDrawer
        open={memory.open}
        onOpenChange={(open) => setMemory((current) => ({ ...current, open }))}
        initialKind={memory.kind}
        {...(memory.project ? { initialProject: memory.project } : {})}
      />
    </PageShell>
  );
}
