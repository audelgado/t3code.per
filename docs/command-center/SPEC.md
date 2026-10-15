# Command Center (v3)

A control panel inside T3 for running several client projects with agent teams
spread across machines (local PC and VPSs). Visual first, cheap to look at:
viewing never spends tokens; only agents doing work do.

Fork-only feature (branch `feat/command-center`). Design reference: mockup v3.1
(`https://claude.ai/artifact/A1gL8NrjRtt4duAfMtry1p`). UI copy is Spanish in the
mockup; ship English strings like the rest of T3.

Follow `AGENTS.md`: services own logic, everything on the wire lives in
`packages/contracts`, RPC handlers and MCP tools decode, call one service
method, and map errors.

## Where the data lives

Command Center rows live in the **primary environment** (the server the
client treats as local). Remote machines are ordinary T3 environments the
client is already connected to. The client joins Command Center data with the
thread shells it already streams from every environment. No new cross-server
protocol.

## Surface

Full page at `/command` (file route `apps/web/src/routes/_chat.command.tsx`,
template `_chat.pull-requests.tsx`), sidebar entry next to Pull requests
(`components/sidebar/SidebarChrome.tsx`). Tab in `?tab=`. Components under
`apps/web/src/components/commandCenter/`.

Desktop uses one shared header row. Below `sm`, Home and Work use Today, Done, Work,
Route and More with a separate scroll area above the Ask bar and safe-area-aware navigation.

- Nine tabs (`commandCenter/tabs.ts`): **Home** (default), **Work**, **Team**, **Projects**, **Infra**,
  **Finance**, **Artifacts**, **Canvas**, **Workflows**. Work and the last three load lazily. Each tab
  is an icon with its label from `lg`; below `lg` only the open tab keeps its label, since
  tooltips are mouse-only. The description is the tooltip. The strip scrolls
  sideways at every width instead of turning into a select. The first visible tab opens when
  the URL names none.
- **Project focus**: `?project=<projectId>` on every tab, so a reload or a shared link keeps it;
  a searchable picker (icon only below `sm`) with a clear button sets it; the clear button also
  shows when no project is loaded, so a link to a missing project can be cleared. It filters
  and never dims: Team lists the agents working on it, Infra the machines that host or build
  it, Finance its costs and ranking row, Artifacts its artifacts. In Projects it is the open detail. Canvas
  and Workflows open that project; without one, Canvas shows a picker and Workflows lists every
  project's runs. Ask the team, `onboard` and Home's "Add todo" use it.
- **Launch**: a menu with every quick action and a link to edit them; Home's "More" opens it.
- **Ask the team** (the orchestrator, the one delegation verb in the UI): folded so it does
  not push the tab down; `/` opens and focuses it, and the draft survives navigation. One
  input + target machine (`Auto` or an environment); work goes to the project focus, which the
  bar names. `?ask=<text>` (a prompt quick action from the command palette) is appended to the
  draft once and dropped from the URL. Submit opens the plan drawer (see Delegation). Text starting with `remember:` / `recordá:` / `guardá:` is saved
  straight to memory without any agent.
- The page's top bar keeps **Hide amounts** (eye button, key `H`, blurs every money value,
  persisted per viewer in localStorage), **Memory** (the memory drawer) and **Customize**.
- **Customize** opens Settings → Command Center. It renames, reorders and hides tabs, and
  edits up to 20 quick actions (open a tab, open an http(s) link or an app path such as
  `/usage` with one leading slash, or prepare an instruction you review before submitting). Both live in the primary server's settings
  (`commandCenter.sections`, `commandCenter.quickActions`), so every web and desktop client
  sees the same panel; mobile keeps its fixed summary. A tab missing from saved settings (Home
  for layouts saved before it existed) is inserted after its canonical predecessor. A hidden
  tab keeps its data and still opens from a link or quick action; at least one tab stays
  visible.
- Keys, outside text fields: `/` Ask the team, `H` Hide amounts, `M` Memory, `1`–`8` pinned
  projects on Home. `g` then `h/w/p/t/i/f/a/c/o` selects a tab; brackets rotate Work.
  `commandCenter.open` defaults to `mod+alt+o` (`!terminalFocus`) and does
  nothing while Command Center is off.
