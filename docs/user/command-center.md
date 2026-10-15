# Command Center

Command Center is one page for running several projects with agent teams across your machines.
Open **Command Center** from the sidebar, with `mod+alt+o`, or from the command palette, which
also lists each visible tab, your quick actions and your pinned projects. It opens on **Home**,
which shows what needs you today. Looking at it never spends tokens; only agents doing work do.

The row at the top holds the tabs, the project focus, **Launch** (your quick actions) and **Ask
the team**. On a phone browser, **Today**, **Done**, **Work** and **Route** share an Ask bar;
**More** opens the other tabs. On Home, `1` to `8` open pinned projects and `M` opens Memory; see
[Keybindings](./keybindings.md#command-center).

The project focus filters to one project and never just dims the others: Team shows the agents
working on it, Infra the machines that host or build it, Finance the costs assigned to it and
Artifacts its artifacts, while Canvas and Workflows open that project. In **Projects**, the focus
is the open project details. Home stays across all projects; only its **Add todo** uses the
focus, as do **Ask the team** and `onboard`. The focus is part of the link (`?project=…`), so a
reload or a shared link keeps it, and entries from the command palette keep it too. Choose **All
projects** or the clear button next to the picker to clear it.

Its data lives on your primary server. Other machines appear as the environments you are
already connected to. Turn it off for a server in **Settings → General → Command Center**; the
sidebar entry disappears and that server stops its daily upkeep.

## Home

Home brings together attention, pinned projects and quick actions:

- **Now**: working threads, items that need you, active work and money owed to you.
  Click a counter to open its view. Activity charts use the latest completed run visible for
  each thread, rather than a full history of runs.
- **Needs you**: threads on any machine waiting for an approval, an answer or a plan review,
  workflow runs on your primary server waiting for your answer (**Open run**), then disconnected
  machines, silent agents, deliveries at risk, onboarding questions, blocked
  sections and overdue income. Answer approvals and questions inline, mark a blocked section
  **Resolved**, or open the thread, project or Finance. A snoozed thread shows up again as soon
  as it asks for something.
- **Pinned**: up to eight projects you pinned in **Projects**, in your manual order.
  Open one for its details, or press its number.
- **Todos**: your newest open todos from every project. Check one to close it, add one (it
  joins the focused project, if any), or **Open in Memory** for every todo, done ones included.
- **Launch**: start a thread or a worktree, plan work, save a note, or use your quick actions.
  **More** opens the full **Launch** menu.

## Work

Open **Work** to rotate between branches, inspect their progress and open their threads.
Filter by machine, collapse project lanes or switch to compact rows. Choose **Manual** and
**Reorder** to move projects; this order is shared with Projects and pinned cards. Collapse,
density and the selected sort are saved on your device.

Push and Update use the selected machine and are available only when the loaded checkout
matches the branch. Close requires a checked, clean state with no unpushed commits or active
agent; it removes the worktree without force and archives its threads. Reopen recreates the
worktree and restores those threads. If an action fails partway through, the row keeps the
completed steps so you can repair it with Reopen.

**Tidy branches** scans the projects on the current page with existing Git operations.
Review merged PR branches, dirty worktrees, unpushed commits, missing remotes or outdated
upstreams. You can copy a command, ask an agent to tidy, or confirm removal of a worktree.
It does not delete branches. Unavailable status stays unknown until loaded.

## Phone browser

**Today** lets you answer approvals and questions inline; ready plans open their thread.
**Done** lists stored final replies and checkpoint statistics for today or the last seven
calendar days. Expand a summary or open its thread; reading it spends no tokens.

The Ask bar keeps your project and target machine visible. **Route** shows routing previews
and agent profiles. Each project belongs to its own environment: cloning it on another
machine creates a separate project, rather than merging the two.

In project details, open **AGENTS.md** to review or explicitly save project instructions.
**Add project on another machine** clones into the destination environment you choose.

## Delegate work

Set the project focus, open **Ask the team** (or press `/`), type a request, pick a machine
(`Auto` uses the machine that holds the selected project, when it is connected and its provider is
available), and review the plan before anything
starts. Work always goes to the focused project. Each step starts a normal thread with the agent profile's provider and model. Steps
start together, each on its own idle agent, so write ordered work ("migrate and then deploy")
as one step. In a Git project each step gets its own worktree and branch by default.

- `remember: <text>` saves a note straight to memory without an agent.
- `onboard` (for the focused project, or `onboard <project title>`) maps a project into sections
  and todos. The **Onboard**
  button on a project card does the same. Onboarding runs on your primary machine, so the
  project must be there. The Onboarding team asks you about anything it cannot find, such as
  deliveries and the billing client; open questions are listed under **Needs you** on Home.

When an agent waits on you, answer it inline from **Needs you** on Home. Click an agent to open its
drawer: open the thread, see its changes, stop it, release it, and for a worktree step commit or
open a pull request, or discard the step. **View changes** shows everything a worktree step
changed; for an agent in a shared checkout it shows its latest turn. Archived teams, agents and costs can be restored from
their tabs, and deleted memory entries, sections and income show an **Undo**.

## Customize the panel

Open **Settings → Command Center**, or choose **Customize** from the panel. On web and desktop,
you can rename, reorder and hide its tabs, and restore their default layout. Save a tab's name
with Enter or its save action. The first visible tab opens by default, so moving Home down or
hiding it changes where the panel opens. Hiding a tab keeps its data; a direct link or quick
action can still open it. At least one tab stays visible.

Add quick actions to open a tab, open an HTTP or HTTPS link or a page of the app (such as
`/usage` or `/command?tab=finance`), or prepare an instruction in the panel. They are listed in
**Launch** from any tab and in the command palette, and the first eight appear on Home.
Instructions wait for you in **Ask the team** to review and submit them. Actions can be edited, reordered or
removed. These settings are saved on your primary server, so every web or desktop client that
connects to it shows the same panel. The mobile app keeps its compact summary layout.

## Memory

Memory is how you see where things stand after a break: progress, decisions, todos, and handoffs
between teams. Agents save and read it through the `memory_save` and `memory_recall` tools, so
"save this to memory" works from any thread on your primary machine. Agents on other machines
cannot reach memory; a step delegated there gets the latest handoffs in its prompt and ends its
reply with a handoff instead. Open **Memory** to search, filter, close todos, or load older
entries. A short daily digest of yesterday's activity is added per project.
Search covers loaded entries; **Load older**, on the last page, adds more history. Paging or
folding the entry form keeps its draft.

## Projects

**Projects** lists every T3 project once per machine; two checkouts of the same repository stay
separate rows. Pinned projects come first, then the rest by recent thread activity. You can also
search by name or path, filter by machine or status, and sort by name, attention or next
delivery. The directory shows 10 projects per page by default; you can choose 20 or 50. Summary
totals cover every matching project, and the expandable delivery calendar covers the current page.

### Bring in all your projects

- **Add project** opens the command palette to add a folder or repository. **Import from Claude
  Code / Codex** opens the welcome setup, which brings in the projects those tools already know.
- **Pin** a project from its details to keep it at the top of the directory and of every project
  picker in the panel. **Unpin** removes it.
- **Manage groups** creates, renames and deletes your own groups. Tick projects in the directory
  (or **Select page**), then choose **Move to group** or **Remove from group**. The group chips
  above the search filter the directory. Deleting a group keeps its projects and shows an
  **Undo**.
- **Link site** saves the project's site or admin page (an `http://` or `https://` link), shown
  as **Open site**. **Edit link** and **Clear link** change or remove it.

Pins, groups and links are saved on your primary server, so every web and desktop client shows
the same ones.

Select a project to open its details, which also makes it the project focus for the other tabs;
the link (`?tab=projects&project=…`) reopens them after a reload. When no details are open and
your filters leave a single project, its details open on their own. The detail stays open while
you search or change pages; save or cancel a section edit before switching to another project.
From the details, **Open latest thread**, **New thread**, **Pull requests** and **Project
settings** take you straight to that project's work.

A project card can link each section to its pull request and shows the PR's state. It also lists
the project's recurring scheduled tasks (create and edit them in **Settings → Scheduled tasks**,
which **New task** opens for you), and **Preview** opens the project's dev server in the browser
panel beside its latest thread. Open todos and scheduled tasks show five at a time with a pager.
Within a project's details, search sections by name, blocker or pending work and filter by status.
An open section edit stays available when a filter excludes it.

