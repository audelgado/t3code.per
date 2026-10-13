# Command Center

Command Center is one page for running several projects with agent teams across your machines.
Open **Command Center** from the sidebar or the command palette. Looking at it never spends
tokens; only agents doing work do.

Its data lives on your primary server. Other machines appear as the environments you are
already connected to. Turn it off in **Settings → General → Command Center**; the sidebar entry
disappears and the server stops its daily upkeep.

## Delegate work

Type a request in the orchestrator bar (press `/` to focus it), pick a project and a machine
(`Auto` uses the team's machine, then your primary one), and review the plan before anything
starts. Each step starts a normal thread with the agent profile's provider and model. Steps
start together, each on its own idle agent, so write ordered work ("migrate and then deploy")
as one step. In a Git project each step gets its own worktree and branch by default.

- `remember: <text>` saves a note straight to memory without an agent.
- `onboard` (or `onboard <project title>`) maps a project into sections and todos. The **Onboard**
  button on a project card does the same. Onboarding runs on your primary machine, so the
  project must be there. The Onboarding team asks you about anything it cannot find, such as
  deliveries and the billing client; open questions are listed under **What's missing**.

When an agent waits on you, answer it inline from **What's missing**. Click an agent to open its
drawer: open the thread, see its changes, stop it, release it, and for a worktree step commit or
open a pull request, or discard the step. **View changes** shows everything a worktree step
changed; for an agent in a shared checkout it shows its latest turn. Archived teams, agents and costs can be restored from
their tabs, and deleted memory entries, sections and income show an **Undo**.

## Memory

Memory is how you see where things stand after a break: progress, decisions, todos, and handoffs
between teams. Agents save and read it through the `memory_save` and `memory_recall` tools, so
"save this to memory" works from any thread on your primary machine. Agents on other machines
cannot reach memory; a step delegated there gets the latest handoffs in its prompt and ends its
reply with a handoff instead. Open **Memory** to search, filter, close todos, or load older
entries. A short daily digest of yesterday's activity is added per project.

## Projects

A project card can link each section to its pull request and shows the PR's state. It also lists
the project's recurring scheduled tasks (create and edit them in **Settings → Scheduled tasks**,
which **New task** opens for you), and **Preview** opens the project's dev server in the browser
panel beside its latest thread.

## Artifacts and Canvas

**Artifacts** is a versioned library of HTML and Markdown pages shared by all your agents. Agents
save, list and read them with `artifact_save`, `artifact_list` and `artifact_get`, so a page one
provider made can be revised by another. Save a page an agent rendered in a thread with the
library button on the page. To bring in a claude.ai artifact, paste it or drop the file on
**Artifacts**. Open one to see its history, compare versions, restore an older one (it becomes a
new version), or **Send to agent**, which adds it to the orchestrator bar. Deleted artifacts can be
restored from the **Deleted** view.

**Canvas** is a board per project where you place artifacts, sections, memory entries and notes,
and connect them. A board holds up to 200 cards.

**Infra** shows each connected machine's CPU, memory, disks and the busiest agent processes
while the tab is open.

## Workflows

A workflow is a reusable process of agent steps, skills, questions to you and checks, saved in the
project as `.t3/workflows/<slug>.json`, so it travels with the repo. Open **Workflows**, pick a
project, and copy a built-in starter (Onboarding, Feature, Bugfix, Release notes, Weekly digest),
make a new one, or ask any agent to build one ("make a workflow that reviews a PR and writes
release notes"). Click a workflow to edit it on the canvas.

Run one from its card, the **Run** button on a project card, the command palette, a shortcut you
set in the editor, or by typing `/wf <slug> [name=value]... [text]` in the orchestrator bar or a
thread's composer (free text fills the first input that still needs a value). Each agent step starts a normal thread,
in its own worktree when the step says so. A run pauses on a question or a manual check until you
answer it in the run view; the first choice continues the run and any other stops it, and
**Resume** asks again. Stop, retry a step, and resume are always available.

- A scheduled task whose prompt is `/wf <slug> ...` runs that workflow instead of starting a
  thread. Its steps never get broader permissions than the task's runtime and interaction modes,
  and the same holds for runs an agent starts.
- **Skills** lists the project's skills (saved to `.agents/skills` and `.claude/skills` so every
  provider uses them); **Snippets** lists shared text that prompts include with
  `{{snippet:name}}`. Deleting either shows an **Undo**.
- Under each prompt, **Optimize** tidies the text for free and **Rewrite shorter** asks your text
  generation model for a shorter version, which you review as a diff before using it.

## From the terminal

With T3 Code running, `t3 memory list|add|done|recall`, `t3 cc sections|onboard`,
`t3 cc artifacts list|get|save` and `t3 wf list|run|status|answer` read and write the same data.
They need a running server.

## Mobile

On mobile, **Settings → Automations → Command Center** shows a read-only summary: team status,
what needs you, upcoming deliveries, and your artifacts to read. Its **Workflows** section starts
runs, follows their steps, answers waiting questions and checks, and stops, resumes or retries.
