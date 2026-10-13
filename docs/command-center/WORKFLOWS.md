# Workflows (Command Center, wave 5)

Build, see, edit and call reusable processes made of agents, skills and
human checkpoints. Works with every provider, not only Claude.

## What T3 already has (reuse, do not rebuild)

- **Skills discovery** per provider and workspace: Claude reads
  `<cwd>/.claude/skills`, Codex and Antigravity read `<cwd>/.agents/skills`
  (`apps/server/src/provider/Drivers/ClaudeSkills.ts`, `AntigravitySkills.ts`,
  `ServerProviderSkill` in `packages/contracts/src/server.ts`). Skills are
  `SKILL.md` folders, same format for all.
- **Claude Code workflow runs** are already rendered (phases, agents,
  `getWorkflowScript`, `stopWorkflow` in `orchestrationV2.ts`,
  `ThreadRelationshipsControl.tsx`). Those stay as they are; T3 workflows are
  the provider-neutral layer above.
- `delegate_task`, agent profiles and teams (Command Center), worktrees,
  scheduled tasks, pending-input (questions to the user), MCP.

## Model

A workflow is a **file in the repo**: `.t3/workflows/<slug>.json`. Files are
versioned with git, shareable between machines and readable by agents. The
DB only keeps runs. No blobs in SQLite.

```
Workflow   { slug, title, description, inputs: [{name, label, default?}],
             nodes: Node[], edges: [{from, to}], layout: {nodeId: {x, y}} }
Node kinds
  agent    { profile (agent profile id or inline provider+model), prompt,
             skills: string[], worktree: bool, outputs: "memory"|"artifact"|"text" }
  skill    { skill: name, args }            — runs one skill in a cheap agent
  ask      { question, choices? }           — pauses for you (pending input)
  parallel { over: input or previous output list, node }   — fan-out
  gate     { check: "tests"|"typecheck"|"manual" }          — must pass to continue
```

A step hands on its short result (the reply, clipped to 2,000 characters),
never its transcript. The next prompt gets the results of the steps it follows;
results before an `ask` or `gate` come along too, oldest first, up to 8,000
characters. `outputs: "memory"` also saves the result as a `handoff` memory
entry (on the Command Center home machine only).

Runs: `cc_workflow_runs` (the workflow as it started, inputs, status, and
`mode_limit`, the broadest modes its threads may use) and `cc_workflow_steps`
(one row per node, item and attempt: thread, status, short output, error, and
`items`, the full list a later `parallel` node fans out over). Both live in
`apps/server/src/commandCenter/schema.ts`.

## Runner

`WorkflowRunner` service (in `apps/server/src/commandCenter/`): starts the
nodes whose inputs are ready, launches each `agent` node as a normal T3
thread (profile provider/model, worktree when set), and advances when the
thread settles, by listening to the thread events the server already emits.
No polling, no LLM in the runner itself. Stop, retry a step, and resume a run
are first-class (reverse states), and so is answering a waiting `ask` or
manual `gate` (`commandCenter.answerWorkflowStep`, MCP `workflow_answer`,
`t3 wf answer`).

- A run started by an agent (MCP) or a scheduled task never runs threads
  broader than its caller's runtime and interaction modes; the limit is stored
  on the run and applies to retries and resumes.
- Each worktree step gets its own branch, `wf/<slug>-<node>[-<item>][-a<attempt>]-<run>`.
- A built-in starter runs without being saved to the project first.
- After a restart (or when `commandCenter.enabled` turns on) the runner follows
  running steps again and launches what was due.

## Visual editor

Workflows view in Command Center:

- **Library:** cards per workflow with title, inputs, last run, and a Run
  button.
- **Editor:** canvas with nodes and edges (SVG edges, drag with the installed
  `@dnd-kit`), side panel to edit the selected node (prompt, profile, skills,
  options) or, with nothing selected, the workflow and its keyboard shortcut.
  Saves to the JSON file (Ctrl/Cmd+S works from any field); external edits to
  the file reload, or ask first when there are unsaved edits.
- **Run view:** the same graph colored by step status, click a node to open
  its thread or diff, answer a waiting step, or retry. Static rendering, no
  continuous animation.
- **Skills** and **Snippets** sections list the project's own; delete moves
  them to `.t3/workflows/.trash/{skills,snippets}` with Undo.

## Text optimization

Every prompt and skill shows an estimated token count. An "Optimize" action
first applies free deterministic cleanup (whitespace, duplicated
instructions, moving shared text into reusable **snippets** referenced as
`{{snippet:name}}`). "Rewrite shorter" asks the project's text generation
model (`commandCenter.rewriteText`, a `rewriteText` op on every provider's text
generation; ACP registry providers do not support it) and shows a diff before
anything changes; a rewrite that drops a placeholder or is not shorter is
refused. Snippets live in `.t3/workflows/snippets/*.md`.

## Agents create workflows, subagents and skills

New MCP tools in the commandCenter toolkit:

- `workflow_list`, `workflow_get`, `workflow_save` (validates the graph),
  `workflow_run`, `workflow_answer`, `workflow_status`.
- `skill_create` / `skill_update`: writes `SKILL.md` to `.agents/skills/<name>`
  and mirrors it to `.claude/skills/<name>` so every provider sees it.
- `agent_profile_save`: creates or edits Command Center agent profiles
  (subagents).

So you can say "create a workflow that reviews a PR, runs tests and writes
the release notes" in any thread, and the agent builds the workflow, the
skills and the profiles it needs, then shows the result in the editor.

## Calling a workflow

- Orchestrator bar: `/wf <slug> [inputs]` with autocomplete.
- Composer slash command in any thread.
- Command palette, and a shortcut per workflow (`workflow.<slug>.run`, set in
  the editor).
- Run button in the library and on a project card.
- A scheduled task whose prompt is `/wf <slug> [name=value]... [text]` runs the
  workflow instead of starting a thread (unbound tasks only).
- CLI `t3 wf list|run|status|answer`, and MCP `workflow_run` for agents.

## Built-in starters

Onboarding (from SPEC), Feature (plan, build in worktree, tests gate, review,
PR), Bugfix, Release notes, Weekly project digest.

## Tests

Graph validation, runner advancing and settling (drain the effect worker, no
sleeps), retry and stop, snippet expansion, skill mirroring.
