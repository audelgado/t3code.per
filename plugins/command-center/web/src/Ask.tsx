import { Mic, Sparkles, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OrganizeDraft } from "../../server/organize.ts";
import { splitRequest } from "../../server/plan.ts";
import type { Profile } from "../../server/profiles.ts";
import type { MachineProjects, ModelSelection, ProviderInfo, TaskInput } from "../../server/types.ts";
import { insertAtCaret, useDictation } from "./dictation.ts";
import { call, refresh, useLive } from "./api.ts";
import { PRIORITIES, statusTone } from "./look.ts";
import { CoordinatorPicker, OrderingBanner, ReviewBanner, Segmented, useOrganize } from "./Organize.tsx";
import { draftSteps } from "./organizeFlow.ts";
import { Plan, toPlanSteps } from "./Plan.tsx";
import { Button } from "./ui/Button.tsx";
import { Sheet } from "./ui/Sheet.tsx";
import { Field, Select, Textarea, Input } from "./ui/fields.tsx";
import { ProjectDot } from "./ui/ProjectDot.tsx";

/** Lowest first, as in the design. */
const PRIORITY_ITEMS = [...PRIORITIES].reverse().map(([id, label]) => ({ id: id as number, label }));

/** Project value is "<machineId>:<projectId>"; machine ids contain no colon. */
const splitKey = (k: string) => {
  const i = k.indexOf(":");
  return { machineId: k.slice(0, i), projectId: k.slice(i + 1) };
};

function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: ReactNode }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-0.5 size-5 shrink-0 md:size-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted-fg">{hint}</span>}
      </span>
    </label>
  );
}

