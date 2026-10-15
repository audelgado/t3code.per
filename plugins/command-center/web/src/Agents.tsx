import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentToken, NewAgentToken } from "../../server/mcp.ts";
import { call } from "./api.ts";
import { Button } from "./ui/Button.tsx";
import { ago } from "./ui/cn.ts";
import { Card, Empty, Field, Input } from "./ui/fields.tsx";

function snippets(token: string) {
  const url = `${location.origin}/mcp`;
  return [
    { title: "Claude Code", text: `claude mcp add --scope user --transport http cc ${url} --header "Authorization: Bearer ${token}"` },
    { title: "Codex · ~/.codex/config.toml", text: `[mcp_servers.cc]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }` },
    { title: "Hermes · ~/.hermes/config.yaml", text: `mcp_servers:\n  cc:\n    url: "${url}"\n    headers:\n      Authorization: "Bearer ${token}"` },
  ];
}

function Snippet({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => {},
    );
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs font-medium text-muted-fg">{title}</span>
        <Button variant="ghost" size="icon" aria-label={`Copy ${title}`} onClick={() => void copy()}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
      <pre className="whitespace-pre-wrap break-all rounded-lg bg-accent p-2 text-xs">{text}</pre>
    </div>
  );
}

/** Bearer tokens for agents that call the CC's MCP. Agent tasks always wait for approval in Queue. */
export function Agents() {
  const [agents, setAgents] = useState<AgentToken[] | null>(null);
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<NewAgentToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => call("GET /api/agents").then(setAgents, (e) => setError(e instanceof Error ? e.message : "Could not load agents"));
  useEffect(() => void load(), []);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };
  const create = () =>
    act(async () => {
      setCreated(await call("POST /api/agents", { body: { label: label.trim() } }));
      setLabel("");
    });
  const revoke = (l: string) => {
    if (confirm(`Revoke ${l}? Its MCP calls stop working. Its tasks stay.`))
      void act(async () => {
        await call("DELETE /api/agents/:label", { params: { label: l } });
        if (created?.label === l) setCreated(null);
      });
  };

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Agents</h1>
      <p className="text-muted-fg">
        Agents with a token can submit tasks through the Command Center MCP. Every task they submit waits for your approval in Queue.
      </p>

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="min-w-0 flex-1">
          <Field label="New agent">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="hermes" maxLength={40} autoCapitalize="off" autoCorrect="off" />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={busy || !label.trim()}>
          Create
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-bad">
          {error}
        </p>
      )}

      {created && (
        <Card className="grid gap-3 border-warn">
          <p className="font-medium">Token for {created.label}</p>
          <p className="text-warn">Copy it now. It is not shown again.</p>
          <pre className="whitespace-pre-wrap break-all rounded-lg bg-accent p-2 text-xs">{created.token}</pre>
          {snippets(created.token).map((s) => (
            <Snippet key={s.title} {...s} />
          ))}
          <Button onClick={() => setCreated(null)}>Done</Button>
        </Card>
      )}

      {agents?.length === 0 && <Empty>No agents yet.</Empty>}
      {agents?.map((a) => (
        <Card key={a.label} className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{a.label}</p>
            <p className="text-muted-fg">
              Created {ago(a.createdAt)} · {a.lastUsedAt ? `used ${ago(a.lastUsedAt)}` : "never used"}
            </p>
          </div>
          <Button variant="danger" size="sm" disabled={busy} onClick={() => revoke(a.label)}>
            Revoke
          </Button>
        </Card>
      ))}
    </div>
  );
}
