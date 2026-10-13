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
drawer: open the thread, stop it, release it, and for a worktree step open the diff, commit or
open a pull request, or discard the step. Archived teams, agents and costs can be restored from
their tabs, and deleted memory entries, sections and income show an **Undo**.

## Memory

Memory is how you see where things stand after a break: progress, decisions, todos, and handoffs
between teams. Agents save and read it through the `memory_save` and `memory_recall` tools, so
"save this to memory" works from any thread on your primary machine. Agents on other machines
cannot reach memory; a step delegated there gets the latest handoffs in its prompt and ends its
reply with a handoff instead. Open **Memory** to search, filter, close todos, or load older
entries. A short daily digest of yesterday's activity is added per project.

**Infra** shows each connected machine's CPU, memory, disks and the busiest agent processes
while the tab is open.

## From the terminal

With T3 Code running, `t3 memory list|add|done|recall` and `t3 cc sections|onboard` read and write
the same data. They need a running server.

## Mobile

On mobile, **Settings → Automations → Command Center** shows a read-only summary: team status,
what needs you, and upcoming deliveries.
