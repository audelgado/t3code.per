import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  type CommandCenterAgentId,
  type CommandCenterArtifactGetInput,
  type CommandCenterBuildRepoDigestInput,
  type CommandCenterDeleteInput,
  type CommandCenterListMemoryInput,
  type CommandCenterSectionId,
  type CommandCenterSetMemoryDoneInput,
  type CommandCenterTeamId,
  type CommandCenterSnapshot,
  type CommandCenterUpsertInput,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { createContext, use, useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { toastManager } from "../ui/toast";
import {
  deriveAgentState,
  latestAssignmentByAgent,
  pendingChildrenByParent,
  threadShellKey,
  type CommandCenterAgentState,
} from "./logic";

/** Where the orchestrator sends work: a specific environment, or `auto` to pick one. */
export type CommandCenterTarget = EnvironmentId | "auto";

export interface CommandCenterContextValue {
  /** Live Command Center data from the primary environment. */
  readonly snapshot: CommandCenterSnapshot;
  /** Environment that stores Command Center rows; every mutation goes here. */
  readonly primaryEnvironmentId: EnvironmentId;
  /** T3 projects across all connected environments (scratch projects excluded, ids deduped). */
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** Project filter chip; null shows everything. Tabs dim rows outside it rather than hide them. */
  readonly projectId: ProjectId | null;
  /** Hide amounts toggle; `Money` already reads it. */
  readonly hidden: boolean;
  /** Whether this viewer may write (orchestration:operate on the primary environment). */
  readonly canOperate: boolean;
  /** Opens the plan drawer with ready-made steps, skipping the text split. */
  readonly openPlan: (plan: CommandCenterPlanSeed) => void;
}

/** Steps handed straight to the plan drawer, e.g. "Delegate what's missing" or "Give work". */
export interface CommandCenterPlanSeed {
  readonly projectId: ProjectId | null;
  readonly steps: ReadonlyArray<{
    readonly text: string;
    readonly sectionId?: CommandCenterSectionId | null;
  }>;
  /** Team every step starts on; the plan guesses one per step when omitted. */
  readonly teamId?: CommandCenterTeamId | null;
}

/** DOM id of the orchestrator input, so `/` and prefill can focus it. */
export const ORCHESTRATOR_INPUT_ID = "command-center-orchestrator-input";

export function focusOrchestrator() {
  document.getElementById(ORCHESTRATOR_INPUT_ID)?.focus();
}

const CommandCenterContext = createContext<CommandCenterContextValue | null>(null);

export const CommandCenterProvider = CommandCenterContext;

/** Page state for every tab, drawer and helper below. Only valid under the Command Center page. */
export function useCommandCenter(): CommandCenterContextValue {
  const value = use(CommandCenterContext);
  if (value === null) throw new Error("useCommandCenter must be used inside the Command Center.");
  return value;
}

/**
 * Every Command Center RPC against the primary environment. Failures toast and resolve as a
 * `Failure` result, so callers only check `result._tag === "Success"`.
 */
export function useCommandCenterCommands() {
  const { primaryEnvironmentId } = useCommandCenter();
  const upsert = useAtomCommand(serverEnvironment.upsertCommandCenter, "command center save");
  const remove = useAtomCommand(serverEnvironment.deleteCommandCenter, "command center delete");
  const setMemoryDone = useAtomCommand(
    serverEnvironment.setCommandCenterMemoryDone,
    "command center memory done",
  );
  const listMemory = useAtomCommand(
    serverEnvironment.listCommandCenterMemory,
    "command center list memory",
  );
  const buildRepoDigest = useAtomCommand(
    serverEnvironment.buildCommandCenterRepoDigest,
    "command center repo digest",
  );
  const ensureOnboardingTeam = useAtomCommand(
    serverEnvironment.ensureCommandCenterOnboardingTeam,
    "command center onboarding team",
  );
  const recallMemory = useAtomCommand(
    serverEnvironment.recallCommandCenterMemory,
    "command center recall memory",
  );
  const getArtifact = useAtomCommand(
    serverEnvironment.getCommandCenterArtifact,
    "command center get artifact",
  );
  return useMemo(() => {
    const reportAs =
      (title: string) =>
      <A, E>(result: AtomCommandResult<A, E>) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title,
            description: String(squashAtomCommandFailure(result)),
          });
        }
        return result;
      };
    const report = reportAs("Could not update Command Center");
    return {
      upsert: (input: CommandCenterUpsertInput) =>
        upsert({ environmentId: primaryEnvironmentId, input }).then(report),
      remove: (input: CommandCenterDeleteInput) =>
        remove({ environmentId: primaryEnvironmentId, input }).then(report),
      /**
       * Deletes, then offers Undo, which writes `restore` (the row with its id) back. Resolves
       * true once deleted.
       */
      removeWithUndo: async (
        input: CommandCenterDeleteInput,
        restore: CommandCenterUpsertInput,
        title: string,
      ) => {
        const result = await remove({ environmentId: primaryEnvironmentId, input }).then(report);
        if (result._tag !== "Success") return false;
        const id = toastManager.add({
          type: "info",
          title,
          actionProps: {
            children: "Undo",
            onClick: () => {
              toastManager.close(id);
              void upsert({ environmentId: primaryEnvironmentId, input: restore }).then(report);
            },
          },
        });
        return true;
      },
      setMemoryDone: (input: CommandCenterSetMemoryDoneInput) =>
        setMemoryDone({ environmentId: primaryEnvironmentId, input }).then(report),
      listMemory: (input: CommandCenterListMemoryInput) =>
        listMemory({ environmentId: primaryEnvironmentId, input }).then(
          reportAs("Could not load older memory"),
        ),
      buildRepoDigest: (input: CommandCenterBuildRepoDigestInput) =>
        buildRepoDigest({ environmentId: primaryEnvironmentId, input }).then(
          reportAs("Could not scan the repo"),
        ),
      ensureOnboardingTeam: () =>
        ensureOnboardingTeam({ environmentId: primaryEnvironmentId, input: {} }).then(report),
      /** Not reported: callers fall back to the snapshot's memory window. */
      recallMemory: (projectId: ProjectId) =>
        recallMemory({ environmentId: primaryEnvironmentId, input: { projectId } }),
      /** Not reported: callers fall back to what they already have. */
      getArtifact: (input: CommandCenterArtifactGetInput) =>
        getArtifact({ environmentId: primaryEnvironmentId, input }),
    };
  }, [
    buildRepoDigest,
    getArtifact,
    ensureOnboardingTeam,
    recallMemory,
    listMemory,
    primaryEnvironmentId,
    remove,
    setMemoryDone,
    upsert,
  ]);
}

