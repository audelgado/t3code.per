import { Mic, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { splitRequest } from "../../server/plan.ts";
import type { Profile } from "../../server/profiles.ts";
import type { MachineProjects, ModelSelection, ProviderInfo, TaskInput } from "../../server/types.ts";
import { insertAtCaret, useDictation } from "./dictation.ts";
import { call, refresh, useLive } from "./api.ts";
import { Plan, toPlanSteps } from "./Plan.tsx";
import { Button } from "./ui/Button.tsx";
import { Field, Select, Textarea, Input } from "./ui/fields.tsx";

const priorities = [
  [2, "Urgent"],
  [1, "High"],
  [0, "Normal"],
  [-1, "Low"],
  [-2, "Lowest"],
] as const;

/** Project value is "<machineId>:<projectId>"; machine ids contain no colon. */
const splitKey = (k: string) => {
  const i = k.indexOf(":");
  return { machineId: k.slice(0, i), projectId: k.slice(i + 1) };
};

export function Ask({ project }: { project: string | null }) {
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
  const box = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call("GET /api/projects").then((g) => {
      setGroups(g);
      setKey((k) => k || (g.flatMap((m) => m.projects.map((p) => `${m.machineId}:${p.id}`))[0] ?? ""));
    }, (e) => setError(e instanceof Error ? e.message : "Could not load projects"));
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

  const submit = async () => {
    dictation.stop();
    const { machineId, projectId } = splitKey(key);
    // Left unset, a profile's own defaults apply; the server fills the rest.
    const body: TaskInput = {
      prompt: prompt.trim(),
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
      setPrompt("");
      setEdited(null);
      setDeps([]);
      void refresh();
      location.hash = "#queue";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not queue the task");
    } finally {
      setBusy(false);
    }
  };

  const openDeps = view?.queue.filter((t) => !["pending_approval", "failed", "cancelled"].includes(t.status)) ?? [];

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h1 className="text-xl font-semibold">Ask</h1>
      <div className="grid gap-1">
        <Textarea
          ref={box}
          aria-label="Prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the agent do?"
          autoFocus
        />
        {dictation.interim && <p className="text-muted-fg italic">{dictation.interim}</p>}
        {dictation.error && (
          <p role="alert" className="text-warn">
            {dictation.error}
          </p>
        )}
        {dictation.supported && (
          <Button
            variant={dictation.listening ? "primary" : "outline"}
            aria-pressed={dictation.listening}
            onClick={dictation.listening ? dictation.stop : dictation.start}
          >
            {dictation.listening ? <Square className="size-4" aria-hidden /> : <Mic className="size-4" aria-hidden />}
            {dictation.listening ? "Stop dictation" : "Dictate"}
          </Button>
        )}
      </div>
      {profiles.length > 0 && (
        <Field label="Profile">
          <Select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            <option value="">None</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.avatar} {p.name}
                {p.createdBy.startsWith("agent:") ? ` (by ${p.createdBy.slice(6)})` : ""}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Project">
        <Select value={key} onChange={(e) => setKey(e.target.value)} required>
          {groups.map((g) => (
            <optgroup key={g.machineId} label={g.status === "online" ? g.machineLabel : `${g.machineLabel} (${g.status})`}>
              {g.projects.map((p) => (
                <option key={p.id} value={`${g.machineId}:${p.id}`}>
                  {p.title}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      {groups.some((g) => g.machineId === machineId && g.status !== "online") && (
        <p className="text-warn">This machine is not online. The task will wait in the queue.</p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Model">
          <Select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">{profile?.model ? "Profile default" : "Default"}</option>
            {models.map((m, i) => (
              <option key={m.sel.instanceId + m.sel.model} value={i}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
            {priorities.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid gap-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} className="size-5" />
          New worktree
        </label>
        {worktree && (
          <Field label="Base branch">
            <Input value={baseRef} onChange={(e) => setBaseRef(e.target.value)} />
          </Field>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={plan} onChange={(e) => setPlan(e.target.checked)} className="size-5" />
          Agent plans first
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} className="size-5" />
          Split into steps
        </label>
      </div>
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
      {openDeps.length > 0 && (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-xs font-medium text-muted-fg">Run after</legend>
          {openDeps.map((t) => (
            <label key={t.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-5"
                checked={deps.includes(t.id)}
                onChange={(e) => setDeps((d) => (e.target.checked ? [...d, t.id] : d.filter((x) => x !== t.id)))}
              />
              <span className="truncate">{t.title}</span>
            </label>
          ))}
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-bad">
          {error}
        </p>
      )}
      <Button variant="primary" type="submit" disabled={busy || !prompt.trim() || !key || (split && filled.length === 0)}>
        {busy ? "Queuing..." : split ? `Queue ${filled.length} ${filled.length === 1 ? "task" : "tasks"}` : "Queue task"}
      </Button>
    </form>
  );
}