## Teams and finances

In **Team**, find teams or agents by name, role or task, and narrow them to a machine. An agent
without a team counts as being on the machine of its latest work. Team, member and archived
lists are paged; the team's Lead stays visible. What needs your answer is listed on Home, so
Team only shows how many items wait there. With a project focus, Team lists only the agents
working on that project now.

In **Finance**, search income and costs, filter income by payment status, and review the paged
project cost ranking. With a project focus, costs and the ranking only cover that project.
List filters and the focus do not change the overall financial totals.

## Artifacts and Canvas

**Artifacts** is a versioned library of HTML and Markdown pages shared by all your agents. Agents
save, list and read them with `artifact_save`, `artifact_list` and `artifact_get`, so a page one
provider made can be revised by another. Save a page an agent rendered in a thread with the
library button on the page. To bring in a claude.ai artifact, paste it or drop the file on
**Artifacts**. Open one to see its history, compare versions, restore an older one (it becomes a
new version), or **Send to agent**, which adds it to **Ask the team**. Deleted artifacts can be
restored from the **Deleted** view.
The library pages the loaded results; **Load older artifacts**, on the last page, fetches more.
Search is performed by the server.

**Canvas** is a board per project where you place artifacts, sections, memory entries and notes,
and connect them. A board holds up to 200 cards.
Use **Find a card** to locate an existing card and jump to its position without rearranging the
board. When adding existing content, choose artifacts, sections or memory to narrow the source.

