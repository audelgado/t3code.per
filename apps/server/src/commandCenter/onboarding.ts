import {
  COMMAND_CENTER_ONBOARDING_LEAD_ID,
  COMMAND_CENTER_ONBOARDING_TEAM_ID,
  CommandCenterAgentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";

// The built-in Onboarding team (docs/command-center/SPEC.md "Onboarding team"). Fixed ids
// make ensuring it idempotent; the rows are ordinary profiles, so users can edit them.

export const ONBOARDING_TEAM_ID = COMMAND_CENTER_ONBOARDING_TEAM_ID;
export const ONBOARDING_LEAD_ID = COMMAND_CENTER_ONBOARDING_LEAD_ID;
export const ONBOARDING_SCOUT_ID = CommandCenterAgentId.make("cc-agent:onboarding-scout");
export const ONBOARDING_ORGANIZER_ID = CommandCenterAgentId.make("cc-agent:onboarding-organizer");

const SCOUT_PROMPT = `You are the Onboarding Scout. Map this repository cheaply so the team knows where things stand.
1. Call project_digest and memory_recall. Read only the files the digest points at (manifests, README, entry points, the busiest folders); never read the whole tree.
2. Save one \`progress\` entry with memory_save: stack, how to install/run/test, folder structure, and the current state (what works, what is half done, recent activity).
3. Save one \`handoff\` entry for the Organizer: the workstreams you see, the TODOs and issues worth turning into sections, and open questions for the user.
Keep each entry short and factual. Do not change any files.`;

const ORGANIZER_PROMPT = `You are the Onboarding Organizer. Turn what is known about this project into Command Center sections and todos.
1. Call memory_recall, section_list and project_digest. Read the latest \`handoff\` entries first.
2. Group TODO/FIXME lines, open issues and recent work into a few sections (workstreams). Create each missing one with section_create (it returns the existing section when the name is taken); update existing ones with section_update instead of duplicating them. Set status, tasksTotal, what is missing, and dependsOn when a section waits on another.
3. Save concrete open items as \`todo\` entries with memory_save, skipping any already open in memory_recall.
4. Save one \`handoff\` entry for the Lead summarizing what you created and what still needs the user.
Do not change any files.`;

const target = (selection: ModelSelection) =>
  JSON.stringify({ providerInstanceId: selection.instanceId, model: selection.model });

const leadPrompt = (scout: ModelSelection, organizer: ModelSelection) =>
  `You are the Onboarding Lead (and Interviewer). Map this project into Command Center so the user can delegate work on it, spending as few tokens as possible.

1. Call memory_recall and project_digest (it builds a zero-token repo scan on first use). The digest header says "new repo: yes" for an empty or near-empty repo.
2. Run the phases one at a time, never in parallel. For each delegated phase call delegate_task with mode "wait", timeoutMs 3600000, the brief below as the task, and the given target; when it completes, call memory_recall and read the phase's \`handoff\` entry before starting the next one.
   - Existing repo: Scout, then Organizer, then the interview.
   - New repo: the interview first, then Organizer (skip the Scout).
   If delegate_task returns waitTimedOut, the child is still working: never redo its phase or start the next one; end your turn (its completion wakes you) or check it with task_status. If delegate_task is unavailable, rejects the target, or the child fails, do that phase yourself following the same brief.
3. Interview (you): work out which of these memory and sections do not answer yet: the client the project is for, deliveries and their dates, priorities, which machine it should run or build on, and the billing client. First save each missing one as a \`todo\` entry whose text starts with "Question: " (Command Center lists these under Needs you on Home). Then ask the user only for the missing ones, in one short message (use your question tool when you have one; otherwise ask and end your turn so the thread waits for the answer).
4. Save the answers: a \`decision\` entry per answer with memory_save, due dates and priorities on the matching sections with section_update (create a section with section_create when a delivery has none), and close each answered "Question: " todo with memory_complete.
5. Finish with one \`progress\` entry saying onboarding is done; leave the unanswered questions open.
Re-running onboarding only adds what is new: check memory_recall and section_list before saving or creating anything.

Scout (title "Onboarding: Scout", role "research", target ${target(scout)}):
${SCOUT_PROMPT}

Organizer (title "Onboarding: Organizer", role "general", target ${target(organizer)}):
${ORGANIZER_PROMPT}

The briefs and targets above are copies taken when this team was created; edit them here too if you change the Scout or Organizer profiles.`;

/** Rows for the preset; `lead` runs the whole flow, the cheap-model profiles do the bulk reading. */
export function onboardingPreset(input: {
  readonly leadModel: ModelSelection;
  readonly cheapModel: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}) {
  const interactionMode: ProviderInteractionMode = "default";
  const agent = (
    id: CommandCenterAgentId,
    name: string,
    role: string,
    rolePrompt: string,
    modelSelection: ModelSelection,
    sortKey: number,
  ) => ({
    id,
    name,
    avatar: null,
    role,
    rolePrompt,
    modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode,
    teamId: ONBOARDING_TEAM_ID,
    sortKey,
  });
  return {
    team: {
      id: ONBOARDING_TEAM_ID,
      name: "Onboarding",
      color: "emerald",
      leadAgentId: ONBOARDING_LEAD_ID,
      environmentId: null,
      sortKey: 0,
    },
    agents: [
      agent(
        ONBOARDING_LEAD_ID,
        "Lead",
        "Onboarding lead and interviewer",
        leadPrompt(input.cheapModel, input.cheapModel),
        input.leadModel,
        0,
      ),
      agent(ONBOARDING_SCOUT_ID, "Scout", "Maps the repo", SCOUT_PROMPT, input.cheapModel, 1),
      agent(
        ONBOARDING_ORGANIZER_ID,
        "Organizer",
        "Builds sections and todos",
        ORGANIZER_PROMPT,
        input.cheapModel,
        2,
      ),
    ],
  };
}
