import { Check, Copy, KeyRound, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentToken, NewAgentToken } from "../../server/mcp.ts";
import { call } from "./api.ts";
import { Profiles } from "./Profiles.tsx";
import { Button } from "./ui/Button.tsx";
import { ago } from "./look.ts";
import { EmptyState, Field, Input } from "./ui/fields.tsx";
import { Panel } from "./ui/Panel.tsx";
import { Sheet } from "./ui/Sheet.tsx";
import { Tabs } from "./ui/Tabs.tsx";

function snippets(token: string) {
  const url = `${location.origin}/mcp`;
  return [
    { id: "claude", label: "Claude Code", text: `claude mcp add --scope user --transport http cc ${url} --header "Authorization: Bearer ${token}"` },
    { id: "codex", label: "Codex", text: `# ~/.codex/config.toml\n[mcp_servers.cc]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }` },
    { id: "hermes", label: "Hermes", text: `# ~/.hermes/config.yaml\nmcp_servers:\n  cc:\n    url: "${url}"\n    headers:\n      Authorization: "Bearer ${token}"` },
  ];
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      aria-label={`Copiar ${label}`}
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => {},
        )
      }
    >
      {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {copied ? "Copiado" : "Copiar"}
    </Button>
  );
}

/** Shown once, right after creating a token: the token itself and ready-to-paste config for each client. */
function NewToken({ created, onDone }: { created: NewAgentToken; onDone: () => void }) {
  const list = snippets(created.token);
  const [pick, setPick] = useState(list[0]!.id);
  const snippet = list.find((s) => s.id === pick)!;
  return (
    <section className="overflow-hidden rounded-card border border-[#f3d9a6] bg-panel">
      <header className="flex items-center gap-2 bg-need-bg px-4 py-3">
        <h2 className="font-semibold">Token de {created.label}</h2>
        <span className="text-sm text-muted-fg">· se muestra una sola vez</span>
      </header>
      <div className="grid gap-3 px-4 py-3">
        <p className="text-sm text-need">Cópialo ahora: no se vuelve a mostrar.</p>
        <div className="flex items-center gap-2">
          <code translate="no" className="min-w-0 flex-1 rounded-lg bg-soft px-2.5 py-2 font-mono text-[13px] break-all">{created.token}</code>
          <CopyButton text={created.token} label="el token" />
        </div>
        <div className="flex items-center gap-2">
          <Tabs label="Cliente" items={list.map((s) => ({ id: s.id, label: s.label }))} value={pick} onChange={setPick} />
          <span className="ml-auto">
            <CopyButton text={snippet.text} label={`la configuración de ${snippet.label}`} />
          </span>
        </div>
        <pre translate="no" className="overflow-x-auto rounded-lg bg-fg p-2.5 font-mono text-[11.5px] leading-normal whitespace-pre-wrap break-all text-[#e7e5e0]">{snippet.text}</pre>
        <Button variant="primary" className="justify-self-end" onClick={onDone}>
          Listo
        </Button>
      </div>
    </section>
  );
}

/** Acceso API: tokens bearer para agentes que llaman al MCP del Command Center. Sus tareas siempre esperan aprobación en Trabajo. */
function ApiAccess() {
  const [agents, setAgents] = useState<AgentToken[] | null>(null);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<NewAgentToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => call("GET /api/agents").then(setAgents, (e) => setError(e instanceof Error ? e.message : "No se pudieron cargar los agentes"));
  useEffect(() => void load(), []);

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
  const create = async () => {
    const ok = await act(async () => {
      setCreated(await call("POST /api/agents", { body: { label: label.trim() } }));
    });
    if (ok) {
      setLabel("");
      setCreating(false);
    }
  };
  const revoke = (l: string) => {
    if (confirm(`¿Revocar ${l}? Sus llamadas MCP dejan de funcionar. Sus tareas se conservan.`))
      void act(async () => {
        await call("DELETE /api/agents/:label", { params: { label: l } });
        if (created?.label === l) setCreated(null);
      });
  };

  return (
    <>
      <div className="grid gap-4">
        <Panel
          title="Acceso API"
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              Nuevo agente
            </Button>
          }
        >
          <p className="px-4 py-2.5 text-xs text-muted-fg">Tokens MCP para agentes externos. Cada tarea que envíen espera tu aprobación en Trabajo.</p>
          {error && !creating && (
            <p role="alert" className="px-4 py-2.5 text-fail">
              {error}
            </p>
          )}
          {agents?.length === 0 && (
            <div className="p-4">
              <EmptyState>Sin elementos: crea un agente para que otros asistentes o scripts usen el Command Center por MCP.</EmptyState>
            </div>
          )}
          {agents?.map((a) => (
            <div key={a.label} className="flex items-center gap-3 px-4 py-3">
              <KeyRound className="size-4 shrink-0 text-tx2" aria-hidden />
              <div className="min-w-0 flex-1">
                <b className="block truncate font-mono text-[13px]">{a.label}</b>
                <span className="block text-xs text-muted-fg">
                  <span className="hidden md:inline">Creado {ago(a.createdAt)} · </span>
                  {a.lastUsedAt ? `usado ${ago(a.lastUsedAt)}` : "nunca usado"}
                </span>
              </div>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => revoke(a.label)}>
                Revocar
              </Button>
            </div>
          ))}
        </Panel>
        {created && <NewToken created={created} onDone={() => setCreated(null)} />}
      </div>
      {creating && (
        <Sheet
          title="Nuevo agente"
          onClose={() => setCreating(false)}
          footer={
            <div className="flex gap-2">
              <Button className="ml-auto" onClick={() => setCreating(false)}>
                Cancelar
              </Button>
              <Button variant="primary" type="submit" form="agent-form" disabled={busy || !label.trim()}>
                {busy ? "Creando…" : "Crear"}
              </Button>
            </div>
          }
        >
          <form
            id="agent-form"
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <Field label="Nombre">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="hermes…" maxLength={40} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoFocus />
            </Field>
            <p className="text-xs text-muted-fg">Letras, números, puntos, guiones y guiones bajos. Después verás el token una sola vez.</p>
            {error && (
              <p role="alert" className="text-fail">
                {error}
              </p>
            )}
          </form>
        </Sheet>
      )}
    </>
  );
}

/** Flota / Agentes: perfiles (roles para Pedir) y acceso API (tokens MCP). */
export function Agents() {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[1.2fr_1fr]">
      <Profiles />
      <ApiAccess />
    </div>
  );
}
