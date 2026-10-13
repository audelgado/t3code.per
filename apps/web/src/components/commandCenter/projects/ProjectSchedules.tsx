import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon, PlusIcon } from "lucide-react";
import { useMemo } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { relativeLabel, scheduleLabel } from "../../settings/ScheduledTasksSettings";
import { useRelativeTimeTick } from "../../settings/settingsLayout";
import { Button } from "../../ui/button";
import { recurringProjectTasks } from "./logic";

/**
 * The project's recurring scheduled tasks, from the same live list as Settings > Scheduled
 * tasks. Creating and editing open that page scoped to this project, so there is one editor.
 */
export function ProjectSchedules({ project }: { readonly project: EnvironmentProject }) {
  const { environmentId } = project;
  const navigate = useNavigate();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectKey = useMemo(
    () => deriveLogicalProjectKeyFromSettings(project, groupingSettings),
    [groupingSettings, project],
  );
  const canWrite = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const environment = useEnvironment(environmentId);
  const connected =
    environment?.connection.phase === "connected" && environment.serverConfig !== null;
  const canCreate = connected && canWrite;
  const live = useEnvironmentQuery(
    connected ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const tasks = useMemo(
    () => recurringProjectTasks(live.data?.tasks ?? [], project.id),
    [live.data, project.id],
  );
  // Keeps "next in 5m" honest between list updates.
  useRelativeTimeTick(60_000);
  if (tasks.length === 0 && !canCreate) return null;

  const openSettings = (taskId?: (typeof tasks)[number]["id"]) =>
    void navigate({
      to: "/settings/scheduled-tasks",
      search: {
        project: projectKey,
        machine: environmentId,
        environmentId,
        ...(taskId === undefined ? { newTask: true as const } : { taskId }),
      },
    });

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Recurring work</span>
        {canCreate ? (
          <Button size="xs" variant="ghost-muted" onClick={() => openSettings()}>
            <PlusIcon />
            New task
          </Button>
        ) : null}
      </div>
      {tasks.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No scheduled tasks yet, such as "every Monday update dependencies".
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md text-start text-sm hover:bg-muted/50"
                onClick={() => openSettings(task.id)}
              >
                <CalendarClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {scheduleLabel(task.schedule)}
                  {task.enabled ? ` · next ${relativeLabel(task.nextRunAt)}` : " · paused"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
