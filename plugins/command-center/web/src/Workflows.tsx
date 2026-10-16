import { useCallback, useEffect, useState } from "react";
import type { Api, ApiRoute, MachineProjects, RuntimeMode } from "../../server/types.ts";
import type { ImportResult, RunDetail, RunSummary, StepView, Workflow, WorkflowNode, WorkflowSummary } from "../../server/workflows.ts";
import { call, refresh, useLive } from "./api.ts";
import { matchesSearch } from "./homeQueueView.ts";
import { paginateCollection } from "./pagination.ts";
import { Pager } from "./ui/Pager.tsx";
import { Button, LinkButton } from "./ui/Button.tsx";
import { Sheet } from "./ui/Sheet.tsx";
import { ago, cn } from "./ui/cn.ts";
import { Badge, Card, Empty, Field, Input, Section, Select, Textarea } from "./ui/fields.tsx";
import {
  canCancel, canResume, describeNode, errorLines, KIND_LABEL, lastRunBySlug, newWorkflowText, nodeStates, nodeTitle, orderNodes, orderRuns, parseDraft, progress, RUN_LABEL, runInputs, STEP_LABEL, threadLinks, tone,
} from "./workflowView.ts";

// The workflow routes join the Api contract by module augmentation in server/workflows.ts.
const api = call;

const MODES: [RuntimeMode, string][] = [
  ["approval-required", "Ask before every action"],
  ["auto-accept-edits", "Auto-accept edits"],
  ["auto", "Auto"],
  ["full-access", "Full access"],
];
const msg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");
const key = (m: MachineProjects, id: string) => `${m.machineId}:${id}`;
const split = (k: string) => ({ machineId: k.slice(0, k.indexOf(":")), projectId: k.slice(k.indexOf(":") + 1) });

