import { AlertTriangle, ChevronLeft, Check, Play, Plus } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Api, ApiRoute, MachineProjects, RuntimeMode } from "../../server/types.ts";
import type { ImportResult, RunDetail, RunSummary, StepView, Workflow, WorkflowNode, WorkflowSummary } from "../../server/workflows.ts";
import { call, refresh, useLive } from "./api.ts";
import { matchesSearch } from "./homeQueueView.ts";
import { ago, RUNTIME_MODES, TONES } from "./look.ts";
import { hashes } from "./navigation.ts";
import { paginateCollection } from "./pagination.ts";
import { Button, LinkButton } from "./ui/Button.tsx";
import { Chip } from "./ui/Chip.tsx";
import { EmptyState, Field, Input, Select, Textarea } from "./ui/fields.tsx";
import { Pager } from "./ui/Pager.tsx";
import { Panel } from "./ui/Panel.tsx";
import { ProjectDot } from "./ui/ProjectDot.tsx";
import { Sheet } from "./ui/Sheet.tsx";
import { errorMessage, useProjectTitles } from "./workData.ts";
import { ErrorNote, ProjectTag } from "./workUi.tsx";
import {
  canCancel, canResume, describeNode, errorLines, KIND_LABEL, KIND_TONE, lastRunBySlug, newWorkflowText, nodeStates, nodeTitle, orderNodes, orderRuns, parseDraft, progress, RUN_LABEL, runInputs, runTone, STEP_LABEL, threadLinks, waitingStep,
  type NodeState,
} from "./workflowView.ts";

// The workflow routes join the Api contract by module augmentation in server/workflows.ts.
const api = call;

const LIBRARY_PAGE = 8;
const RUNS_PAGE = 5;
const key = (m: MachineProjects, id: string) => `${m.machineId}:${id}`;
const split = (k: string) => ({ machineId: k.slice(0, k.indexOf(":")), projectId: k.slice(k.indexOf(":") + 1) });
const by = (source: string) => (source === "user" ? "vos" : source.replace("agent:", ""));
const needsYou = (r: Pick<RunSummary, "status">) => r.status === "needs_you" || r.status === "pending_approval";

/** Flujos: library, runs and the run view. `runId` (a notification link or a row) opens a run. */
export function Workflows({ runId = null }: { runId?: string | null }) {
  return runId ? <RunView id={runId} /> : <FlowsHome />;
}

// ---- chain of steps ----

/** The workflow as pills: finished steps green, the current one in its status tone, the rest tinted by kind and faded. */
function Chain({ nodes, states }: { nodes: WorkflowNode[]; states?: Map<string, NodeState> }) {
  const started = !!states && [...states.values()].some((s) => s.status !== "pending");
  return (
    <ol className="flex flex-wrap items-center gap-1" aria-label="Pasos del flujo">
      {nodes.map((n, i) => {
        const status = states?.get(n.id)?.status ?? "pending";
        const done = status === "succeeded";
        const tone = status === "pending" ? KIND_TONE[n.kind] : runTone(status);
        return (
          <li key={n.id} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden className="text-xs text-muted-fg">›</span>}
            <Chip tone={tone} className={`h-5 font-medium ${started && status === "pending" ? "opacity-55" : ""}`}>
              {done && <Check className="size-3" aria-hidden />}
              {nodeTitle(n)}
            </Chip>
          </li>
        );
      })}
    </ol>
  );
}

// ---- run data ----

