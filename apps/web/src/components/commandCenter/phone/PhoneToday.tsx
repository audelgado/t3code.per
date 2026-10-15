import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveWorkingThreads } from "@t3tools/client-runtime/state/commandCenterDerive";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useRelativeTimeTick } from "../../settings/settingsLayout";
import { Button } from "../../ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "../../ui/empty";
import { NeedsYou } from "../home/HomeTab";
import { StatusDot } from "../StatusDot";
import {
  useCommandCenter,
  useCommandCenterAttention,
  useCommandCenterEnvironments,
} from "../shared";
import { deriveDoneFeed } from "./doneLogic";

export function PhoneToday({ onDone }: { readonly onDone: () => void }) {
  const shells = useThreadShells();
  const attention = useCommandCenterAttention();
  const { projects, setProjectFocus } = useCommandCenter();
  const environments = useCommandCenterEnvironments();
  const now = useRelativeTimeTick(60_000);
  const working = useMemo(() => deriveWorkingThreads(shells), [shells]);
  const done = useMemo(() => deriveDoneFeed(shells, now, "today"), [shells, now]);
  const navigate = useNavigate();
  const openThread = (
    environmentId: (typeof shells)[number]["environmentId"],
    threadId: (typeof shells)[number]["id"],
  ) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  return (
    <div className="space-y-4">
      <p className="text-xs tabular-nums text-muted-foreground">
        {working.length} working · {attention.length} need you · {done.total} done today
      </p>
      {attention.length ? (
        <NeedsYou
          items={attention}
          projectTitle={(id) => projects.find((project) => project.id === id)?.title ?? null}
          onOpenThread={openThread}
          onOpenProject={(id) => {
            setProjectFocus(id);
            void navigate({ to: "/command", search: { tab: "projects", project: id } });
          }}
          onOpenRun={(run) =>
            void navigate({
              to: "/command",
              search: { tab: "workflows", project: run.projectId, run: run.id },
            })
          }
          onOpenFinance={() => void navigate({ to: "/command", search: { tab: "finance" } })}
        />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing needs you</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
      <section className="space-y-2">
        <h2 className="text-sm text-foreground/70">Working now</h2>
        <ul className="divide-y rounded-xl border bg-card">
          {working.slice(0, 8).map((shell) => (
            <li key={`${shell.environmentId}:${shell.id}`}>
              <button
                type="button"
                className="flex w-full min-w-0 items-center gap-2 p-3 text-left"
                onClick={() => openThread(shell.environmentId, shell.id)}
              >
                <StatusDot tone="success" label="Working" hideLabel />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{shell.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {
                      projects.find(
                        (project) =>
                          project.id === shell.projectId &&
                          project.environmentId === shell.environmentId,
                      )?.title
                    }{" "}
                    ·{" "}
                    {
                      environments.find(
                        (environment) => environment.environmentId === shell.environmentId,
                      )?.label
                    }
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {working.length > 8 ? (
          <p className="text-xs text-muted-foreground">+{working.length - 8} more in Team</p>
        ) : null}
      </section>
      <section className="space-y-2">
        <h2 className="text-sm text-foreground/70">Done today</h2>
        {done.items.slice(0, 2).map((shell) => (
          <button
            key={`${shell.environmentId}:${shell.id}`}
            type="button"
            onClick={() => openThread(shell.environmentId, shell.id)}
            className="block w-full truncate rounded-lg border p-3 text-left text-sm"
          >
            {shell.title}
          </button>
        ))}
        <Button variant="ghost" size="sm" onClick={onDone}>
          See all ({done.total})
        </Button>
      </section>
    </div>
  );
}