/** Workflow library, runs, and the run view. `runId` opens a run (e.g. from a notification link). */
export function Workflows({ runId = null }: { runId?: string | null }) {
  const [open, setOpen] = useState<string | null>(runId);
  const [list, setList] = useState<WorkflowSummary[] | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [editor, setEditor] = useState<{ text: string; isNew: boolean } | null>(null);
  const [running, setRunning] = useState<WorkflowSummary | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [libraryPage, setLibraryPage] = useState(1);
  const [runsPage, setRunsPage] = useState(1);
  const [librarySize, setLibrarySize] = useState(10);
  const { view } = useLive();

  // Reloads with the live view (SSE) instead of polling: a task change is what moves a run.
  const load = useCallback(() => {
    api("GET /api/workflows").then(setList, (e) => setError(msg(e)));
    api("GET /api/workflow-runs").then(setRuns, () => {});
  }, []);
  useEffect(load, [load, view]);

  if (open) return <RunView id={open} onBack={() => setOpen(null)} />;

  const last = lastRunBySlug(runs);
  const library = paginateCollection((list ?? []).filter((w) => matchesSearch(query, w.title, w.slug, w.description)), libraryPage, librarySize);
  const recent = paginateCollection(orderRuns(runs).filter((r) => matchesSearch(query, r.title, r.slug, RUN_LABEL[r.status])), runsPage, 5);
  const edit = async (slug: string) => {
    try {
      setEditor({ text: JSON.stringify(await api("GET /api/workflows/:slug", { params: { slug } }), null, 2), isNew: false });
    } catch (e) {
      setError(msg(e));
    }
  };
  const remove = async (w: WorkflowSummary) => {
    if (!confirm(`Delete "${w.title}"? Runs already started keep their copy.`)) return;
    try {
      await api("DELETE /api/workflows/:slug", { params: { slug: w.slug } });
      load();
    } catch (e) {
      setError(msg(e));
    }
  };

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <h1 className="flex-1 text-xl font-semibold">Workflows</h1>
        <Button size="sm" onClick={() => setImporting(true)}>
          Import
        </Button>
        <Button size="sm" variant="primary" onClick={() => setEditor({ text: newWorkflowText("New workflow", new Set(list?.map((w) => w.slug))), isNew: true })}>
          New
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-bad">
          {error}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Search workflows and runs"><Input type="search" value={query} placeholder="Title, slug, description or run status…" onChange={(e) => { setQuery(e.target.value); setLibraryPage(1); setRunsPage(1); }} /></Field>
        <Field label="Workflows per page"><Select value={librarySize} onChange={(e) => { setLibrarySize(Number(e.target.value)); setLibraryPage(1); }}>
          {[10, 20, 50].map((n) => <option key={n} value={n}>{n}</option>)}
        </Select></Field>
      </div>
      {query && <div><Button size="sm" variant="ghost" onClick={() => { setQuery(""); setLibraryPage(1); setRunsPage(1); }}>Clear search</Button></div>}
      <Section title="Library" count={list?.length}>
        {list === null && !error && <p className="text-muted-fg">Loading...</p>}
        {list?.length === 0 && <Empty>No workflows yet. Create one or import them from a project.</Empty>}
        {list !== null && <p className="text-xs text-muted-fg">{library.total} of {list.length} loaded workflows match.</p>}
        {!!list?.length && library.total === 0 && <Empty>No workflows match this search.</Empty>}
        <div className="grid items-start gap-3 xl:grid-cols-2">
          {library.items.map((w) => {
            const r = last.get(w.slug);
            return (
              <Card key={w.slug} className="grid gap-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{w.title}</span>
                  {w.updatedBy !== "user" && <Badge className="shrink-0 text-warn">edited by {w.updatedBy.replace("agent:", "")}</Badge>}
                  <Badge className="shrink-0">{w.nodeCount} steps</Badge>
                </div>
                {w.description && <p className="text-muted-fg">{w.description}</p>}
                <p className="text-xs text-muted-fg">
                  {r ? (
                    <>
                      Last run <span className={tone(r.status)}>{RUN_LABEL[r.status]}</span> · {ago(r.createdAt)}
                    </>
                  ) : (
                    "Never run"
                  )}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => setRunning(w)}>
                    Run
                  </Button>
                  <Button size="sm" onClick={() => void edit(w.slug)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void remove(w)}>
                    Delete
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
        <Pager page={library} onPageChange={setLibraryPage} label="Library" />
      </Section>

      <Section title="Recent runs" count={runs.length}>
        {runs.length === 0 && <Empty>No runs yet.</Empty>}
        <p className="text-xs text-muted-fg">{recent.total} of {runs.length} loaded runs match.</p>
        {runs.length > 0 && recent.total === 0 && <Empty>No runs match this search.</Empty>}
        {recent.items.map((r) => (
          <button key={r.id} type="button" onClick={() => setOpen(r.id)} className="text-left">
            <Card className="flex items-center gap-2 active:bg-accent">
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
              <span className={cn("shrink-0 text-xs", tone(r.status))}>{RUN_LABEL[r.status]}</span>
              <span className="shrink-0 text-xs text-muted-fg">{ago(r.createdAt)}</span>
            </Card>
          </button>
        ))}
        <Pager page={recent} onPageChange={setRunsPage} label="Recent runs" />
      </Section>

      {editor && (
        <Editor
          initial={editor.text}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            load();
          }}
        />
      )}
      {running && (
        <RunDialog
          workflow={running}
          onClose={() => setRunning(null)}
          onStarted={(id) => {
            setRunning(null);
            refresh();
            setOpen(id);
          }}
        />
      )}
      {importing && (
        <ImportDialog
          onClose={() => {
            setImporting(false);
            load();
          }}
        />
      )}
    </div>
  );
}

