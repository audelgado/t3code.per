import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { CommandCenterThreadDigest, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

export const digestKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}:${threadId}`;

/** Fetch only visible rows, once per completed run and environment, with no transcript subscription. */
export function useThreadDigests(items: ReadonlyArray<EnvironmentThreadShell>) {
  const read = useAtomCommand(serverEnvironment.commandCenterThreadDigests, "read work summaries");
  const [cache, setCache] = useState<ReadonlyMap<string, CommandCenterThreadDigest | null>>(
    new Map(),
  );
  const requested = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const visible = useMemo(() => items.slice(0, 20), [items]);
  useEffect(() => {
    const groups = new Map<EnvironmentId, EnvironmentThreadShell[]>();
    const versions = new Map<EnvironmentId, string[]>();
    for (const item of visible) {
      const version = `${digestKey(item.environmentId, item.id)}:${item.latestRun?.runId}`;
      if (requested.current.has(version)) continue;
      requested.current.add(version);
      groups.set(item.environmentId, [...(groups.get(item.environmentId) ?? []), item]);
      versions.set(item.environmentId, [...(versions.get(item.environmentId) ?? []), version]);
    }
    for (const [environmentId, rows] of groups) {
      void read({ environmentId, input: { threadIds: rows.map((row) => row.id) } }).then(
        (result) => {
          if (result._tag !== "Success") {
            // Forget the attempt so the next visible change or reopen asks again.
            for (const version of versions.get(environmentId) ?? [])
              requested.current.delete(version);
            setError("Could not load summaries. Reopen Done to retry.");
            return;
          }
          setError(null);
          setCache((current) => {
            const next = new Map(current);
            for (const row of rows)
              next.set(`${digestKey(environmentId, row.id)}:${row.latestRun?.runId}`, null);
            for (const digest of result.value.digests) {
              const row = rows.find((item) => item.id === digest.threadId);
              next.set(
                `${digestKey(environmentId, digest.threadId)}:${row?.latestRun?.runId}`,
                digest,
              );
            }
            while (next.size > 200) {
              const first = next.keys().next().value;
              if (first === undefined) break;
              next.delete(first);
              requested.current.delete(first);
            }
            return next;
          });
        },
      );
    }
  }, [read, visible]);
  const digests = new Map(
    visible.flatMap((item) => {
      const key = digestKey(item.environmentId, item.id);
      const digest = cache.get(`${key}:${item.latestRun?.runId}`);
      return digest ? [[key, digest] as const] : [];
    }),
  );
  const loadedKeys = new Set(
    visible
      .filter((item) =>
        cache.has(`${digestKey(item.environmentId, item.id)}:${item.latestRun?.runId}`),
      )
      .map((item) => digestKey(item.environmentId, item.id)),
  );
  return { digests, loadedKeys, error };
}
