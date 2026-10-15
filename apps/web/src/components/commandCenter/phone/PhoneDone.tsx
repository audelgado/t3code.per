import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useRelativeTimeTick } from "../../settings/settingsLayout";
import { Button } from "../../ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "../../ui/empty";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { CollectionPager } from "../CollectionPager";
import { paginateCollection } from "../collectionPaging";
import { useCommandCenter, useCommandCenterEnvironments } from "../shared";
import { deriveDoneFeed } from "./doneLogic";
import { digestKey, useThreadDigests } from "./useThreadDigests";

export function PhoneDone() {
  const shells = useThreadShells();
  const now = useRelativeTimeTick(60_000);
  const [range, setRange] = useState<"today" | "week">("today");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(5);
  const today = useMemo(() => deriveDoneFeed(shells, now, "today"), [shells, now]);
  const week = useMemo(() => deriveDoneFeed(shells, now, "week"), [shells, now]);
  const feed = range === "today" ? today : week;
  const directory = paginateCollection(feed.items, page, 20);
  const visible = useMemo(() => directory.items.slice(0, limit), [directory.items, limit]);
  const { digests, loadedKeys, error } = useThreadDigests(visible);
  const { projects } = useCommandCenter();
  const environments = useCommandCenterEnvironments();
  const navigate = useNavigate();
  const open = (shell: EnvironmentThreadShell) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(shell.environmentId, shell.id)),
    });
  return (
    <section className="space-y-3" aria-label="Done work">
      <ToggleGroup
        variant="segmented"
        value={[range]}
        onValueChange={(values) => {
          if (values[0] === "today" || values[0] === "week") {
            setRange(values[0]);
            setPage(1);
            setLimit(5);
          }
        }}
      >
        <Toggle value="today">Today · {today.total}</Toggle>
        <Toggle value="week">This week · {week.total}</Toggle>
      </ToggleGroup>
      {error ? (
        <p role="status" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {visible.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No finished work yet</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {visible.map((shell) => {
            const digest = digests.get(digestKey(shell.environmentId, shell.id));
            const project = projects.find(
              (item) => item.id === shell.projectId && item.environmentId === shell.environmentId,
            );
            const pr = shell.pullRequests.find((item) => item.source !== "stack-dismissed");
            return (
              <li key={digestKey(shell.environmentId, shell.id)} className="space-y-2 p-3">
                <div className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="truncate">
                    {project?.title ?? "Project"} ·{" "}
                    {environments.find((env) => env.environmentId === shell.environmentId)?.label ??
                      "Machine"}
                  </span>
                  <time className="shrink-0">
                    {formatRelativeTimeLabel(shell.latestRun?.completedAt ?? shell.updatedAt)}
                  </time>
                </div>
                <p className="truncate text-sm">{shell.title}</p>
                <p className="line-clamp-3 break-words text-sm text-muted-foreground">
                  {digest?.text ||
                    (digest
                      ? "No final message was recorded."
                      : loadedKeys.has(digestKey(shell.environmentId, shell.id)) || error
                        ? "Summary unavailable."
                        : "Loading summary…")}
                </p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {digest
                    ? `${digest.files} files · +${digest.additions} −${digest.deletions}`
                    : "Diff stats pending"}
                  {pr ? ` · PR #${pr.number} ${pr.snapshot?.state ?? ""}` : ""}
                </p>
                <details className="text-xs">
                  <summary className="cursor-pointer">Details</summary>
                  <p className="mt-2 whitespace-pre-wrap break-words">
                    {digest?.text ?? "Summary unavailable."}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button size="xs" variant="outline" onClick={() => open(shell)}>
                      Open thread
                    </Button>
                    {pr ? (
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noreferrer"
                        className="self-center underline"
                      >
                        PR #{pr.number}
                      </a>
                    ) : null}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      {limit < directory.items.length ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setLimit((value) => Math.min(20, value + 5))}
        >
          Show more
        </Button>
      ) : null}
      {limit >= directory.items.length && directory.pageCount > 1 ? (
        <CollectionPager
          {...directory}
          label="finished threads"
          onPageChange={(value) => {
            setPage(value);
            setLimit(5);
          }}
        />
      ) : null}
      <p className="text-xs text-muted-foreground">
        Summaries come from the agent's last message, diff stats and PR state. No extra tokens.
      </p>
    </section>
  );
}
