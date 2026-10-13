import type { CommandCenterSection, ProjectId } from "@t3tools/contracts";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { useRelativeTimeTick } from "../../settings/settingsLayout";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { useStartOnboarding } from "../plan/useStartOnboarding";
import { useAgentStates, useCommandCenter } from "../shared";
import {
  addDays,
  countByStatus,
  dueLabel,
  localDate,
  nextDelivery,
  SECTION_STATUS_LABEL,
  sortSections,
  STRIP_DAYS,
  stripMarkers,
  unmetDependencies,
} from "./logic";
import { ProjectCard, projectAnchorId } from "./ProjectCard";

const MARKER_COLOR = {
  todo: "bg-muted-foreground",
  in_progress: "bg-info",
  review: "bg-warning",
  blocked: "bg-destructive",
  done: "bg-success",
} as const;

const axisFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const formatDay = (day: string) => axisFormat.format(Date.parse(`${day}T00:00:00Z`));

function Kpi({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-xl font-semibold tabular-nums">{value}</span>
      <span className="truncate text-xs text-muted-foreground">{hint}</span>
    </div>
  );
}

/** Projects tab. Reads page state through `useCommandCenter()` (see ../shared). */
export function ProjectsTab() {
  const { snapshot, projects, projectId } = useCommandCenter();
  const agentStates = useAgentStates();
  const startOnboarding = useStartOnboarding();
  const today = localDate(useRelativeTimeTick(60_000));

  const sectionsByProject = useMemo(() => {
    const grouped = new Map<ProjectId, CommandCenterSection[]>();
    for (const section of sortSections(snapshot.sections)) {
      const list = grouped.get(section.projectId);
      if (list) list.push(section);
      else grouped.set(section.projectId, [section]);
    }
    return grouped;
  }, [snapshot.sections]);

  const unmet = useMemo(() => unmetDependencies(snapshot.sections), [snapshot.sections]);

  const agentNames = useMemo(
    () => new Map(snapshot.agentProfiles.map((agent) => [agent.id, agent.name] as const)),
    [snapshot.agentProfiles],
  );

  // KPIs follow the filter chip; cards and strip rows only dim.
  const scoped = projects
    .filter((project) => projectId === null || project.id === projectId)
    .flatMap((project) => sectionsByProject.get(project.id) ?? []);
  const counts = countByStatus(scoped);
  const next = nextDelivery(scoped, today);
  const nextProject = next
    ? projects.find((project) => project.id === next.section.projectId)
    : null;

  if (projects.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No projects yet. Add one in T3 to track it here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="In progress" value={counts.in_progress} hint="sections moving" />
        <Kpi label="To review" value={counts.review} hint="waiting for your OK" />
        <Kpi label="Blocked" value={counts.blocked} hint={`${counts.todo} not started`} />
        <Kpi
          label="Next delivery"
          value={
            next ? `${formatDay(next.section.dueDate ?? today)} · ${dueLabel(next.days)}` : "None"
          }
          hint={
            next ? `${nextProject?.title ?? "Project"} · ${next.section.name}` : "nothing scheduled"
          }
        />
      </div>

      <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
        <h2 className="text-sm font-medium">Deliveries, next 5 weeks</h2>
        <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
          <div />
          <div className="relative h-4 text-2xs text-muted-foreground">
            {[0, 7, 14, 21, 28, 35].map((offset) => (
              <span
                key={offset}
                className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full"
                style={{ left: `${(offset / STRIP_DAYS) * 100}%` }}
              >
                {offset === 0 ? "Today" : formatDay(addDays(today, offset))}
              </span>
            ))}
          </div>
          {projects.map((project) => {
            const markers = stripMarkers(sectionsByProject.get(project.id) ?? [], today);
            const dimmed = projectId !== null && project.id !== projectId;
            return (
              <div key={project.id} className={cn("contents", dimmed && "[&>*]:opacity-50")}>
                <span className="truncate text-xs leading-6">{project.title}</span>
                <div className="relative h-6 border-s-2 border-primary/60">
                  <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
                  {markers.map(({ section, left }) => (
                    <Tooltip key={section.id}>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            className={cn(
                              "absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card",
                              MARKER_COLOR[section.status],
                            )}
                            style={{ left: `${left}%` }}
                            aria-label={`${project.title}: ${section.name}, due ${section.dueDate}`}
                            onClick={() =>
                              document
                                .getElementById(projectAnchorId(project))
                                ?.scrollIntoView({ block: "start" })
                            }
                          />
                        }
                      />
                      <TooltipPopup>
                        {section.name} · {section.dueDate} · {SECTION_STATUS_LABEL[section.status]}
                      </TooltipPopup>
                    </Tooltip>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {projects.map((project) => (
        <ProjectCard
          key={project.id}
          onOnboard={startOnboarding}
          project={project}
          sections={sectionsByProject.get(project.id) ?? []}
          agents={[...agentStates].flatMap(([agentId, state]) =>
            state.status !== "idle" && state.assignment?.projectId === project.id
              ? [{ ...state, agentId }]
              : [],
          )}
          agentNames={agentNames}
          today={today}
          unmet={unmet}
          dimmed={projectId !== null && project.id !== projectId}
        />
      ))}
    </div>
  );
}