/** Global Pedir overlay. `project` preselects "<machineId>:<projectId>"; `autoDictate` starts dictation on open (phone mic button). */
export function Ask({ project, onClose, autoDictate }: { project: string | null; onClose: () => void; autoDictate: boolean }) {
  const { view } = useLive();
  const [groups, setGroups] = useState<MachineProjects[]>([]);
  const [key, setKey] = useState(project ?? "");
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(""); // index into `models`, "" = default
  const [priority, setPriority] = useState(0);
  const [deps, setDeps] = useState<string[]>([]);
  const [worktree, setWorktree] = useState(false);
  const [baseRef, setBaseRef] = useState("main");
  const [plan, setPlan] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [split, setSplit] = useState(false);
  /** The user's edit of the automatic split; null = follow the prompt. */
  const [edited, setEdited] = useState<string[] | null>(null);
  const [ordered, setOrdered] = useState(false);
  const [options, setOptions] = useState(false);
  /** The coordinator's draft under review. Null while the user writes their own text. */
  const [draft, setDraft] = useState<{ by: string; title: string; questions: string[] } | null>(null);
  /** What the form held before the draft replaced it ("Usar mi texto original"). */
  const before = useRef({ prompt: "", key: "", priority: 0, profileId: "" });
  const box = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call("GET /api/projects").then((g) => {
      setGroups(g);
      setKey((k) => k || (g.flatMap((m) => m.projects.map((p) => `${m.machineId}:${p.id}`))[0] ?? ""));
    }, (e) => setError(e instanceof Error ? e.message : "No se pudieron cargar los proyectos"));
  }, []);

  useEffect(() => {
    call("GET /api/profiles").then(setProfiles, () => {});
  }, []);

  const dictation = useDictation((text) => {
    const el = box.current;
    setPrompt((cur) => {
      const r = insertAtCaret(cur, el?.selectionStart ?? cur.length, el?.selectionEnd ?? cur.length, text);
      requestAnimationFrame(() => el?.setSelectionRange(r.caret, r.caret));
      return r.value;
    });
  });

  useEffect(() => {
    if (autoDictate && dictation.supported) dictation.start();
  }, []);

  const applyDraft = (d: OrganizeDraft, by: string) => {
    const steps = draftSteps(d);
    setDraft({ by, title: d.title, questions: d.questions });
    setPrompt(d.prompt);
    if (d.projectKey && groups.some((g) => g.projects.some((p) => `${g.machineId}:${p.id}` === d.projectKey))) setKey(d.projectKey);
    setPriority(Math.max(-2, Math.min(2, Math.round(d.priority))));
    setProfileId(d.profileId && profiles.some((p) => p.id === d.profileId) ? d.profileId : "");
    setSplit(steps.length > 0);
    setEdited(steps.length > 0 ? steps : null);
    setOrdered(steps.length > 0);
    setOptions(true);
  };
  const organize = useOrganize((d, c) => applyDraft(d, c.label));
  const ordering = organize.running !== null;

  const order = () => {
    dictation.stop();
    if (!draft) before.current = { prompt, key, priority, profileId };
    void organize.start(prompt.trim(), key);
  };

  const discardDraft = () => {
    const b = before.current;
    setDraft(null);
    setPrompt(b.prompt);
    setKey(b.key);
    setPriority(b.priority);
    setProfileId(b.profileId);
    setSplit(false);
    setEdited(null);
    organize.setError(null);
  };

  const machineId = key ? splitKey(key).machineId : "";
  useEffect(() => {
    setModel("");
    setProviders([]);
    if (machineId)
      call("GET /api/machines/:id/providers", { params: { id: machineId } }).then(setProviders, () => {});
  }, [machineId]);

  const models = useMemo(
    () =>
      providers
        .filter((p) => p.enabled && p.installed)
        .flatMap((p) =>
          p.models.map((m) => ({ label: `${p.displayName} · ${m.name}`, sel: { instanceId: p.instanceId, model: m.slug } as ModelSelection })),
        ),
    [providers],
  );

  const profile = profiles.find((p) => p.id === profileId);
  const steps = split ? (edited ?? splitRequest(prompt)) : [];
  const filled = steps.map((x) => x.trim()).filter(Boolean);
  const group = groups.find((g) => g.machineId === machineId);

  const submit = async () => {
    dictation.stop();
    const { machineId, projectId } = splitKey(key);
    // Left unset, a profile's own defaults apply; the server fills the rest.
    const body: TaskInput = {
      prompt: prompt.trim(),
      title: !split && draft?.title.trim() ? draft.title.trim() : undefined,
      machineId,
      projectId,
      model: model === "" ? null : (models[Number(model)]?.sel ?? null),
      runtimeMode: profile?.runtimeMode ? undefined : "full-access",
      interactionMode: plan ? "plan" : undefined,
      workspace: worktree ? { type: "worktree", baseRef: baseRef.trim() || "main" } : { type: "root" },
      priority,
      dependsOn: deps,
      profileId: profileId || undefined,
    };
    setBusy(true);
    setError(null);
    try {
      if (split) await call("POST /api/plans", { body: { ...body, request: prompt.trim(), steps: toPlanSteps(filled, ordered) } });
      else await call("POST /api/tasks", { body });
      void refresh();
      onClose();
      location.hash = "#work";
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo encolar la tarea");
    } finally {
      setBusy(false);
    }
  };

  const openDeps = view?.queue.filter((t) => !["pending_approval", "failed", "cancelled"].includes(t.status)) ?? [];
  const canOrder = !!prompt.trim() && !!organize.coordinator && !ordering;
  const link = group ? statusTone(group.status) : null;

  return (
    <Sheet
      title="Pedir"
      onClose={onClose}
      wide
      footer={
        <div className="flex items-center gap-3">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-fg">
            {group && link && (
              <>
                <span aria-hidden style={{ background: link.fg }} className="size-2 shrink-0 rounded-full" />
                <span className="truncate">
                  Se ejecuta en {group.machineLabel} · {link.label.toLowerCase()}
                </span>
              </>
            )}
          </span>
          <Button variant="primary" type="submit" form="ask-form" disabled={busy || ordering || !prompt.trim() || !key || (split && filled.length === 0)}>
            {busy ? "Encolando..." : split ? `Encolar ${filled.length} ${filled.length === 1 ? "tarea" : "tareas"}` : "Encolar"}
          </Button>
        </div>
      }
    >
      <form
        id="ask-form"
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {draft && !ordering && (
          <ReviewBanner label={draft.by} questions={draft.questions} busy={!canOrder} onRedo={order} onDiscard={discardDraft} />
        )}
        {draft && !split && (
          <Field label="Título">
            <Input value={draft.title} maxLength={120} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </Field>
        )}
        <div className="grid gap-1">
          {draft && <span className="text-xs font-medium text-muted-fg">Prompt optimizado</span>}
          <Textarea
            ref={box}
            aria-label="Pedido"
            value={prompt}
            readOnly={ordering}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) e.currentTarget.form?.requestSubmit();
            }}
            placeholder="¿Qué tiene que hacer el agente?"
            className="min-h-32 border-run bg-panel shadow-[0_0_0_3px_var(--run-bg)] focus-visible:outline-none"
            autoFocus
          />
          {dictation.interim && <p className="text-sm text-muted-fg italic">{dictation.interim}</p>}
          {dictation.error && (
            <p role="alert" className="text-sm text-need">
              {dictation.error}
            </p>
          )}
        </div>
        {ordering ? (
          <OrderingBanner label={organize.running!.label} onCancel={organize.cancel} />
        ) : (
          <div className="grid gap-2">
            <div className="flex gap-2">
              <Button
                variant={dictation.listening ? "primary" : "outline"}
                className="h-11 flex-1 md:h-[34px]"
                aria-pressed={dictation.listening}
                disabled={!dictation.supported}
                title={dictation.supported ? undefined : "Este navegador no soporta dictado"}
                onClick={dictation.listening ? dictation.stop : dictation.start}
              >
                {dictation.listening ? <Square className="size-4" aria-hidden /> : <Mic className="size-4" aria-hidden />}
                {dictation.listening ? "Detener" : "Dictar"}
              </Button>
              <Button className="h-11 flex-1 md:h-[34px]" disabled={!canOrder || busy} onClick={order}>
                <Sparkles className="size-4" aria-hidden />
                Ordenar con IA
              </Button>
            </div>
            {dictation.listening && (
              <p role="status" className="flex items-center gap-1.5 text-xs text-muted-fg">
                <span aria-hidden className="size-2 rounded-full bg-fail" />
                Escuchando… tocá Detener cuando termines.
              </p>
            )}
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-xs text-muted-fg">Coordinador</span>
              <CoordinatorPicker o={organize} className="flex-1" />
            </div>
            {organize.error && (
              <p role="alert" className="text-sm text-fail">
                {organize.error}
              </p>
            )}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Proyecto">
            <span className="relative block">
              {key && <ProjectDot projectKey={key} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2" />}
              <Select value={key} onChange={(e) => setKey(e.target.value)} required className={key ? "pl-8" : ""}>
                {groups.map((g) => (
                  <optgroup key={g.machineId} label={g.status === "online" ? g.machineLabel : `${g.machineLabel} (${statusTone(g.status).label.toLowerCase()})`}>
                    {g.projects.map((p) => (
                      <option key={p.id} value={`${g.machineId}:${p.id}`}>
                        {p.title}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </span>
          </Field>
          <Field label="Perfil">
            <Select value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={profiles.length === 0}>
              <option value="">Ninguno</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.avatar} {p.name}
                  {p.createdBy.startsWith("agent:") ? ` (de ${p.createdBy.slice(6)})` : ""}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {group && group.status !== "online" && <p className="text-sm text-need">Esta máquina no está en línea. La tarea esperará en la cola.</p>}
        <details open={options} onToggle={(e) => setOptions(e.currentTarget.open)} className="rounded-[10px] border border-line">
          <summary className="flex min-h-10 cursor-pointer items-center gap-2 px-3 text-sm font-medium select-none">
            Opciones
            <span className="text-xs font-normal text-muted-fg">prioridad, modelo, worktree, pasos</span>
          </summary>
          <div className="grid gap-3 border-t border-soft p-3">
            <div className="grid gap-1">
              <span className="text-xs font-medium text-muted-fg">Prioridad</span>
              <Segmented label="Prioridad" items={PRIORITY_ITEMS} value={priority} onChange={setPriority} />
            </div>
            <Field label="Modelo">
              <Select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">{profile?.model ? "El del perfil" : "Por defecto"}</option>
                {models.map((m, i) => (
                  <option key={m.sel.instanceId + m.sel.model} value={i}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid gap-2.5 md:grid-cols-2">
              <Check checked={worktree} onChange={setWorktree} label="Worktree nuevo" hint={worktree ? undefined : "Si no, trabaja en el directorio del proyecto"} />
              <Check checked={plan} onChange={setPlan} label="El agente planifica primero" />
              <Check
                checked={split}
                onChange={(v) => {
                  setSplit(v);
                  if (!v) setEdited(null);
                }}
                label="Dividir en pasos"
                hint={split ? `${filled.length} ${filled.length === 1 ? "tarea" : "tareas"}${ordered ? ", en orden" : ""}` : undefined}
              />
            </div>
            {worktree && (
              <Field label="Rama base">
                <Input value={baseRef} onChange={(e) => setBaseRef(e.target.value)} />
              </Field>
            )}
            {openDeps.length > 0 && (
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-xs font-medium text-muted-fg">Ejecutar después de…</legend>
                {openDeps.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-5 md:size-4"
                      checked={deps.includes(t.id)}
                      onChange={(e) => setDeps((d) => (e.target.checked ? [...d, t.id] : d.filter((x) => x !== t.id)))}
                    />
                    <span className="truncate">{t.title}</span>
                  </label>
                ))}
              </fieldset>
            )}
          </div>
        </details>
        {split && (
          <Plan
            steps={steps}
            ordered={ordered}
            edited={edited !== null}
            onSteps={setEdited}
            onOrdered={setOrdered}
            onReset={() => setEdited(null)}
          />
        )}
        {error && (
          <p role="alert" className="text-sm text-fail">
            {error}
          </p>
        )}
      </form>
    </Sheet>
  );
}
