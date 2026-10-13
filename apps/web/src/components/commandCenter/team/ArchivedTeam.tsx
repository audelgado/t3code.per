import type { CommandCenterAgentProfile, CommandCenterTeam } from "@t3tools/contracts";
import { ArchiveIcon, ArchiveRestoreIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { useCommandCenter, useCommandCenterCommands } from "../shared";
import { agentProfileInput } from "./AgentDrawer";
import { teamColorClass } from "./TeamForms";

/** Replaces one team, keeping every field; upserting an archived row restores it. */
function teamInput(team: CommandCenterTeam) {
  const { createdAt: _c, updatedAt: _u, archivedAt: _a, ...value } = team;
  return { entity: "team" as const, value };
}

type ArchivedRow =
  | { readonly kind: "team"; readonly row: CommandCenterTeam }
  | { readonly kind: "agent"; readonly row: CommandCenterAgentProfile };

/** Archived teams and agents with Restore, the way back from Archive. Renders nothing when empty. */
export function ArchivedTeam() {
  const { snapshot, canOperate } = useCommandCenter();
  const commands = useCommandCenterCommands();
  const [restoring, setRestoring] = useState<string | null>(null);
  const rows: ArchivedRow[] = [
    ...snapshot.teams.flatMap((row) =>
      row.archivedAt === null ? [] : [{ kind: "team" as const, row }],
    ),
    ...snapshot.agentProfiles.flatMap((row) =>
      row.archivedAt === null ? [] : [{ kind: "agent" as const, row }],
    ),
  ];
  if (rows.length === 0) return null;

  const restore = async (item: ArchivedRow) => {
    setRestoring(item.row.id);
    await commands.upsert(
      item.kind === "team" ? teamInput(item.row) : agentProfileInput(item.row, {}),
    );
    setRestoring(null);
  };
  const teamName = (agent: CommandCenterAgentProfile) =>
    snapshot.teams.find((team) => team.id === agent.teamId)?.name ?? null;

  return (
    <Collapsible>
      <CollapsibleTrigger render={<Button size="sm" variant="ghost-muted" />}>
        <ArchiveIcon />
        Archived ({rows.length})
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ul className="mt-2 divide-y rounded-xl border bg-card px-3 text-sm">
          {rows.map((item) => (
            <li key={item.row.id} className="flex items-center gap-3 py-2">
              {item.kind === "team" ? (
                <span className={cn("size-2.5 rounded-full", teamColorClass(item.row.color))} />
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.row.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {item.kind === "team"
                    ? "Team"
                    : [item.row.role || "Agent", teamName(item.row)].filter(Boolean).join(" · ")}
                </span>
              </span>
              <Button
                size="xs"
                variant="outline"
                disabled={!canOperate || restoring !== null}
                onClick={() => void restore(item)}
              >
                <ArchiveRestoreIcon />
                Restore
              </Button>
            </li>
          ))}
        </ul>
      </CollapsiblePanel>
    </Collapsible>
  );
}