/** JSON editor. The server is the validator: its 400 lists every problem, one per line. */
function Editor({ initial, onClose, onSaved }: { initial: string; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(initial);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function save() {
    const parsed = parseDraft(text);
    if ("error" in parsed) return setErrors([parsed.error]);
    setBusy(true);
    try {
      await api("POST /api/workflows", { body: parsed.value as Workflow });
      onSaved();
    } catch (e) {
      setErrors(errorLines(msg(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Edit workflow" onClose={onClose}>
      <div className="grid gap-3">
        <p className="text-xs text-muted-fg">Saving with an existing slug replaces that workflow. Steps: agent, skill, ask, parallel, gate.</p>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          aria-label="Workflow JSON"
          className="min-h-72 font-mono text-xs"
          aria-invalid={errors.length > 0}
        />
        {errors.length > 0 && (
          <ul role="alert" className="grid gap-1 text-bad">
            {errors.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
        <div className="flex gap-2">
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            Save
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Sheet>
  );
}

function useProjects() {
  const [groups, setGroups] = useState<MachineProjects[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call("GET /api/projects").then(setGroups, (e) => setError(msg(e)));
  }, []);
  return { groups, error, first: groups.flatMap((m) => m.projects.map((p) => key(m, p.id)))[0] ?? "" };
}

function ProjectSelect({ groups, value, onChange }: { groups: MachineProjects[]; value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Project">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {groups.map((m) => (
          <optgroup key={m.machineId} label={m.machineLabel}>
            {m.projects.map((p) => (
              <option key={p.id} value={key(m, p.id)}>
                {p.title}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
    </Field>
  );
}

function RunDialog({ workflow, onClose, onStarted }: { workflow: WorkflowSummary; onClose: () => void; onStarted: (runId: string) => void }) {
  const { groups, error: loadError, first } = useProjects();
  const [project, setProject] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<RuntimeMode>("full-access");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(loadError);
  const chosen = project || first;
  const { inputs, missing } = runInputs(workflow.inputs, values);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { run } = await api("POST /api/workflow-runs", { body: { slug: workflow.slug, ...split(chosen), inputs, runtimeMode: mode } });
      onStarted(run.id);
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  }

  return (
    <Sheet title={`Run ${workflow.title}`} onClose={onClose}>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <ProjectSelect groups={groups} value={chosen} onChange={setProject} />
        {workflow.inputs.map((i) => (
          <Field key={i.name} label={i.default ? `${i.label} (optional)` : i.label}>
            <Input value={values[i.name] ?? ""} placeholder={i.default} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))} />
          </Field>
        ))}
        <Field label="Permissions">
          <Select value={mode} onChange={(e) => setMode(e.target.value as RuntimeMode)}>
            {MODES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        {error && (
          <p role="alert" className="text-bad">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="primary" type="submit" disabled={busy || !chosen || missing.length > 0}>
            Start
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
        {missing.length > 0 && <p className="text-xs text-muted-fg">Fill in: {missing.join(", ")}</p>}
      </form>
    </Sheet>
  );
}

/** Reads a project's .t3/workflows/*.json through T3 (needs the token's filesystem:read scope). */
function ImportDialog({ onClose }: { onClose: () => void }) {
  const { groups, error: loadError, first } = useProjects();
  const [project, setProject] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = project || first;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await api("POST /api/workflows/import", { body: split(chosen) }));
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Import from a project" onClose={onClose}>
      <div className="grid gap-3">
        <p className="text-xs text-muted-fg">Imports every .t3/workflows/*.json in the project. A workflow with the same slug is replaced.</p>
        <ProjectSelect groups={groups} value={chosen} onChange={setProject} />
        {(error ?? loadError) && (
          <p role="alert" className="text-bad">
            {error ?? loadError}
          </p>
        )}
        {result && (
          <div className="grid gap-1">
            <p>
              Imported {result.imported.length}
              {result.imported.length > 0 && `: ${result.imported.join(", ")}`}
            </p>
            {result.errors.map((f) => (
              <div key={f.file} className="text-bad">
                <p className="font-mono text-xs">{f.file}</p>
                {f.errors.map((l) => (
                  <p key={l}>{l}</p>
                ))}
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="primary" disabled={busy || !chosen} onClick={() => void run()}>
            Import
          </Button>
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Sheet>
  );
}

// ---- run view ----

function RunView({ id, onBack }: { id: string; onBack: () => void }) {
  const { view } = useLive();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<RuntimeMode>("auto-accept-edits");

  useEffect(() => {
    let live = true;
    api("GET /api/workflow-runs/:id", { params: { id } }).then(
      (d) => live && setDetail(d),
      (e) => live && setError(msg(e)),
    );
    return () => void (live = false);
  }, [id, view]);

  async function act<R extends ApiRoute>(route: R, body?: Api[R]["body"]) {
    setBusy(true);
    setError(null);
    try {
      setDetail((await api(route, { params: { id }, body })) as RunDetail);
      refresh();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  const back = (
    <button type="button" onClick={onBack} className="justify-self-start text-sm text-muted-fg">
      Workflows
    </button>
  );
  if (!detail) return <div className="grid gap-3">{back}{error ? <p className="text-bad">{error}</p> : <p className="text-muted-fg">Loading...</p>}</div>;

  const { run, steps } = detail;
  const states = nodeStates(run.workflow.nodes, steps);
  const machine = view?.machines.find((m) => m.id === run.machineId);

  return (
    <div className="grid gap-4">
      {back}
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold break-words">{run.title}</h1>
        <p className="text-muted-fg">
          <span className={tone(run.status)}>{RUN_LABEL[run.status]}</span> · {progress(run.workflow, steps)} · {ago(run.createdAt)}
          {run.source !== "user" && ` · started by ${run.source.replace("agent:", "")}`}
        </p>
        {run.error && <p className="text-bad">{run.error}</p>}
      </div>
      {error && (
        <p role="alert" className="text-bad">
          {error}
        </p>
      )}

      {run.status === "pending_approval" && (
        <Card className="grid gap-3">
          <p>An agent wants to run this workflow. Choose what its steps may do, then approve.</p>
          <Select aria-label="Permissions" value={mode} onChange={(e) => setMode(e.target.value as RuntimeMode)}>
            {MODES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void act("POST /api/workflow-runs/:id/approve", { runtimeMode: mode })}>
              Approve
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void act("POST /api/workflow-runs/:id/reject")}>
              Reject
            </Button>
          </div>
        </Card>
      )}

      <ol className="grid gap-2">
        {orderNodes(run.workflow).map((node) => {
          const st = states.get(node.id)!;
          return (
            <Card key={node.id} className="grid gap-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{nodeTitle(node)}</span>
                <Badge className="shrink-0">{KIND_LABEL[node.kind]}</Badge>
                <span className={cn("shrink-0 text-xs", tone(st.status))}>{STEP_LABEL[st.status]}</span>
              </div>
              <p className="truncate text-xs text-muted-fg">{describeNode(node)}</p>
              {st.steps.map((s) => (
                <StepRow key={s.id} step={s} node={node} machine={machine} busy={busy} onAnswer={(b) => void act("POST /api/workflow-runs/:id/answer", { nodeId: node.id, ...b })} />
              ))}
            </Card>
          );
        })}
      </ol>

      <div className="flex gap-2">
        {canCancel(run.status) && (
          <Button variant="danger" disabled={busy} onClick={() => confirm("Stop this run? Running steps are interrupted.") && void act("POST /api/workflow-runs/:id/cancel")}>
            Stop run
          </Button>
        )}
        {canResume(run.status) && (
          <Button variant="primary" disabled={busy} onClick={() => void act("POST /api/workflow-runs/:id/resume")}>
            Resume
          </Button>
        )}
      </div>
    </div>
  );
}

function StepRow({ step, node, machine, busy, onAnswer }: { step: StepView; node: WorkflowNode; machine: { id: string; webUrl: string | null } | undefined; busy: boolean; onAnswer: (b: { answer?: string; approved?: boolean }) => void }) {
  const [text, setText] = useState("");
  const links = machine && step.threadId ? threadLinks(machine, step.threadId) : null;
  const waiting = step.status === "waiting" && step.item === null;
  return (
    <li className="grid gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0">
      {step.item !== null && (
        <p className="text-xs text-muted-fg">
          Item {step.item + 1} · <span className={tone(step.status)}>{STEP_LABEL[step.status]}</span>
        </p>
      )}
      {step.error && <p className="text-bad">{step.error}</p>}
      {step.output && <p className="max-h-40 overflow-y-auto text-xs break-words whitespace-pre-wrap text-muted-fg">{step.output}</p>}
      {waiting && node.kind === "ask" && (
        <div className="grid gap-2">
          <p>{node.question}</p>
          {node.choices ? (
            <div className="flex flex-wrap gap-2">
              {node.choices.map((c) => (
                <Button key={c} size="sm" disabled={busy} onClick={() => onAnswer({ answer: c })}>
                  {c}
                </Button>
              ))}
            </div>
          ) : (
            <form
              className="grid gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                onAnswer({ answer: text });
              }}
            >
              <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} aria-label="Your answer" className="min-h-20" />
              <Button variant="primary" type="submit" disabled={busy || !text.trim()}>
                Answer
              </Button>
            </form>
          )}
        </div>
      )}
      {waiting && node.kind === "gate" && node.check === "manual" && (
        <div className="flex gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => onAnswer({ approved: true })}>
            Approve
          </Button>
          <Button variant="danger" size="sm" disabled={busy} onClick={() => onAnswer({ approved: false })}>
            Reject
          </Button>
        </div>
      )}
      {links && (
        <div className="flex gap-2">
          <LinkButton size="sm" href={links.appUrl}>
            Open in T3
          </LinkButton>
          {links.webUrl && (
            <LinkButton size="sm" variant="ghost" href={links.webUrl} target="_blank" rel="noreferrer">
              Web
            </LinkButton>
          )}
        </div>
      )}
    </li>
  );
}