- Command palette: one entry per visible tab (the first carries `commandCenter.open`), per valid
  quick action and per pinned project (at most 8, pin order). Groups are not listed. Nothing is
  listed while Command Center is off. On `/command`, tab, section and prompt entries keep the
  project focus (a prompt also keeps the tab), like the in-page controls. The palette hook
  imports only pure modules (`customization.ts`, `paletteItems.ts`, `tabs.ts`), since the
  palette ships in the startup bundle.

Lists: no unbounded list. Every collection is paged (`paginateCollection` with
`CollectionPager`) or capped as "N + view all". A list fed by server pages (Memory,
Artifacts) offers **Load older** only on its last loaded page; Artifacts pages the client at
the server's page size, so each loaded page is one full client page. Loaded older pages keep
the rows shown when they were fetched, so a new artifact does not reset the page or drop them.
Workflow runs show 10 per page, waiting first, then queued or running, then the rest, newest
first; the live feed holds the newest 50 (a run outside a full feed is not added, so it stays the
newest 50 with no gap) and **Load older runs** pages the rest with `before`. A run a newer one
pushes out of the feed stays listed ahead of the older pages.

### Home

The default tab. It reads the Command Center snapshot, the thread shells the client already
streams and the primary server's run feed for every project (`commandCenterWorkflowRunsLive`,
open only while Home or Team is mounted), and a block with nothing to show is not rendered.

- **Now**: Working, Needs you, Active work and Owed (`financeSummary`, masked by Hide amounts).
  Static charts derive from already streamed shells; completion buckets count each thread's
  latest visible finished run, without fetching full histories or VCS status.
- **Needs you**: `deriveAttention` (`client-runtime/state/commandCenterDerive.ts`), 5 per page.
  Threads on any machine with an approval, a question or a ready plan, not archived, and
  snoozed ones only once they raise their hand (`effectiveSnoozed`), in the inbox's return
  order (`sortInboxThreadsByReturn`). Then workflow runs waiting for an answer, newest first
  (**Open run** focuses the run's project in Workflows; a waiting run older than the feed's
  newest 50 is not listed). Then alerts (offline host, working agent silent 30 min,
  delivery due within 2 days under 70%), then interview questions, blocked sections and
  overdue income, newest first. Idle agents and unmet dependencies are not listed (project
  health shows dependencies). Approvals and questions are answered inline, one at a time, and
  the open answer stays on its page; blocked sections have **Resolved**.
- **Pinned**: up to 8 pinned projects in manual order, opened with `1`–`8` or their cards.
- **Todos**: the 5 newest open todos across every project (interview questions excluded; the
  block title counts them) with a check, "Add todo" and "Open in Memory", which opens Memory
  on todos from every project, done ones included.
- **Launch**: four built-in actions and up to four custom quick actions, with More for the rest.
- With no projects, attention, todos or quick actions: "Import projects" (`/welcome`) and "Add
  quick action".

### Work and phone

Work groups thread shells by environment, project and checkout. Four project lanes per page
share at most 20 checkout subscriptions, with remote status on the focused checkout only.
Unknown or mismatched checkout status never authorizes Push, Update or Close. Close/Reopen
and Tidy's Remove/Restore retain partial progress for repair during the session. Branch deletion
and new core Git APIs remain out of scope; hygiene shows facts available through existing calls.

Phone Done fetches summaries for visible rows only, at most 20 per environment request,
from stored final replies and checkpoint statistics. It never starts an agent or subscribes to
whole thread projections. Inline answers reuse the normal pending-request flow.

Auto routes only to an explicitly selected project's environment with a working provider;
sharing a remote is not project identity. Manual project order is server-shared, while sort,
collapse and density stay local. Browser dictation is capability-gated and stops when hidden
or unmounted; Electron uses system dictation instead.

### Team

- Orchestrator card on top, one column per machine (environment) with its
  teams. Each agent row: avatar with status ring, name, role, provider/model,
  current task, project, elapsed. Status is derived from the linked thread
  shell (`OrchestrationV2ThreadShell`: `status`, `activityRunStatus`,
  `pendingRuntimeRequest`, `lastError`, `usageLimitResetAt`): working, waiting
  on you, blocked/failed, limited, idle.
- Static SVG wires: orchestrator to each team, team to team handoffs (dashed,
  labeled). No continuous animation. Drawn only at `xl` width and up, with at
  most 3 machine columns; team-to-team wires also need one page of teams, no
  search and All machines. The Handoffs list always stays.
- Attention is listed on Home only; Team shows how many items need you, with a link to
  Home.
