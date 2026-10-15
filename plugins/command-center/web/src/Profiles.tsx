import { useEffect, useState } from "react";
import type { InteractionMode, ModelSelection, RuntimeMode } from "../../server/types.ts";
import type { Profile, ProfileInput } from "../../server/profiles.ts";
import { call } from "./api.ts";
import { Button } from "./ui/Button.tsx";
import { Badge, Card, Empty, Field, Input, Select, Textarea } from "./ui/fields.tsx";

const runtimeModes: [RuntimeMode, string][] = [
  ["approval-required", "Ask before every action"],
  ["auto-accept-edits", "Auto-accept edits"],
  ["auto", "Auto"],
  ["full-access", "Full access"],
];

interface ModelOption {
  label: string;
  sel: ModelSelection;
}

/** Every enabled model on every machine, once per instance and slug. */
async function loadModels(): Promise<ModelOption[]> {
  const machines = await call("GET /api/machines");
  const lists = await Promise.all(machines.map((m) => call("GET /api/machines/:id/providers", { params: { id: m.id } }).catch(() => [])));
  const seen = new Map<string, ModelOption>();
  for (const p of lists.flat())
    if (p.enabled && p.installed)
      for (const m of p.models) seen.set(`${p.instanceId}\0${m.slug}`, { label: `${p.displayName} · ${m.name}`, sel: { instanceId: p.instanceId, model: m.slug } });
  return [...seen.values()];
}

const key = (m: ModelSelection) => `${m.instanceId}\0${m.model}`;
const blank: ProfileInput = { name: "", avatar: "", rolePrompt: "", model: null, runtimeMode: null, interactionMode: null };

function Form({ initial, models, busy, onSave, onCancel }: { initial: ProfileInput; models: ModelOption[]; busy: boolean; onSave(p: ProfileInput): void; onCancel(): void }) {
  const [p, setP] = useState(initial);
  const patch = (x: Partial<ProfileInput>) => setP((cur) => ({ ...cur, ...x }));
  // A saved model that no machine lists now stays selectable instead of silently resetting.
  const options = p.model && !models.some((m) => key(m.sel) === key(p.model!)) ? [{ label: `${p.model.instanceId} · ${p.model.model}`, sel: p.model }, ...models] : models;
  return (
    <Card>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ ...p, name: p.name.trim() });
        }}
      >
        <div className="grid grid-cols-[5rem_1fr] gap-3">
          <Field label="Avatar">
            <Input value={p.avatar ?? ""} onChange={(e) => patch({ avatar: e.target.value })} maxLength={8} placeholder="🧑" />
          </Field>
          <Field label="Name">
            <Input value={p.name} onChange={(e) => patch({ name: e.target.value })} maxLength={40} required autoFocus />
          </Field>
        </div>
        <Field label="Role prompt">
          <Textarea value={p.rolePrompt ?? ""} onChange={(e) => patch({ rolePrompt: e.target.value })} maxLength={4000} placeholder="You are a careful reviewer. Focus on..." />
        </Field>
        <Field label="Model">
          <Select value={p.model ? key(p.model) : ""} onChange={(e) => patch({ model: options.find((m) => key(m.sel) === e.target.value)?.sel ?? null })}>
            <option value="">No default</option>
            {options.map((m) => (
              <option key={key(m.sel)} value={key(m.sel)}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Permissions">
            <Select value={p.runtimeMode ?? ""} onChange={(e) => patch({ runtimeMode: (e.target.value || null) as RuntimeMode | null })}>
              <option value="">No default</option>
              {runtimeModes.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Mode">
            <Select value={p.interactionMode ?? ""} onChange={(e) => patch({ interactionMode: (e.target.value || null) as InteractionMode | null })}>
              <option value="">No default</option>
              <option value="default">Default</option>
              <option value="plan">Plan first</option>
            </Select>
          </Field>
        </div>
        <p className="text-xs text-muted-fg">Permissions apply to your own tasks only. Tasks from agents always get them from you at approval.</p>
        <div className="flex gap-2">
          <Button variant="primary" type="submit" disabled={busy || !p.name.trim()}>
            Save
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

/** Settings page: reusable roles you pick in Ask. A profile prefixes the prompt and fills defaults. */
export function Profiles() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  /** null = closed, "" = new, else the profile id being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => call("GET /api/profiles").then(setProfiles, (e) => setError(e instanceof Error ? e.message : "Could not load profiles"));
  useEffect(() => {
    void load();
    loadModels().then(setModels, () => {});
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async (id: string, body: ProfileInput) => {
    const ok = await act(() => (id ? call("PATCH /api/profiles/:id", { params: { id }, body }) : call("POST /api/profiles", { body })));
    if (ok) setEditing(null);
  };

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <h1 className="flex-1 text-xl font-semibold">Profiles</h1>
        {editing === null && <Button onClick={() => setEditing("")}>New profile</Button>}
      </div>
      <p className="text-muted-fg">A profile is a role you can pick in Ask: its prompt goes in front of yours and its model and mode are the defaults.</p>
      {error && (
        <p role="alert" className="text-bad">
          {error}
        </p>
      )}
      {editing === "" && <Form initial={blank} models={models} busy={busy} onSave={(p) => void save("", p)} onCancel={() => setEditing(null)} />}
      {profiles?.length === 0 && editing === null && <Empty>No profiles yet.</Empty>}
      {profiles?.map((p) =>
        editing === p.id ? (
          <Form key={p.id} initial={p} models={models} busy={busy} onSave={(x) => void save(p.id, x)} onCancel={() => setEditing(null)} />
        ) : (
          <Card key={p.id} className="flex items-center gap-2">
            <span className="w-7 text-center text-xl" aria-hidden>
              {p.avatar}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">
                {p.name}
                {p.createdBy !== "user" && <Badge className="ml-2">{p.createdBy.slice(6)}</Badge>}
              </p>
              <p className="truncate text-muted-fg">{p.rolePrompt || "No role prompt"}</p>
            </div>
            <Button size="sm" disabled={busy} onClick={() => setEditing(p.id)}>
              Edit
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => confirm(`Delete ${p.name}? Tasks already created keep their prompt.`) && void act(() => call("DELETE /api/profiles/:id", { params: { id: p.id } }))}
            >
              Delete
            </Button>
          </Card>
        ),
      )}
    </div>
  );
}