/** One run, reloaded with the live view; its actions keep the busy state and the error next to the run. */
function useRun(id: string) {
  const { view } = useLive();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<RuntimeMode>("auto-accept-edits");

  useEffect(() => {
    let live = true;
    api("GET /api/workflow-runs/:id", { params: { id } }).then(
      (d) => live && setDetail(d),
      (e) => live && setError(errorMessage(e)),
    );
    return () => void (live = false);
  }, [id, view]);

  async function act<R extends ApiRoute>(failure: string, route: R, body?: Api[R]["body"]) {
    setBusy(true);
    setError(null);
    try {
      setDetail((await api(route, { params: { id }, body })) as RunDetail);
      refresh();
    } catch (e) {
      setError(`${failure}. ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }
  return { detail, busy, error, mode, setMode, act };
}

function ModeSelect({ value, onChange }: { value: RuntimeMode; onChange: (m: RuntimeMode) => void }) {
  return (
    <Select aria-label="Permisos" value={value} onChange={(e) => onChange(e.target.value as RuntimeMode)}>
      {RUNTIME_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </Select>
  );
}

// ---- Flujos home ----

/** A run that waits on you: its steps, what it waits for, and the decision when it is an approval or a manual gate. */
function AttentionCard({ run }: { run: RunSummary }) {
  const titles = useProjectTitles();
  const { detail, busy, error, mode, setMode, act } = useRun(run.id);
  const projectKey = `${run.machineId}:${run.projectId}`;
  const wait = detail && waitingStep(detail.run.workflow, detail.steps);
  const approval = run.status === "pending_approval";
  const gate = wait && wait.node.kind === "gate" && wait.node.check === "manual";
  const ask = wait?.node.kind === "ask";
  return (
    <section className="grid gap-3 rounded-card border border-[#f3d9a6] bg-panel p-4">
      <div className="flex items-center gap-2">
        <ProjectTag projectKey={projectKey} name={titles.get(projectKey) ?? run.projectId} className="shrink-0 font-semibold text-fg" />
        <a href={hashes.run(run.id)} className="min-w-0 flex-1 truncate font-semibold">{run.title}</a>
        <Chip tone="need">{RUN_LABEL[run.status]}</Chip>
      </div>
      {detail && <Chain nodes={orderNodes(detail.run.workflow)} states={nodeStates(detail.run.workflow.nodes, detail.steps)} />}
      <p className="flex items-start gap-2 rounded-ctl bg-need-bg px-3 py-2 text-[13px] text-[#7c3d06]">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          {approval
            ? <><b>Un agente quiere ejecutar este flujo.</b> Elegí qué pueden hacer sus pasos y aprobá.</>
            : wait
              ? <><b>{ask ? "Pregunta" : "Compuerta"}: {nodeTitle(wait.node)}.</b> {describeNode(wait.node)}</>
              : "Esperando tu respuesta."}
          {" "}Iniciado por {by(run.source)} {ago(run.createdAt)}.
        </span>
      </p>
      {error && <ErrorNote>{error}</ErrorNote>}
      {approval && <ModeSelect value={mode} onChange={setMode} />}
      <div className="flex flex-wrap items-center gap-2">
        <LinkButton href={hashes.run(run.id)}>{ask ? "Responder" : "Ver ejecución"}</LinkButton>
        {(approval || gate) && (
          <>
            <Button variant="danger" disabled={busy || !detail} onClick={() => void (approval ? act("No se pudo rechazar", "POST /api/workflow-runs/:id/reject") : act("No se pudo rechazar", "POST /api/workflow-runs/:id/answer", { nodeId: wait!.node.id, approved: false }))}>Rechazar</Button>
            <Button variant="primary" disabled={busy || !detail} className="ml-auto" onClick={() => void (approval ? act("No se pudo aprobar", "POST /api/workflow-runs/:id/approve", { runtimeMode: mode }) : act("No se pudo aprobar", "POST /api/workflow-runs/:id/answer", { nodeId: wait!.node.id, approved: true }))}>Aprobar</Button>
          </>
        )}
      </div>
    </section>
  );
}

function FlowsHome() {
  const [list, setList] = useState<WorkflowSummary[] | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [editor, setEditor] = useState<string | null>(null);
  const [running, setRunning] = useState<WorkflowSummary | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [libraryPage, setLibraryPage] = useState(1);
  const [runsPage, setRunsPage] = useState(1);
  const titles = useProjectTitles();
  const { view } = useLive();

  // Reloads with the live view (SSE) instead of polling: a task change is what moves a run.
  const load = useCallback(() => {
    api("GET /api/workflows").then(setList, (e) => setError(errorMessage(e)));
    api("GET /api/workflow-runs").then(setRuns, () => {});
  }, []);
  useEffect(load, [load, view]);

  const last = lastRunBySlug(runs);
  const library = paginateCollection((list ?? []).filter((w) => matchesSearch(query, w.title, w.slug, w.description)), libraryPage, LIBRARY_PAGE);
  const ordered = orderRuns(runs).filter((r) => matchesSearch(query, r.title, r.slug, RUN_LABEL[r.status]));
  const attention = ordered.filter(needsYou);
  const recent = paginateCollection(ordered.filter((r) => !needsYou(r)), runsPage, RUNS_PAGE);

  const edit = async (slug: string) => {
    try {
      setEditor(JSON.stringify(await api("GET /api/workflows/:slug", { params: { slug } }), null, 2));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const remove = async (w: WorkflowSummary) => {
    if (!confirm(`¿Eliminar "${w.title}"? Las ejecuciones ya iniciadas conservan su copia.`)) return;
    try {
      await api("DELETE /api/workflows/:slug", { params: { slug: w.slug } });
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="grid gap-4">
      <Input type="search" aria-label="Buscar flujos y ejecuciones" placeholder="Buscar por título, slug, descripción o estado" className="md:w-[22rem]" value={query} onChange={(e) => { setQuery(e.target.value); setLibraryPage(1); setRunsPage(1); }} />
      {error && <ErrorNote>No se pudo cargar los flujos. {error}</ErrorNote>}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="grid gap-4 lg:order-2">
          {attention.map((r) => <AttentionCard key={r.id} run={r} />)}
          <Panel title="Ejecuciones recientes" count={runs.length}>
            {runs.length === 0 && <p className="px-4 py-6 text-center text-muted-fg">Nada por acá</p>}
            {runs.length > 0 && recent.total === 0 && <p className="px-4 py-6 text-center text-muted-fg">{attention.length ? "Nada más por acá" : "Ninguna ejecución coincide con la búsqueda"}</p>}
            {recent.items.map((r) => {
              const k = `${r.machineId}:${r.projectId}`;
              return (
                <a key={r.id} href={hashes.run(r.id)} className="flex items-center gap-3 px-4 py-3 active:bg-soft">
                  <ProjectDot projectKey={k} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{r.title}</span>
                    <span className="block truncate text-xs text-muted-fg">{titles.get(k) ?? r.projectId} · por {by(r.source)} · {ago(r.createdAt)}</span>
                  </span>
                  <Chip tone={runTone(r.status)}>{RUN_LABEL[r.status]}</Chip>
                </a>
              );
            })}
            {recent.pageCount > 1 && <div className="px-4 pb-3"><Pager page={recent} onPageChange={setRunsPage} label="Ejecuciones recientes" /></div>}
          </Panel>
        </div>

        <Panel
          className="lg:order-1"
          title="Biblioteca"
          count={list?.length}
          action={
            <span className="flex gap-1.5">
              <Button size="sm" onClick={() => setImporting(true)}>Importar</Button>
              <Button size="sm" onClick={() => setEditor(newWorkflowText("Nuevo flujo", new Set(list?.map((w) => w.slug))))}><Plus className="size-4" aria-hidden /> Nuevo</Button>
            </span>
          }
        >
          {list === null && !error && <p className="px-4 py-6 text-center text-muted-fg">Cargando…</p>}
          {list?.length === 0 && <div className="p-4"><EmptyState>Nada por acá. Creá un flujo o importalos desde un proyecto.</EmptyState></div>}
          {!!list?.length && library.total === 0 && <p className="px-4 py-6 text-center text-muted-fg">Ningún flujo coincide con la búsqueda</p>}
          {library.items.map((w) => {
            const r = last.get(w.slug);
            return (
              <div key={w.slug} className="flex items-start gap-3 px-4 py-3">
                <div className="grid min-w-0 flex-1 gap-1.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <b className="font-semibold">{w.title}</b>
                    <span className="font-mono text-xs text-muted-fg">{w.slug}</span>
                    <Chip tone="queue">{w.nodeCount} {w.nodeCount === 1 ? "paso" : "pasos"}</Chip>
                    {w.updatedBy !== "user" && <Chip tone="need">editado por {w.updatedBy.replace("agent:", "")}</Chip>}
                  </div>
                  {w.description && <p className="text-[13px] text-muted-fg">{w.description}</p>}
                  <p className="text-xs text-muted-fg">
                    {r ? <>Última ejecución: <span style={{ color: TONES[runTone(r.status)].fg }}>{RUN_LABEL[r.status]}</span> · {ago(r.createdAt)}</> : "Nunca se ejecutó"}
                  </p>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => void edit(w.slug)}>Editar</Button>
                    <Button size="sm" variant="ghost" className="text-fail" onClick={() => void remove(w)}>Eliminar</Button>
                  </div>
                </div>
                <Button size="sm" onClick={() => setRunning(w)}><Play className="size-3.5" aria-hidden /> Ejecutar</Button>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
            <span className="text-xs text-muted-fg">Editá como JSON · guardado en .t3/workflows</span>
            <Pager page={library} onPageChange={setLibraryPage} label="Biblioteca" />
          </div>
        </Panel>
      </div>

      {editor !== null && (
        <Editor
          initial={editor}
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
            location.hash = hashes.run(id);
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

// ---- dialogs ----

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
      setErrors(errorLines(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Editar flujo"
      wide
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <Button variant="primary" disabled={busy} onClick={() => void save()}>Guardar</Button>
          <Button onClick={onClose}>Cancelar</Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <p className="text-xs text-muted-fg">Guardar con un slug existente reemplaza ese flujo. Pasos: agent, skill, ask, parallel, gate.</p>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="JSON del flujo" className="min-h-72 font-mono text-xs" aria-invalid={errors.length > 0} />
        {errors.length > 0 && (
          <ul role="alert" className="grid gap-1 rounded-ctl bg-fail-bg px-3 py-2 text-[13px] text-[#7f1d1d]">
            {errors.map((l) => <li key={l}>{l}</li>)}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

function useProjects() {
  const [groups, setGroups] = useState<MachineProjects[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call("GET /api/projects").then(setGroups, (e) => setError(errorMessage(e)));
  }, []);
  return { groups, error, first: groups.flatMap((m) => m.projects.map((p) => key(m, p.id)))[0] ?? "" };
}

function ProjectSelect({ groups, value, onChange }: { groups: MachineProjects[]; value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Proyecto">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {groups.map((m) => (
          <optgroup key={m.machineId} label={m.machineLabel}>
            {m.projects.map((p) => <option key={p.id} value={key(m, p.id)}>{p.title}</option>)}
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
  const [error, setError] = useState<string | null>(null);
  const chosen = project || first;
  const { inputs, missing } = runInputs(workflow.inputs, values);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { run } = await api("POST /api/workflow-runs", { body: { slug: workflow.slug, ...split(chosen), inputs, runtimeMode: mode } });
      onStarted(run.id);
    } catch (e) {
      setError(`No se pudo iniciar. ${errorMessage(e)}`);
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={`Ejecutar ${workflow.title}`}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <Button variant="primary" type="submit" form="run-form" disabled={busy || !chosen || missing.length > 0}>Iniciar</Button>
          <Button onClick={onClose}>Cancelar</Button>
        </div>
      }
    >
      <form id="run-form" className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <ProjectSelect groups={groups} value={chosen} onChange={setProject} />
        {workflow.inputs.map((i) => (
          <Field key={i.name} label={i.default ? `${i.label} (opcional)` : i.label}>
            <Input value={values[i.name] ?? ""} placeholder={i.default} onChange={(e) => setValues((v) => ({ ...v, [i.name]: e.target.value }))} />
          </Field>
        ))}
        <Field label="Permisos">
          <ModeSelect value={mode} onChange={setMode} />
        </Field>
        {(error ?? loadError) && <ErrorNote>{error ?? `No se pudo cargar los proyectos. ${loadError}`}</ErrorNote>}
        {missing.length > 0 && <p className="text-xs text-muted-fg">Completá: {missing.join(", ")}</p>}
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
      setError(`No se pudo importar. ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title="Importar desde un proyecto"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <Button variant="primary" disabled={busy || !chosen} onClick={() => void run()}>Importar</Button>
          <Button onClick={onClose}>Cerrar</Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <p className="text-xs text-muted-fg">Importa cada .t3/workflows/*.json del proyecto. Un flujo con el mismo slug se reemplaza.</p>
        <ProjectSelect groups={groups} value={chosen} onChange={setProject} />
        {(error ?? loadError) && <ErrorNote>{error ?? `No se pudo cargar los proyectos. ${loadError}`}</ErrorNote>}
        {result && (
          <div className="grid gap-1">
            <p>
              Importados {result.imported.length}
              {result.imported.length > 0 && `: ${result.imported.join(", ")}`}
            </p>
            {result.errors.map((f) => (
              <div key={f.file} className="text-fail">
                <p className="font-mono text-xs">{f.file}</p>
                {f.errors.map((l) => <p key={l}>{l}</p>)}
              </div>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}

// ---- run view ----

function RunView({ id }: { id: string }) {
  const { view } = useLive();
  const titles = useProjectTitles();
  const { detail, busy, error, mode, setMode, act } = useRun(id);

  const back = (
    <a href={hashes.page("flows")} className="inline-flex items-center gap-0.5 justify-self-start text-sm text-primary">
      <ChevronLeft className="size-4" aria-hidden /> Flujos
    </a>
  );
  if (!detail) return <div className="grid gap-3">{back}{error ? <ErrorNote>No se pudo cargar la ejecución. {error}</ErrorNote> : <p className="text-muted-fg">Cargando…</p>}</div>;

  const { run, steps } = detail;
  const states = nodeStates(run.workflow.nodes, steps);
  const machine = view?.machines.find((m) => m.id === run.machineId);
  const projectKey = `${run.machineId}:${run.projectId}`;

  return (
    <div className="grid gap-4">
      {back}
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <ProjectTag projectKey={projectKey} name={titles.get(projectKey) ?? run.projectId} className="font-semibold text-fg" />
          <Chip tone={runTone(run.status)}>{RUN_LABEL[run.status]}</Chip>
        </div>
        <h2 className="text-xl font-semibold break-words">{run.title}</h2>
        <p className="text-[13px] text-muted-fg">
          {progress(run.workflow, steps)} · {ago(run.createdAt)}
          {run.source !== "user" && ` · iniciada por ${by(run.source)}`}
        </p>
        <Chain nodes={orderNodes(run.workflow)} states={states} />
        {run.error && <p className="text-[13px] text-fail">{run.error}</p>}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}

      {run.status === "pending_approval" && (
        <section className="grid gap-3 rounded-card border border-[#f3d9a6] bg-panel p-4">
          <p>Un agente quiere ejecutar este flujo. Elegí qué pueden hacer sus pasos y aprobá.</p>
          <ModeSelect value={mode} onChange={setMode} />
          <div className="flex gap-2">
            <Button variant="danger" disabled={busy} onClick={() => void act("No se pudo rechazar", "POST /api/workflow-runs/:id/reject")}>Rechazar</Button>
            <Button variant="primary" disabled={busy} onClick={() => void act("No se pudo aprobar", "POST /api/workflow-runs/:id/approve", { runtimeMode: mode })}>Aprobar</Button>
          </div>
        </section>
      )}

      <Panel title="Pasos" count={run.workflow.nodes.length}>
        {orderNodes(run.workflow).map((node) => {
          const st = states.get(node.id)!;
          return (
            <div key={node.id} className="grid gap-2 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-semibold">{nodeTitle(node)}</span>
                <Chip tone={KIND_TONE[node.kind]}>{KIND_LABEL[node.kind]}</Chip>
                <Chip tone={runTone(st.status)}>{STEP_LABEL[st.status]}</Chip>
              </div>
              <p className="truncate text-xs text-muted-fg">{describeNode(node)}</p>
              {st.steps.map((s) => (
                <StepRow key={s.id} step={s} node={node} machine={machine} busy={busy} onAnswer={(b) => void act("No se pudo enviar la respuesta", "POST /api/workflow-runs/:id/answer", { nodeId: node.id, ...b })} />
              ))}
            </div>
          );
        })}
      </Panel>

      <div className="flex gap-2">
        {canCancel(run.status) && (
          <Button variant="danger" disabled={busy} onClick={() => confirm("¿Detener esta ejecución? Los pasos en curso se interrumpen.") && void act("No se pudo detener", "POST /api/workflow-runs/:id/cancel")}>Detener</Button>
        )}
        {canResume(run.status) && <Button variant="primary" disabled={busy} onClick={() => void act("No se pudo reanudar", "POST /api/workflow-runs/:id/resume")}>Reanudar</Button>}
      </div>
    </div>
  );
}

function StepRow({ step, node, machine, busy, onAnswer }: { step: StepView; node: WorkflowNode; machine: { id: string; webUrl: string | null } | undefined; busy: boolean; onAnswer: (b: { answer?: string; approved?: boolean }) => void }): ReactNode {
  const [text, setText] = useState("");
  const links = machine && step.threadId ? threadLinks(machine, step.threadId) : null;
  const waiting = step.status === "waiting" && step.item === null;
  const hasBody = step.item !== null || step.error || step.output || waiting || links;
  if (!hasBody) return null;
  return (
    <div className="grid gap-2 border-t border-soft pt-2 first:border-t-0 first:pt-0">
      {step.item !== null && (
        <p className="text-xs text-muted-fg">
          Elemento {step.item + 1} · <span style={{ color: TONES[runTone(step.status)].fg }}>{STEP_LABEL[step.status]}</span>
        </p>
      )}
      {step.error && <p className="text-[13px] text-fail">{step.error}</p>}
      {step.output && <p className="max-h-40 overflow-y-auto text-xs break-words whitespace-pre-wrap text-muted-fg">{step.output}</p>}
      {waiting && node.kind === "ask" && (
        <div className="grid gap-2">
          <p>{node.question}</p>
          {node.choices ? (
            <div className="flex flex-wrap gap-2">
              {node.choices.map((c) => <Button key={c} size="sm" disabled={busy} onClick={() => onAnswer({ answer: c })}>{c}</Button>)}
            </div>
          ) : (
            <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); onAnswer({ answer: text }); }}>
              <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} aria-label="Tu respuesta" className="min-h-20" />
              <Button variant="primary" type="submit" disabled={busy || !text.trim()}>Responder</Button>
            </form>
          )}
        </div>
      )}
      {waiting && node.kind === "gate" && node.check === "manual" && (
        <div className="flex gap-2">
          <Button variant="primary" size="sm" disabled={busy} onClick={() => onAnswer({ approved: true })}>Aprobar</Button>
          <Button variant="danger" size="sm" disabled={busy} onClick={() => onAnswer({ approved: false })}>Rechazar</Button>
        </div>
      )}
      {links && (
        <div className="flex gap-2">
          <LinkButton size="sm" href={links.appUrl}>Abrir en T3</LinkButton>
          {links.webUrl && <LinkButton size="sm" variant="ghost" href={links.webUrl} target="_blank" rel="noreferrer">Web</LinkButton>}
        </div>
      )}
    </div>
  );
}