- With a project focus, only agents working on it now; teams without one drop out and the
  wires are not drawn.
- Agent drawer: open thread, stop, release, move to another machine.

### Projects

The launcher for every T3 project: a paged directory beside one detail card.

- One row per T3 project (`<environmentId>:<projectId>`). Clones of one repository are never
  merged: they can differ in machine, branch and state, and merging hid that.
- Pins, user-defined groups and a site link live in the primary settings
  (`commandCenter.projects`, at most 200 customized projects, and
  `commandCenter.projectGroups`, at most 50). An entry back at its defaults is dropped, and each
  write drops entries of projects gone from a machine whose project list is live, so removed
  projects never hold the cap. Every way in has a way out: Pin/Unpin, Move to group/Remove from
  group, Link site/Clear link, and deleting a group only ungroups its projects and offers Undo.
  The whole array is replaced on write, so two devices changing pins at the same moment can
  overwrite each other (accepted).
- Order: pinned first, then the chosen sort; the default is recent activity (the latest thread
  the sidebar lists, unarchived and not a subagent child, by its "updated" order). Group chips
  with counts filter the directory; checkboxes and **Select page** feed the bulk group actions.
  Every project picker in the panel, the plan drawer included, lists pinned projects first.
- **Add project** opens the core add-project palette; **Import from Claude Code / Codex** opens
  `/welcome`. Both also show in the empty state.
- The open detail is the project focus (`?tab=projects&project=<projectId>`), so a reload keeps
  it and other tabs follow it. The directory itself is not narrowed by the focus. A link to a
  project that is not loaded shows "not available" with Close details; it is never cleared on its
  own, since the machine may still be connecting. With no detail open, a filter that leaves one
  row opens it once.
- KPIs: sections in progress, to review, blocked, next delivery. **No money.**
- Delivery strip for the next 5 weeks, one row per project on the current page, today marker.
- Detail card: progress, active agents (6 badges + "+N"), **"Where we left off"** (latest
  memory progress entry + open todos, 5 per page), recurring scheduled tasks (5 per page),
  sections. Each section: status (`todo | in_progress | review | blocked | done`), what is
  being tried, what is missing, tasks done/total, due date, blocker text. Launch actions: Open
  latest thread, New thread, Open site, Pull requests (scoped to the project), Project
  settings.
- "Ask the team" on a project opens the plan drawer with its open missing items and todos as
  steps.

### Infra

- Topology diagram: one node per environment (local, each VPS) with link type
  (local, LAN, Tailscale, T3 Connect), connection state and latency.
- Per node: CPU, RAM, disk gauges plus a short sparkline built client-side
  from `subscribeResourceTelemetry` (ring buffer, subscribed only while the
  tab is visible), agents running there, top processes from
  `serverGetProcessDiagnostics`, and which projects live there.
- Lines from projects to the machines that host or build them.

### Finance

Separate from projects: billing is per client, not per project.

- KPIs: income this month, fixed costs per month, result, owed (with overdue
  count).
- 6-month income vs costs bar chart (CSS bars, no chart library).
- Cost to maintain each project: each recurring cost lists the projects it
  supports and is split evenly between them.
- Income list (concept, client, date, amount, status `pending | paid |
overdue`, click cycles status) with quick add.
- Recurring costs list (concept, category, monthly amount, projects) with add
  and remove.

### Memory drawer

Timeline of memory entries, filter by project and kind, search, mark todos
done, add entry. This is how you know where things stand after a break.

## Memory

Entries: `progress` (where we left off), `decision`, `todo` (open/done),
`handoff` (team to team note, also drawn on the Team map), `note`.
Source: `user | agent | system`. Optional project, thread, and section.

Agents reach memory through MCP so "save this to memory" works from any
thread:

- `memory_save` (kind, text, project?, section?) — tool description tells the
  agent to call it when the user asks to save/remember something or its task
  instructions say to (delegated steps do). Ordinary threads are not told to
  save on every task, so memory costs no tokens unless asked for.
- `memory_recall` (project?) — returns where we left off: latest progress,
  open todos, recent decisions and handoffs, each text clipped to 600
  characters.
- `memory_complete` (id) — close a todo.

Memory lives on one machine, the Command Center home: the one where a client
opened the full Command Center (or that already has teams or agents). The
tools refuse on any other machine, because their writes would land in a store
no client reads. A step delegated to another machine gets the latest handoffs
in its prompt and is told to end its reply with a "Handoff:" paragraph
instead.

