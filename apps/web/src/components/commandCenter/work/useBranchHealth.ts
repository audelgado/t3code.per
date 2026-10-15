import { RegistryContext } from "@effect/atom-react";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { PullRequestListEntry, VcsListRefsResult } from "@t3tools/contracts";
import { useContext, useRef, useState } from "react";
import { vcsEnvironment } from "~/state/vcs";
import { pullRequestEnvironment } from "~/state/pullRequests";
import type { WorkLane } from "./workView";
/** Existing cached queries only; a scan is an explicit action and has no timer. */
export function useBranchHealth(lanes: readonly WorkLane[]) {
  const registry = useContext(RegistryContext);
  const [refs, setRefs] = useState<ReadonlyMap<string, VcsListRefsResult>>(() => new Map());
  const [merged, setMerged] = useState<ReadonlyMap<string, ReadonlySet<string>>>(() => new Map());
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const scan = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      for (const lane of lanes.slice(0, 4)) {
        const result = await executeAtomQuery(
          registry,
          vcsEnvironment.listRefs({
            environmentId: lane.project.environmentId,
            input: { cwd: lane.project.workspaceRoot, refKind: "local", limit: 100 },
          }),
          { refresh: true, reportFailure: false },
        );
        if (result._tag === "Success")
          setRefs((previous) => new Map(previous).set(lane.key, result.value));
        else setError(String(squashAtomCommandFailure(result)));
      }
      const environments = [...new Set(lanes.map((lane) => lane.project.environmentId))];
      for (const environmentId of environments) {
        const projects = lanes.filter((lane) => lane.project.environmentId === environmentId);
        const result = await executeAtomQuery(
          registry,
          pullRequestEnvironment.list({
            environmentId,
            input: {
              state: "merged",
              projectIds: projects.map((lane) => lane.project.id),
              limit: 100,
            },
          }),
          { refresh: true, reportFailure: false },
        );
        if (result._tag === "Success") {
          const entries: readonly PullRequestListEntry[] = result.value.entries;
          setMerged((previous) => {
            const next = new Map(previous);
            for (const lane of projects)
              next.set(
                lane.key,
                new Set(
                  entries
                    .filter((entry) => entry.projectId === lane.project.id)
                    .map((entry) => entry.headBranch),
                ),
              );
            return next;
          });
        } else setError(String(squashAtomCommandFailure(result)));
      }
    } finally {
      setBusy(false);
      running.current = false;
    }
  };
  return { refs, merged, busy, error, scan };
}