/**
 * Status of every agent profile, joined from its latest assignment and that thread's shell.
 * Subscribes to every thread shell, so call it only where statuses are shown. Re-derives each
 * minute so an expired usage limit stops reading as limited.
 */
export function useAgentStates(): ReadonlyMap<CommandCenterAgentId, CommandCenterAgentState> {
  const { snapshot } = useCommandCenter();
  const shells = useThreadShells();
  const now = useRelativeTimeTick(60_000);
  return useMemo(() => {
    const shellByKey = new Map(
      shells.map((shell) => [threadShellKey(shell.environmentId, shell.id), shell] as const),
    );
    const latest = latestAssignmentByAgent(snapshot.assignments);
    const pendingChildren = pendingChildrenByParent(shells);
    return new Map(
      snapshot.agentProfiles.map((agent) => {
        const assignment = latest.get(agent.id) ?? null;
        const key = assignment ? threadShellKey(assignment.environmentId, assignment.threadId) : "";
        const shell = assignment ? (shellByKey.get(key) ?? null) : null;
        return [
          agent.id,
          deriveAgentState(assignment, shell, now, pendingChildren.get(key) ?? null),
        ] as const;
      }),
    );
  }, [now, shells, snapshot.agentProfiles, snapshot.assignments]);
}

export interface CommandCenterEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly phase: EnvironmentPresentation["connection"]["phase"];
  readonly connected: boolean;
  readonly isPrimary: boolean;
}

/** Every known environment (the machines), primary first. */
export function useCommandCenterEnvironments(): ReadonlyArray<CommandCenterEnvironment> {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useMemo(
    () =>
      environments
        .map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          phase: environment.connection.phase,
          connected: environment.connection.phase === "connected",
          isPrimary: environment.environmentId === primaryEnvironmentId,
        }))
        .toSorted((left, right) => Number(right.isPrimary) - Number(left.isPrimary)),
    [environments, primaryEnvironmentId],
  );
}

const HIDE_AMOUNTS_KEY = "t3code:command-center:hide-amounts";

function readHideAmounts() {
  try {
    return globalThis.localStorage?.getItem(HIDE_AMOUNTS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Per-viewer Hide amounts flag, remembered in localStorage. Owned by the page; tabs read `hidden`. */
export function useHideAmountsState() {
  const [hidden, setHidden] = useState(readHideAmounts);
  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(HIDE_AMOUNTS_KEY, hidden ? "1" : "0");
    } catch {
      // Storage can be blocked (private mode); the toggle still works for this visit.
    }
  }, [hidden]);
  return { hidden, setHidden, toggle: () => setHidden((current) => !current) };
}

const moneyFormats = new Map<string, Intl.NumberFormat>();

export function formatMoney(cents: number, currency: string) {
  let format = moneyFormats.get(currency);
  if (!format) {
    format = new Intl.NumberFormat(undefined, { style: "currency", currency });
    moneyFormats.set(currency, format);
  }
  return format.format(cents / 100);
}

/** Every money value goes through this so Hide amounts blurs it. */
export function Money({
  cents,
  currency,
  className,
}: {
  readonly cents: number;
  readonly currency: string;
  readonly className?: string;
}) {
  const { hidden } = useCommandCenter();
  return (
    <span className={cn("tabular-nums", className)}>
      <span aria-hidden={hidden || undefined} className={cn(hidden && "blur-sm select-none")}>
        {formatMoney(cents, currency)}
      </span>
      {hidden ? <span className="sr-only">Hidden amount</span> : null}
    </span>
  );
}