**Infra** shows each connected machine's CPU, memory, disks and the busiest agent processes
while the tab is open. A disconnected machine offers **Reconnect**, which opens
**Settings → Connections**.
Choose a machine or search its projects to narrow the view; with a project focus, only the
machines that host or build it remain. Open the connection map when you need to see which
machines host or build a project.

## Workflows

A workflow is a reusable process of agent steps, skills, questions to you and checks, saved in the
project as `.t3/workflows/<slug>.json`, so it travels with the repo. Open **Workflows**, choose a
project (or set the focus) to open its library, and copy a built-in starter (Onboarding, Feature, Bugfix, Release notes, Weekly digest),
make a new one, or ask any agent to build one ("make a workflow that reviews a PR and writes
release notes"). Click a workflow to edit it on the canvas.
Search the library by title, description or identifier. Workflows, runs, skills, snippets and
deleted workflows have paged lists; starter workflows remain available separately.

Without a project focus, **Workflows** lists the runs of every project on your primary server:
runs waiting for you first, then running ones, then the rest, newest first, 10 per page. A
project's library lists its own runs the same way. **Load older runs**, on the last page, fetches
earlier ones. Click a run to open it in its project. The open run is part of the link, so a reload
or a shared link reopens it. A run whose project is no longer listed (removed, or its machine
offline) still opens from Home or the run list; **Back** returns to every project's runs.

Run one from its card, the **Run** button on a project card, the command palette, a shortcut you
set in the editor, or by typing `/wf <slug> [name=value]... [text]` in **Ask the team** or a
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

## Native mobile

On mobile, **Settings → Automations → Command Center** shows a read-only summary: team status,
what needs you, upcoming deliveries, and your artifacts to read. Its **Workflows** section starts
runs, follows their steps, answers waiting questions and checks, and stops, resumes or retries.
