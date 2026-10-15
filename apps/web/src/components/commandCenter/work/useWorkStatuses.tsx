import type { VcsStatusResult } from "@t3tools/contracts";
import { useEffect } from "react";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import type { WorkItem } from "./workItems";
import { statusKey } from "./workView";
/** Mounted only for the capped set selected by WorkTab. */
export function WorkStatusObserver({
  item,
  focused,
  onStatus,
}: {
  readonly item: WorkItem;
  readonly focused: boolean;
  readonly onStatus: (key: string, status: VcsStatusResult | null) => void;
}) {
  const query = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId: item.environmentId,
      input: { cwd: item.cwd, includeRemote: focused },
    }),
  );
  const key = statusKey(item);
  useEffect(() => {
    onStatus(key, query.data ?? null);
  }, [key, onStatus, query.data]);
  return null;
}
