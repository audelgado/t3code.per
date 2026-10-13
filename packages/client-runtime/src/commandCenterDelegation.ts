import type { CommandCenterMemoryEntry, ProjectId } from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";

// How Command Center starts agent threads, shared by the web plan drawer, the web onboarding
// flow and `t3 cc onboard`, so every surface sends the same first message.

const HANDOFF_PROMPT_LIMIT = 3;
const HANDOFF_TEXT_LIMIT = 500;

/** Newest handoff entries for a project, as included in delegated prompts. */
export function latestHandoffs(
  memory: ReadonlyArray<CommandCenterMemoryEntry>,
  projectId: ProjectId,
  limit = HANDOFF_PROMPT_LIMIT,
): CommandCenterMemoryEntry[] {
  return memory
    .filter((entry) => entry.kind === "handoff" && entry.projectId === projectId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}

export interface StepPromptInput {
  readonly rolePrompt: string;
  readonly step: string;
  /** Latest handoffs for the project, newest first (see `latestHandoffs`). */
  readonly handoffs?: ReadonlyArray<CommandCenterMemoryEntry>;
  /**
   * False when the thread runs on a machine other than the Command Center home: its memory tools
   * refuse there, so the agent hands off in its final reply instead. Defaults to true.
   */
  readonly memoryReachable?: boolean;
}

/**
 * First message of a delegated thread: who the agent is, what to do, the latest handoffs, and
 * the memory contract (recall first, save a handoff when done). Plan steps start together, so
 * a handoff reaches whichever thread starts next on the project, not a sibling step.
 */
export function buildStepPrompt({
  rolePrompt,
  step,
  handoffs = [],
  memoryReachable = true,
}: StepPromptInput) {
  const handoffBlock =
    handoffs.length === 0
      ? ""
      : [
          "Latest handoffs for this project (newest first):",
          ...handoffs.map((entry) => {
            const text =
              entry.text.length > HANDOFF_TEXT_LIMIT
                ? `${entry.text.slice(0, HANDOFF_TEXT_LIMIT - 1)}…`
                : entry.text;
            return `- ${entry.createdAt.slice(0, 10)}: ${text}`;
          }),
        ].join("\n");
  const contract = memoryReachable
    ? "Before you start, call the memory_recall tool for this project to see where we left off. " +
      'When you finish, call memory_save with kind "handoff" saying what is ready and what is ' +
      "missing for whoever picks this project up next. Save open todos with memory_save too."
    : "Command Center memory lives on another machine, so its tools do not work here; the " +
      'latest handoffs are above. When you finish, end your reply with a short "Handoff:" ' +
      "paragraph saying what is ready and what is missing.";
  return [rolePrompt.trim(), `Task: ${step}`, handoffBlock, contract]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

/** Task of an onboarding run: the Lead thread's title and the assignment's task. */
export const onboardingTask = (projectTitle: string) => `Onboard ${projectTitle}`;

/**
 * First message of the Onboarding Lead's thread. The Lead's role prompt runs the phases; the
 * handoffs let a re-run pick up where the last one stopped.
 */
export function buildOnboardingPrompt(input: {
  readonly rolePrompt: string;
  readonly projectTitle: string;
  readonly handoffs: ReadonlyArray<CommandCenterMemoryEntry>;
}) {
  return buildStepPrompt({
    rolePrompt: input.rolePrompt,
    step: onboardingTask(input.projectTitle),
    handoffs: input.handoffs,
  });
}

/** A delegated worktree starts from whatever the project checkout has out; git resolves `HEAD`. */
export const DELEGATION_BASE_REF = "HEAD";

/**
 * Branch of a delegated step's worktree, e.g. `cc/ana-fix-the-login-page-1a2b3c4d`. Naming it up
 * front skips the launch's model-generated rename, so a step spends no tokens on its branch name.
 * The thread id suffix keeps two steps with the same text apart.
 */
export function delegationBranchName(agentName: string, task: string, threadId: string) {
  const slug = sanitizeBranchFragment(`${agentName} ${task}`)
    .slice(0, 40)
    .replace(/[./_-]+$/, "");
  return `cc/${slug}-${threadId.replaceAll("-", "").slice(-8)}`;
}

/**
 * `bootstrap` fields for `startTurn` that put a delegated thread in its own worktree (the same
 * path a "New worktree" composer thread takes), or none to run in the project checkout.
 */
export function delegationWorktreeBootstrap(input: {
  readonly worktree: boolean;
  readonly projectCwd: string;
  readonly branch: string;
}) {
  if (!input.worktree) return {};
  return {
    prepareWorktree: {
      projectCwd: input.projectCwd,
      baseBranch: DELEGATION_BASE_REF,
      branch: input.branch,
      requireWorktree: true,
    },
    runSetupScript: true,
  };
}
