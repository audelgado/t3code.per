import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { kvGet, kvSet } from "./db.ts";
import { checkContract, githubReader, T3_CONTRACT } from "./t3link.ts";
import type { Alert, Machine, T3Link } from "./types.ts";

const DAY = 86_400_000;
const contractSignature = createHash("sha256").update(JSON.stringify(T3_CONTRACT)).digest("hex");

interface ContractState {
  signature?: string;
  version: string;
  since: string;
  misses: string[];
}
interface TokenState {
  checkedAt: string;
  expiresAt: string | null;
}

export interface HealthDeps {
  db: DatabaseSync;
  /** Enabled machines with their live links. */
  targets: () => Array<{ machine: Machine; link: T3Link }>;
  now?: () => number;
  /** Reader for upstream files at a ref (a tag like "v0.3.1"). */
  readerFor?: (ref: string) => (file: string) => Promise<string | null>;
}

/**
 * Canary checks. `tick()` on the dispatcher's 30 s cadence is cheap: it only works when a machine's
 * serverVersion changed (contract check against the installed tag) or the last token check is a day old.
 * Network errors are silent and retried next tick. Pass `alerts()` to buildHomeView as extraAlerts.
 */
export function createHealth(deps: HealthDeps) {
  const now = deps.now ?? Date.now;
  const readerFor = deps.readerFor ?? ((ref: string) => githubReader(ref));
  let running: Promise<void> | null = null;

  async function checkMachine(machine: Machine, link: T3Link) {
    const version = link.state.serverVersion;
    const ckey = `health:contract:${machine.id}`;
    const cached = kvGet<ContractState>(deps.db, ckey);
    if (version && (cached?.version !== version || cached.signature !== contractSignature)) {
      try {
        const read = readerFor(`v${version}`);
        let found = 0;
        const misses = await checkContract(async (file) => {
          const text = await read(file);
          if (text !== null) found++;
          return text;
        });
        // No file at all: the tag v<version> is not upstream (a fork or local build), so nothing to compare.
        const why = found === 0 ? [] : misses.map((m) => m.why);
        kvSet(deps.db, ckey, { version, signature: contractSignature, since: new Date(now()).toISOString(), misses: why } satisfies ContractState);
      } catch {
        // offline or rate limited: try again next tick
      }
    }
    const tkey = `health:token:${machine.id}`;
    const last = kvGet<TokenState>(deps.db, tkey);
    if (link.state.status === "online" && (!last || now() - Date.parse(last.checkedAt) >= DAY)) {
      try {
        const { expiresAt } = await link.session();
        kvSet(deps.db, tkey, { checkedAt: new Date(now()).toISOString(), expiresAt } satisfies TokenState);
      } catch {
        // offline or token rejected (the link state already reports that)
      }
    }
  }

  return {
    tick(): Promise<void> {
      return (running ??= (async () => {
        try {
          for (const { machine, link } of deps.targets()) await checkMachine(machine, link);
        } finally {
          running = null;
        }
      })());
    },
    alerts(): Alert[] {
      const out: Alert[] = [];
      for (const { machine } of deps.targets()) {
        const contract = kvGet<ContractState>(deps.db, `health:contract:${machine.id}`);
        if (contract?.misses.length)
          out.push({
            key: `contract_break:${machine.id}:${contract.version}`,
            kind: "contract_break",
            machineId: machine.id,
            message: `${machine.label}: T3 ${contract.version} cambió algo de lo que depende el CC (${contract.misses.join("; ")})`,
            since: contract.since,
          });
        const token = kvGet<TokenState>(deps.db, `health:token:${machine.id}`);
        // The view already alerts from machine.tokenExpiresAt; this adds the daily T3-reported expiry.
        if (token?.expiresAt && Date.parse(token.expiresAt) - now() <= 14 * DAY)
          out.push({
            key: `token_expiring:${machine.id}`,
            kind: "token_expiring",
            machineId: machine.id,
            message: `${machine.label}: el token de T3 vence el ${new Date(token.expiresAt).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}`,
            since: token.expiresAt,
          });
      }
      return out;
    },
  };
}
