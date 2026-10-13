import { useAtomValue } from "@effect/atom-react";
import type {
  CommandCenterAgentProfile,
  CommandCenterTeam,
  CommandCenterTeamId,
  EnvironmentId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { ArchiveIcon } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { ProviderModelPicker } from "../../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../../chat/runtimeModeConfig";
import { scheduledTaskDefaultModel } from "../../settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../../settings/settingsLayout";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Textarea } from "../../ui/textarea";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import {
  useCommandCenter,
  useCommandCenterCommands,
  useCommandCenterEnvironments,
} from "../shared";

/** Team colors are stored by name; the class map keeps Tailwind able to see every class. */
export const TEAM_COLORS = {
  sky: "bg-sky-500",
  violet: "bg-violet-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  slate: "bg-slate-500",
} as const;
export type TeamColor = keyof typeof TEAM_COLORS;

export function teamColorClass(color: string) {
  return color in TEAM_COLORS ? TEAM_COLORS[color as TeamColor] : TEAM_COLORS.slate;
}

const NONE = "__none";

/** Names its control through the group, since fields hold inputs, selects and toggle groups. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="space-y-1.5">
      <Label id={labelId}>{label}</Label>
      {children}
    </div>
  );
}

function FormDialog({
  title,
  saving,
  canSave,
  onClose,
  onSave,
  footerStart,
  children,
}: {
  title: string;
  saving: boolean;
  canSave: boolean;
  onClose: () => void;
  onSave: () => void;
  /** Left-aligned footer action, such as Archive. */
  footerStart?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-lg">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <fieldset disabled={saving} className="space-y-4">
              {children}
            </fieldset>
          </DialogPanel>
          <DialogFooter>
            {footerStart ? <div className="me-auto">{footerStart}</div> : null}
            <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
              Cancel
            </DialogClose>
            <Button type="submit" size="sm" disabled={saving || !canSave}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function TeamDialog({
  team,
  onClose,
}: {
  readonly team: CommandCenterTeam | null;
  readonly onClose: () => void;
}) {
  const { snapshot } = useCommandCenter();
  const commands = useCommandCenterCommands();
  const environments = useCommandCenterEnvironments();
  const [name, setName] = useState(team?.name ?? "");
  const [color, setColor] = useState(team?.color ?? "sky");
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(
    team?.environmentId ?? null,
  );
  const [leadAgentId, setLeadAgentId] = useState(team?.leadAgentId ?? null);
  const [saving, setSaving] = useState(false);
  const members = team
    ? snapshot.agentProfiles.filter((agent) => agent.teamId === team.id && !agent.archivedAt)
    : [];

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const result = await commands.upsert({
      entity: "team",
      value: {
        ...(team ? { id: team.id } : {}),
        name: name.trim(),
        color,
        leadAgentId,
        environmentId,
        sortKey: team?.sortKey ?? snapshot.teams.length,
      },
    });
    setSaving(false);
    if (result._tag === "Success") onClose();
  };
  // Agents keep their team id, so restoring the team (Team tab, Archived) brings them back with it.
  const archive = async () => {
    if (!team) return;
    setSaving(true);
    const result = await commands.remove({ entity: "team", id: team.id });
    setSaving(false);
    if (result._tag === "Success") onClose();
  };

  return (
    <FormDialog
      title={team ? "Edit team" : "New team"}
      saving={saving}
      canSave={name.trim().length > 0}
      onClose={onClose}
      onSave={() => void save()}
      footerStart={
        team ? (
          <Button
            type="button"
            size="sm"
            variant="ghost-destructive"
            disabled={saving}
            onClick={() => void archive()}
          >
            <ArchiveIcon />
            Archive
          </Button>
        ) : null
      }
    >
      <Field label="Name">
        <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
      </Field>
      <Field label="Color">
        <ToggleGroup
          aria-label="Team color"
          value={[color]}
          onValueChange={(next) => next[0] && setColor(next[0])}
        >
          {Object.entries(TEAM_COLORS).map(([value, swatch]) => (
            <Toggle key={value} value={value} aria-label={value} size="sm">
              <span className={`size-3 rounded-full ${swatch}`} />
            </Toggle>
          ))}
        </ToggleGroup>
      </Field>
      <Field label="Machine">
        <Select
          value={environmentId ?? NONE}
          onValueChange={(value) =>
            setEnvironmentId(
              environments.find((environment) => environment.environmentId === value)
                ?.environmentId ?? null,
            )
          }
        >
          <SelectTrigger aria-label="Machine">
            <SelectValue>
              {environments.find((environment) => environment.environmentId === environmentId)
                ?.label ?? "Primary machine"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={NONE}>Primary machine</SelectItem>
            {environments.map((environment) => (
              <SelectItem key={environment.environmentId} value={environment.environmentId}>
                {environment.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      {members.length > 0 ? (
        <Field label="Lead">
          <Select
            value={leadAgentId ?? NONE}
            onValueChange={(value) =>
              setLeadAgentId(members.find((agent) => agent.id === value)?.id ?? null)
            }
          >
            <SelectTrigger aria-label="Lead">
              <SelectValue>
                {members.find((agent) => agent.id === leadAgentId)?.name ?? "No lead"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={NONE}>No lead</SelectItem>
              {members.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
      ) : null}
    </FormDialog>
  );
}

export function AgentDialog({
  agent,
  teamId: initialTeamId,
  onClose,
}: {
  readonly agent: CommandCenterAgentProfile | null;
  /** Team preselected for a new agent. */
  readonly teamId: CommandCenterTeamId | null;
  readonly onClose: () => void;
}) {
  const { snapshot, primaryEnvironmentId } = useCommandCenter();
  const commands = useCommandCenterCommands();
  const [name, setName] = useState(agent?.name ?? "");
  const [avatar, setAvatar] = useState(agent?.avatar ?? "");
  const [role, setRole] = useState(agent?.role ?? "");
  const [rolePrompt, setRolePrompt] = useState(agent?.rolePrompt ?? "");
  const [teamId, setTeamId] = useState(agent?.teamId ?? initialTeamId);
  const [selection, setSelection] = useState<ModelSelection | null>(agent?.modelSelection ?? null);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(agent?.runtimeMode ?? "full-access");
  const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>(
    agent?.interactionMode ?? "default",
  );
  const [saving, setSaving] = useState(false);
  const teams = snapshot.teams.filter((team) => !team.archivedAt);

  // Models come from the machine the agent's team runs on.
  const environmentId =
    teams.find((team) => team.id === teamId)?.environmentId ?? primaryEnvironmentId;
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
      ),
    [providers, settings],
  );
  const activeSelection = selection ?? scheduledTaskDefaultModel(settings, null, instanceEntries);
  const activeInstanceId = activeSelection?.instanceId ?? instanceEntries[0]?.instanceId ?? null;
  const activeModel = activeSelection?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, activeInstanceId, activeModel),
    [settings, providers, activeInstanceId, activeModel],
  );

  const canSave = name.trim().length > 0 && activeSelection !== null;
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const result = await commands.upsert({
      entity: "agentProfile",
      value: {
        ...(agent ? { id: agent.id } : {}),
        name: name.trim(),
        avatar: avatar.trim() || null,
        role: role.trim(),
        rolePrompt: rolePrompt.trim(),
        modelSelection: activeSelection,
        runtimeMode,
        interactionMode,
        teamId,
        sortKey: agent?.sortKey ?? snapshot.agentProfiles.length,
      },
    });
    setSaving(false);
    if (result._tag === "Success") onClose();
  };

  return (
    <FormDialog
      title={agent ? "Edit agent" : "New agent"}
      saving={saving}
      canSave={canSave}
      onClose={onClose}
      onSave={() => void save()}
    >
      <div className="grid grid-cols-[1fr_6rem] gap-3">
        <Field label="Name">
          <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </Field>
        <Field label="Avatar">
          <Input
            value={avatar}
            placeholder="AB"
            maxLength={4}
            onChange={(event) => setAvatar(event.target.value)}
          />
        </Field>
      </div>
      <Field label="Role">
        <Input
          value={role}
          placeholder="Frontend developer"
          onChange={(event) => setRole(event.target.value)}
        />
      </Field>
      <Field label="Role prompt">
        <Textarea
          value={rolePrompt}
          placeholder="Who this agent is and how it works. Sent before every task."
          onChange={(event) => setRolePrompt(event.target.value)}
        />
      </Field>
      <Field label="Team">
        <Select
          value={teamId ?? NONE}
          onValueChange={(value) => setTeamId(teams.find((team) => team.id === value)?.id ?? null)}
        >
          <SelectTrigger aria-label="Team">
            <SelectValue>{teams.find((team) => team.id === teamId)?.name ?? "No team"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={NONE}>No team</SelectItem>
            {teams.map((team) => (
              <SelectItem key={team.id} value={team.id}>
                {team.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>
      <Field label="Model">
        {activeInstanceId === null ? (
          <p className="text-sm text-muted-foreground">No providers on this machine.</p>
        ) : (
          <ProviderModelPicker
            environmentId={environmentId}
            disabled={saving}
            activeInstanceId={activeInstanceId}
            model={activeModel}
            lockedProvider={null}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={modelOptionsByInstance}
            isComposerOwned={false}
            triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
            onInstanceModelChange={(instanceId, model) =>
              setSelection((current) =>
                current?.instanceId === instanceId && current.model === model
                  ? current
                  : { instanceId, model },
              )
            }
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Access">
          <Select
            value={runtimeMode}
            onValueChange={(value) => {
              const mode = runtimeModeOptions.find((option) => option === value);
              if (mode) setRuntimeMode(mode);
            }}
          >
            <SelectTrigger aria-label="Access">
              <SelectValue>{runtimeModeConfig[runtimeMode].label}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {runtimeModeOptions.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {runtimeModeConfig[mode].label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
        <Field label="Mode">
          <ToggleGroup
            aria-label="Interaction mode"
            variant="segmented"
            value={[interactionMode]}
            onValueChange={(next) => {
              if (next[0] === "default" || next[0] === "plan") setInteractionMode(next[0]);
            }}
          >
            <Toggle value="default">Build</Toggle>
            <Toggle value="plan">Plan</Toggle>
          </ToggleGroup>
        </Field>
      </div>
    </FormDialog>
  );
}