## Delegation

One orchestrator. MVP keeps planning deterministic and free:

1. The bar splits the request into steps (commas, "and"; an ordered "and
   then" / "y luego" stays one step), guesses a team per step from keywords,
   and opens the plan drawer.
2. You edit steps, team, machine and section, then confirm.
3. Steps start together, not in sequence. For each step the client picks an
   idle agent of that team (a team with no idle agent blocks the step) and
   creates a thread on the target environment through the existing
   thread-creation command, with the agent profile's provider, model and
   modes, and a prompt made of role prompt + step + latest handoffs + memory
   instructions. Projects with a Git remote default to a worktree per step
   (`cc/<agent>-<task>-<id>` branch from the checkout's HEAD). It then records
   the assignment in the primary environment; an agent has at most one open
   assignment, so recording a new one finishes the previous one.

An LLM-backed orchestrator (an agent that plans using the MCP tools) comes
later; the data model does not change for it.

## Data model (SQLite, `cc_*` tables)

The tables are not T3 migrations. `commandCenter/schema.ts` creates them
idempotently when the service starts (and upgrades older fork databases), so
upstream can keep adding numbered migrations without colliding with this fork.
`cc_meta` holds the `home` marker.

```
cc_agent_profiles  id, name, avatar, role, role_prompt, provider_instance_id,
                   model_selection (json), runtime_mode, interaction_mode,
                   team_id NULL, sort_key, created_at, updated_at, archived_at
cc_teams           id, name, color, lead_agent_id NULL, environment_id NULL,
                   sort_key, created_at, updated_at, archived_at
cc_assignments     id, agent_id, environment_id, thread_id, project_id,
                   section_id NULL, task, created_at, finished_at NULL
cc_sections        id, project_id, name, status, tasks_done, tasks_total,
                   due_date NULL, trying NULL, blocker NULL, missing (json),
                   depends_on (json section ids), pr_url NULL, pr_number NULL,
                   sort_key, created_at, updated_at
cc_memory          id, project_id NULL, section_id NULL, thread_id NULL, kind,
                   text, done, source, created_at, updated_at
cc_income          id, concept, client_name, date, amount_cents, currency, status,
                   created_at, updated_at
cc_costs           id, concept, category, monthly_cents, currency,
                   project_ids (json), created_at, updated_at, archived_at
cc_artifacts       id, project_id NULL, title, kind (html|markdown),
                   current_version, source_thread_id NULL, created_at,
                   updated_at, archived_at
cc_artifact_versions artifact_id, version, author, author_label NULL,
                   thread_id NULL, attachment_id, size_bytes, created_at
cc_canvas_items    id, project_id, kind (artifact|section|memory|note), ref_id
                   NULL, text NULL, x, y, w NULL, h NULL, created_at, updated_at
cc_canvas_edges    id, project_id, from_item_id, to_item_id, label NULL,
                   created_at, updated_at
cc_workflow_runs   id, slug, title, project_id, environment_id, status, inputs
                   (json), workflow (json, as started), mode_limit (json) NULL,
                   error NULL, started_at, finished_at NULL, updated_at
cc_workflow_steps  id, run_id, node_id, item NULL, attempt, thread_id NULL,
                   status, output NULL, error NULL, items (json) NULL,
                   started_at NULL, finished_at NULL, updated_at
```

Workflow, snippet and skill files live in the project (`.t3/workflows`,
`.agents/skills`, `.claude/skills`), not in SQLite; see
[WORKFLOWS.md](WORKFLOWS.md).

## Server

`apps/server/src/commandCenter/CommandCenterService.ts`: CRUD for every table
above, `getSnapshot`, and a change stream. RPCs in `packages/contracts/src/rpc.ts`
following scheduled tasks (`ScheduledTaskService.ts`, `ws.ts`): one
`subscribeCommandCenter` stream (snapshot then changes) plus mutations through
`createEnvironmentRpcCommand`, scopes in `CLIENT_GUARDED_RPC_SCOPES` (reads
`orchestration:read`, writes `orchestration:operate`).

MCP toolkit `apps/server/src/mcp/toolkits/commandCenter/` (memory tools above
plus `section_list`, `section_update`), registered in `McpHttpServer.ts`.

## Keep it light (hard rules)

The feature must not slow down or clutter the rest of T3.

- **Isolated:** only `cc_*` tables, code in `commandCenter/` folders. Edits to
  shared files are registration lines only. No columns added to existing T3
  tables, no changes to orchestration events.
- **Zero cost when unused:** the `/command` route is code-split
  (`autoCodeSplitting`), nothing subscribes until the page is open, and the
  server does no work without subscribers. A setting `commandCenter.enabled`
  (default on) hides the sidebar entry and rejects the stream when off.
- **Small wire:** one snapshot, then per-row deltas. Snapshot caps: memory 100
  newest (older pages via a `listMemory(before, limit)` RPC), finished
  assignments 50, income last 13 months. Telemetry only while Infra is
  visible.
- **Small DB:** indexes only for the queries we run (see
  `commandCenter/schema.ts`).
  Finished assignments older than 90 days and done todos older than 180 days
  are pruned by a daily tick.
- **No new dependencies.** CSS/SVG for charts.

## Wave 2 (approved 2026-10-13, built right after the MVP)

Trimmed for weight: section dependencies are a `depends_on` JSON column on
`cc_sections` (no extra table); routing uses the team's `environment_id` (no
rules table); token usage per project is **dropped** (needs new per-agent
instrumentation, too heavy for now).

1. Cross-project dependencies: a section can wait on a section of another
   project; shown on the map and in project health.
2. Handoffs as data: a finished step writes a `handoff` memory entry that the
   next thread started on that project gets in its prompt.
3. Project health light from due date vs progress, blockers and idle time.
4. Routing rules: project or team to machine, used by `Auto`.
5. Zero-token daily digest: a deterministic "where we left off" built from
   the day's events, saved as a `progress` entry.
6. Alerts: machine offline, agent stuck for N minutes, delivery in 48h under
   70% done. Thresholds live in `team/teamLogic.ts` (`STUCK_AFTER_MINUTES`,
   `DELIVERY_ALERT_DAYS`, `AT_RISK_PERCENT`) and are computed client-side from
   data already on the page.
7. ~~Token usage per agent/project feeding Finance costs.~~ Dropped for now.
8. CLI (`t3 memory`, `t3 cc`) and mobile screens. The CLI talks to the running
   server over the same RPCs as the web client; there is no offline mode.

Wave 2 notes: alerts, digest and pruning share one daily/hourly `Scheduler`
source inside the service and never call an LLM; mobile gets one
read-only summary screen (Team status, What's missing, deliveries) in
`apps/mobile`.

## Onboarding team (wave 2)

A built-in preset team that maps any repo, old or new, into Command Center so
you can delegate "onboard this project" in one click ("Onboard" on a project
card, or `onboard` in **Ask the team**).

1. **Pre-scan, 0 tokens.** `CommandCenterService.buildRepoDigest(projectId)`
   collects, without an LLM: file tree (depth-limited, ignored dirs skipped),
   languages, manifests (package.json scripts, etc.), README headings, git
   stats (age, last commits, active branches), `TODO|FIXME|HACK` lines with
   file:line, and open GitHub issues when `gh` is available. Capped at a few
   KB and saved as a `note` memory entry.
2. **Scout** (cheap model): reads the digest plus only the files it points at;
   saves `progress` memory: stack, how to run, structure, current state.
3. **Organizer** (cheap model): turns TODOs, issues and recent work into
   sections and todos via MCP (`section_create`, `memory_save`), deduped
   against what already exists.
4. **Interviewer**: lists the gaps the system needs (client, deliveries and
   dates, priorities, which machine, billing client) and asks you through the
   normal T3 "awaiting input" flow, so the questions appear in Home's Needs you.
   Answers are saved to memory and sections.

New repo (empty or near-empty): order is Interviewer, then Organizer, Scout
skipped. Re-running onboarding only adds what is new. Steps hand off with
`handoff` memory entries. The preset is ordinary agent profiles + a team, so
you can edit prompts and models.

New MCP tools: `project_digest` (returns the cached digest), `section_create`.

## Wave 3: hardening (approved 2026-10-13)

Goal: fully working, no known gaps. Development token cost is not a
constraint; the token budget that matters is the user's at runtime.

- Delegated steps run in their own worktree (existing worktree flow) so two
  steps on one machine never share files; reverse: from the agent drawer,
  open the diff, run the thread's Git quick action (commit, push, open a PR;
  publishing and pulling hand off to the thread view), or discard the thread
  with its worktree. There is no local merge in T3; merging goes through the
  PR.
- Restore archived teams, agents and costs from the UI.
- Infra: disk fields in host resources and connection round-trip time.
- Needs you: answer agent questions inline (the existing pending-input
  response path), not only "open thread".
- Adversarial review per area, then fixes, then one real web client pass
  (`test-t3-app`) by the primary agent.

## Wave 4: shared artifacts and T3 integration (approved 2026-10-13)

T3's `html_render` / `html_preview` pages used to be stuck in the thread that
made them. Wave 4 keeps them in a shared, versioned library
(`commandCenter/ArtifactsService.ts`).

- **Storage:** each version is a file in the server's attachments directory
  named `cc-artifact-<uuid>-html|md`; SQLite holds metadata only. A thumbnail
  is captured by the existing headless browser on first request and cached
  next to it as `cc-artifact-<uuid>.webp` (written to `.part`, then renamed).
- **Versions are append-only.** Restore saves the old content as a new
  version; delete archives (`archived_at`) and the Deleted view restores.
- **Reads stay small.** `artifact get` returns content only for Markdown unless
  `includeContent` is set; HTML loads by attachment id. The list subscription
  pushes one page of rows, never content.
- **Agents (MCP):** `artifact_save`, `artifact_list`, `artifact_get`.
  `artifact_get` replaces inline images (`data:` URIs) with
  `data:t3-inline/<n>` placeholders and pages long pages by `offset`
  (60k characters per call); `artifact_save` puts the placeholders back from
  the current version and inlines local images like `html_render`. A step on a
  machine that cannot reach the primary server gets referenced artifacts
  inlined in its prompt instead.
- **Canvas:** cards (artifacts, sections, memory, notes) and edges per project.
  Drags send positions-only moves batched for 400 ms; undo re-saves the full
  rows. The server enforces 200 cards per project. The board re-reads its
  canvas when any artifact changes (a one-row live list), only while visible.
- **Integrations:** a section links one pull request (`pr_url`/`pr_number`)
  and shows its live state; a project card lists its recurring scheduled tasks
  and opens Settings to create or edit them; Preview opens the project's dev
  server in the browser panel beside its latest thread; an agent's View
  changes opens its worktree's branch diff, or its latest turn in a shared
  checkout. HTML renders in a thread have Save to Artifacts.
- **claude.ai artifacts:** there is no public API to sync them. Import by
  pasting or dropping the file, or `t3 cc artifacts save`.

## Wave 5: workflows (approved 2026-10-13)

Design and behavior: [WORKFLOWS.md](WORKFLOWS.md). Services in
`apps/server/src/commandCenter/`: `WorkflowStore` (files, snippets, trash),
`SkillWriter`, `WorkflowRunner`, `TextRewriter`.

- **RPCs:** Command Center's RPCs are their own group (`CommandCenterRpcGroup`,
  merged into `WsRpcGroup`) so the server's handler layers stay under the type
  checker's budget. Reading workflow files, snippets and skills needs
  `filesystem:read`; writing or trashing them needs `filesystem:write`;
  starting, stopping, retrying, resuming, answering runs and Rewrite shorter
  need `orchestration:operate`; starters and run reads stay on
  `orchestration:read`.
- **MCP:** `workflow_list`, `workflow_get`, `workflow_save`, `workflow_run`,
  `workflow_answer`, `workflow_status`, `skill_create`, `skill_update`,
  `agent_profile_save`. Saving workflows and skills needs a default
  (full-access) caller; runs and profiles never go broader than the caller's
  modes.
- **Runs list:** a project's library lists its runs; without a project focus the tab lists every
  project's runs on the primary server only (`commandCenterWorkflowRunsLive` with no project,
  paused while the window is hidden). Remote machines' runs show in their project's library.
- **Scheduled tasks:** a `/wf <slug> ...` prompt runs the workflow through
  `ScheduledTaskPromptRoutes`, within the task's modes.
- **CLI:** `t3 wf list`, `t3 wf run <slug> --input name=value`,
  `t3 wf status <runId>`, `t3 wf answer <runId> <step> [answer] [--approve|--reject]`.

## Not in this round

LLM orchestrator, automatic dispatch loop.

## Tests

Focused `vp test run <files>`: service CRUD, snapshot/stream, memory recall
ordering, cost split math, delegation step parsing. No sleeps.
