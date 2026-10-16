import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { Profile, ProfileInput } from "../../server/profiles.ts";
import type { InteractionMode, ModelSelection, RuntimeMode } from "../../server/types.ts";
import { call } from "./api.ts";
import { RUNTIME_MODES, runtimeModeLabel } from "./look.ts";
import { Button } from "./ui/Button.tsx";
import { Chip } from "./ui/Chip.tsx";
import { EmptyState, Field, Input, Select, Textarea } from "./ui/fields.tsx";
import { Panel } from "./ui/Panel.tsx";
import { Sheet } from "./ui/Sheet.tsx";

const INTERACTION_MODES: readonly (readonly [InteractionMode, string])[] = [
  ["default", "Predeterminado"],
  ["plan", "Planificar primero"],
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

/** Sheet to create (`id` "") or edit a profile; Eliminar shows only when editing. */
function ProfileSheet({ initial, models, busy, onSave, onDelete, onClose }: { initial: ProfileInput; models: ModelOption[]; busy: boolean; onSave(p: ProfileInput): void; onDelete?: () => void; onClose: () => void }) {
  const [p, setP] = useState(initial);
  const patch = (x: Partial<ProfileInput>) => setP((cur) => ({ ...cur, ...x }));
  // A saved model that no machine lists now stays selectable instead of silently resetting.
  const options = p.model && !models.some((m) => key(m.sel) === key(p.model!)) ? [{ label: `${p.model.instanceId} · ${p.model.model}`, sel: p.model }, ...models] : models;
  return (
    <Sheet
      title={onDelete ? "Editar perfil" : "Nuevo perfil"}
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          {onDelete && (
            <Button variant="danger" disabled={busy} onClick={onDelete}>
              Eliminar
            </Button>
          )}
          <Button className="ml-auto" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="profile-form" disabled={busy || !p.name.trim()}>
            Guardar
          </Button>
        </div>
      }
    >
      <form
        id="profile-form"
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
          <Field label="Nombre">
            <Input value={p.name} onChange={(e) => patch({ name: e.target.value })} maxLength={40} required autoFocus />
          </Field>
        </div>
        <Field label="Indicaciones del rol">
          <Textarea value={p.rolePrompt ?? ""} onChange={(e) => patch({ rolePrompt: e.target.value })} maxLength={4000} placeholder="Sos un revisor cuidadoso. Enfocate en…" />
        </Field>
        <Field label="Modelo">
          <Select value={p.model ? key(p.model) : ""} onChange={(e) => patch({ model: options.find((m) => key(m.sel) === e.target.value)?.sel ?? null })}>
            <option value="">Sin definir</option>
            {options.map((m) => (
              <option key={key(m.sel)} value={key(m.sel)}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Permisos">
            <Select value={p.runtimeMode ?? ""} onChange={(e) => patch({ runtimeMode: (e.target.value || null) as RuntimeMode | null })}>
              <option value="">Sin definir</option>
              {RUNTIME_MODES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Modo">
            <Select value={p.interactionMode ?? ""} onChange={(e) => patch({ interactionMode: (e.target.value || null) as InteractionMode | null })}>
              <option value="">Sin definir</option>
              {INTERACTION_MODES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="text-xs text-muted-fg">Los permisos aplican solo a tus propias tareas. Las tareas de agentes siempre los reciben de vos al aprobar.</p>
      </form>
    </Sheet>
  );
}

/** Perfiles: roles reutilizables que elegís en Pedir. Un perfil antepone su prompt al tuyo y completa los valores por defecto. */
export function Profiles() {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  /** null = closed, "" = new, else the profile id being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => call("GET /api/profiles").then(setProfiles, (e) => setError(e instanceof Error ? e.message : "No se pudieron cargar los perfiles"));
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
      setError(e instanceof Error ? e.message : "No se pudo completar la acción");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async (id: string, body: ProfileInput) => {
    const ok = await act(() => (id ? call("PATCH /api/profiles/:id", { params: { id }, body }) : call("POST /api/profiles", { body })));
    if (ok) setEditing(null);
  };
  const remove = async (p: Profile) => {
    if (!confirm(`¿Eliminar ${p.name}? Las tareas ya creadas conservan su prompt.`)) return;
    if (await act(() => call("DELETE /api/profiles/:id", { params: { id: p.id } }))) setEditing(null);
  };
  const modelLabel = (m: ModelSelection) => models.find((o) => key(o.sel) === key(m))?.label ?? `${m.instanceId} · ${m.model}`;
  const current = profiles?.find((p) => p.id === editing);

  return (
    <>
      <Panel
        title="Perfiles"
        action={
          <Button onClick={() => setEditing("")}>
            <Plus className="size-4" aria-hidden />
            Nuevo perfil
          </Button>
        }
      >
        <p className="px-4 py-2.5 text-xs text-muted-fg">Roles que elegís en Pedir: su prompt va antes del tuyo y su modelo y modo son los valores por defecto.</p>
        {error && (
          <p role="alert" className="px-4 py-2.5 text-fail">
            {error}
          </p>
        )}
        {profiles?.length === 0 && (
          <div className="p-4">
            <EmptyState>Nada por acá: todavía no hay perfiles.</EmptyState>
          </div>
        )}
        {profiles?.map((p) => (
          <div key={p.id} className="flex items-start gap-3 px-4 py-3">
            <span className="grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-soft text-[17px]" aria-hidden>
              {p.avatar || <b className="text-sm text-muted-fg">{p.name.slice(0, 1).toUpperCase()}</b>}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2">
                <b className="truncate">{p.name}</b>
                {p.createdBy !== "user" && <Chip tone="need" className="h-[19px] text-[11px]">por {p.createdBy.slice(6)}</Chip>}
              </p>
              <p className="line-clamp-2 text-sm break-words text-muted-fg">{p.rolePrompt || "Sin indicaciones de rol"}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5 text-xs text-tx2">
                {p.model && <span className="rounded-full bg-soft px-2 py-0.5">{modelLabel(p.model)}</span>}
                {p.runtimeMode && <span className="rounded-full bg-soft px-2 py-0.5">{runtimeModeLabel(p.runtimeMode)}</span>}
                {p.interactionMode && <span className="rounded-full bg-soft px-2 py-0.5">{INTERACTION_MODES.find(([v]) => v === p.interactionMode)?.[1]}</span>}
              </div>
            </div>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(p.id)}>
              Editar
            </Button>
          </div>
        ))}
      </Panel>
      {editing === "" && <ProfileSheet initial={blank} models={models} busy={busy} onSave={(p) => void save("", p)} onClose={() => setEditing(null)} />}
      {current && <ProfileSheet key={current.id} initial={current} models={models} busy={busy} onSave={(p) => void save(current.id, p)} onDelete={() => void remove(current)} onClose={() => setEditing(null)} />}
    </>
  );
}
