import type { CommandCenterAgentProfile } from "@t3tools/contracts";
import { useState } from "react";

import { useThreadShells } from "~/state/entities";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { CollectionPager } from "../CollectionPager";
import { paginateCollection } from "../collectionPaging";
import { useAutoRouting } from "../plan/useAutoRouting";
import { latestThreadByProject, projectEntryKey } from "../projects/projectDirectory";
import { useCommandCenter } from "../shared";
import { ProgressBar } from "../projects/ProjectCard";
import { StatusDot } from "../StatusDot";
import { AgentDialog } from "../team/TeamForms";

/** Bounded route previews and agent profiles, using the launcher's actual routing rule. */
export function PhoneRoute() {
  const { snapshot, projects, primaryEnvironmentId, canOperate } = useCommandCenter();
  const routing = useAutoRouting();
  const latest = latestThreadByProject(useThreadShells());
  const [editing, setEditing] = useState<CommandCenterAgentProfile | null>(null);
  const [profilePage, setProfilePage] = useState(1);
  const [machinePage, setMachinePage] = useState(1);
  const teams = snapshot.teams.filter((team) => team.archivedAt === null);
  const profiles = snapshot.agentProfiles.filter((profile) => profile.archivedAt === null);
  const profileRows = paginateCollection(profiles, profilePage, 5);
  const machines = paginateCollection(routing.environments, machinePage, 5);
  const recent = projects
    .toSorted(
      (left, right) =>
        (latest.get(projectEntryKey(right))?.at ?? Date.parse(right.updatedAt)) -
        (latest.get(projectEntryKey(left))?.at ?? Date.parse(left.updatedAt)),
    )
    .slice(0, 3);
  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">Auto routing</h2>
        <p className="text-xs text-muted-foreground">
          Auto sends work to the machine that holds the project, when it is connected and its
          provider is available. Pick a machine to override it.
        </p>
        <p className="text-xs text-muted-foreground">
          Projects are independent. A matching name or remote never links copies across machines.
        </p>
        <ul className="space-y-2">
          {recent.map((project) => {
            const agent =
              profiles.find(
                (entry) => (routing.states.get(entry.id)?.status ?? "idle") === "idle",
              ) ?? null;
            const team = teams.find((entry) => entry.id === agent?.teamId);
            const route = routing.resolve(
              project.id,
              agent,
              "auto",
              team?.environmentId ?? primaryEnvironmentId,
            );
            return (
              <li key={`${project.environmentId}:${project.id}`} className="text-xs">
                <span className="font-medium">{project.title}</span> →{" "}
                {"error" in route
                  ? route.error
                  : `${routing.label(route.environmentId)} (project${agent ? ` · ${agent.name}` : ""})`}
              </li>
            );
          })}
        </ul>
        {recent.length === 0 ? (
          <p className="text-xs text-muted-foreground">Add a project to preview its route.</p>
        ) : null}
      </section>
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">Machines</h2>
        {machines.items.map((machine) => {
          const active = [...routing.states.entries()].filter(
            ([, state]) =>
              state.status === "working" &&
              state.assignment?.finishedAt === null &&
              state.assignment.environmentId === machine.environmentId,
          );
          const capacity = profiles.filter(
            (profile) =>
              (teams.find((team) => team.id === profile.teamId)?.environmentId ??
                primaryEnvironmentId) === machine.environmentId,
          ).length;
          return (
            <div key={machine.environmentId} className="space-y-2 border-t pt-3">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="text-sm font-medium">{machine.label}</span>
                <StatusDot
                  tone={machine.connected ? "success" : "muted"}
                  label={machine.connected ? "Online" : "Offline"}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {routing.counts.get(machine.environmentId) ?? 0} working · {capacity} assigned
                profiles
              </p>
              <ProgressBar percent={(active.length / Math.max(1, capacity, active.length)) * 100} />
              <ul className="space-y-1 text-xs text-muted-foreground">
                {active.slice(0, 5).map(([agentId, state]) => (
                  <li key={agentId}>
                    {profiles.find((profile) => profile.id === agentId)?.name ?? "Agent"} ·{" "}
                    {projects.find(
                      (project) =>
                        project.id === state.assignment?.projectId &&
                        project.environmentId === machine.environmentId,
                    )?.title ?? "Project"}
                  </li>
                ))}
              </ul>
              {active.length > 5 ? (
                <p className="text-xs text-muted-foreground">+{active.length - 5} more working</p>
              ) : null}
            </div>
          );
        })}
        <CollectionPager {...machines} label="machines" onPageChange={setMachinePage} />
      </section>
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">Agent profiles</h2>
        {profileRows.items.map((profile) => {
          const team = teams.find((entry) => entry.id === profile.teamId);
          return (
            <div key={profile.id} className="space-y-2 border-t pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{profile.name}</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canOperate}
                  onClick={() => setEditing(profile)}
                >
                  Edit instructions
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {team?.name ?? "No team"} ·{" "}
                {routing.label(team?.environmentId ?? primaryEnvironmentId)}
              </p>
              <p className="break-words text-xs text-muted-foreground">
                {profile.modelSelection.instanceId} · {profile.modelSelection.model}
              </p>
              <p className="line-clamp-2 text-xs">
                {profile.rolePrompt || "No role instructions."}
              </p>
              <div className="flex flex-wrap gap-1">
                <Badge variant="outline">{profile.interactionMode}</Badge>
                <Badge variant="outline">{profile.runtimeMode}</Badge>
              </div>
            </div>
          );
        })}
        {profileRows.total === 0 ? (
          <p className="text-xs text-muted-foreground">Create agent profiles in Team.</p>
        ) : null}
        <CollectionPager {...profileRows} label="profiles" onPageChange={setProfilePage} />
      </section>
      {editing ? (
        <AgentDialog agent={editing} teamId={editing.teamId} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}
