import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { randomUUID } from "../../lib/utils";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  quickActionError,
  resolveCommandCenterSections,
  type QuickAction,
} from "../commandCenter/customization";
import { COMMAND_CENTER_TABS } from "../commandCenter/tabs";
import {
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE,
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

function moveItem<T>(items: readonly T[], index: number, direction: number) {
  const next = [...items];
  const destination = index + direction;
  if (destination < 0 || destination >= next.length) return next;
  [next[index], next[destination]] = [next[destination]!, next[index]!];
  return next;
}

function ActionEditor({
  action,
  onSave,
  onCancel,
  sections,
}: {
  action: QuickAction | null;
  onSave: (action: QuickAction) => void;
  onCancel: () => void;
  sections: ReturnType<typeof resolveCommandCenterSections>;
}) {
  const [label, setLabel] = useState(action?.label ?? "");
  const [kind, setKind] = useState<QuickAction["kind"]>(action?.kind ?? "section");
  const [target, setTarget] = useState(action?.target ?? "team");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-3 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const draft = {
          id: action?.id ?? randomUUID(),
          label: label.trim(),
          kind,
          target: target.trim(),
        };
        const problem = quickActionError(draft);
        setError(problem);
        if (!problem) onSave(draft);
      }}
    >
      <label className="grid gap-1.5 text-sm">
        Name
        <Input
          autoFocus
          value={label}
          maxLength={80}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <div className="grid gap-1.5 text-sm">
        <span id="action-type-label">Action</span>
        <Select
          value={kind}
          onValueChange={(value) => {
            if (value !== "section" && value !== "link" && value !== "prompt") return;
            setKind(value);
            setTarget(value === "section" ? "team" : "");
            setError(null);
          }}
        >
          <SelectTrigger aria-labelledby="action-type-label">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="section">Open a tab</SelectItem>
            <SelectItem value="link">Open a link</SelectItem>
            <SelectItem value="prompt">Prepare an instruction</SelectItem>
          </SelectPopup>
        </Select>
      </div>
      {kind === "section" ? (
        <div className="grid gap-1.5 text-sm">
          <span id="action-section-label">Tab</span>
          <Select
            value={target}
            onValueChange={(value) => {
              if (value) setTarget(value);
            }}
          >
            <SelectTrigger aria-labelledby="action-section-label">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {sections.map((section) => (
                <SelectItem key={section.id} value={section.id}>
                  {section.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : (
        <label className="grid gap-1.5 text-sm">
          {kind === "link" ? "Link or app path" : "Instruction"}
          <Input
            value={target}
            maxLength={4000}
            placeholder={kind === "link" ? "https://… or /usage" : "What should the team do?"}
            onChange={(event) => setTarget(event.target.value)}
          />
        </label>
      )}
      {kind === "prompt" ? (
        <p className="text-sm text-muted-foreground">
          Prepares text in the panel. You review and submit it yourself.
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          Save action
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Command Center lives on the primary server, so its settings ignore the settings scope. */
export function CommandCenterSettingsPanel() {
  const settings = usePrimarySettings((value) => value.commandCenter);
  const updateSettings = useUpdatePrimarySettings();
  const primary = usePrimaryEnvironment();
  const available = usePrimarySettingsAvailable();
  const canWrite =
    useEnvironmentScope(primary?.environmentId ?? null, AuthSettingsWriteScope) && available;
  const sections = resolveCommandCenterSections(settings.sections);
  const actions = settings.quickActions;
  const [editing, setEditing] = useState<string | null>(null);
  const saveSections = (next: typeof sections) =>
    updateSettings({ commandCenter: { sections: next } });
  const saveActions = (next: typeof actions) =>
    updateSettings({ commandCenter: { quickActions: next } });
  const editedAction = actions.find((action) => action.id === editing) ?? null;

  return (
    <SettingsPageContainer>
      <p className="text-sm text-muted-foreground">
        Turn Command Center on or off for each server in{" "}
        <Link to="/settings/general" className="text-foreground underline underline-offset-4">
          General
        </Link>
        .
      </p>
      <fieldset disabled={!canWrite} className="min-w-0 space-y-6">
        <SettingsSection
          id="command-center-tabs"
          title="Tabs"
          headerAction={
            <Button size="sm" variant="ghost" onClick={() => saveSections([])}>
              Restore tabs
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground">
            Customize the web and desktop panel. Hidden tabs keep their data and can still be opened
            by a direct link or quick action. Keep at least one tab visible.
          </p>
          <SettingsGroup>
            {sections.map((section, index) => (
              <div key={section.id} className="flex flex-wrap items-center gap-2 p-3">
                <Switch
                  checked={section.visible}
                  aria-label={`Show ${section.label}`}
                  disabled={section.visible && sections.filter((item) => item.visible).length === 1}
                  onCheckedChange={(visible) =>
                    saveSections(
                      sections.map((item) =>
                        item.id === section.id ? { ...item, visible: Boolean(visible) } : item,
                      ),
                    )
                  }
                />
                <form
                  className="flex min-w-32 flex-1 items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const label =
                      String(new FormData(event.currentTarget).get("sectionName")).trim() ||
                      COMMAND_CENTER_TABS.find((tab) => tab.value === section.id)!.label;
                    const input = event.currentTarget.elements.namedItem("sectionName");
                    if (input instanceof HTMLInputElement) input.value = label;
                    if (label !== section.label)
                      saveSections(
                        sections.map((item) =>
                          item.id === section.id ? { ...item, label } : item,
                        ),
                      );
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <Input
                      key={section.label}
                      name="sectionName"
                      defaultValue={section.label}
                      maxLength={80}
                      aria-label={`Name for ${section.id}`}
                    />
                  </div>
                  <Button
                    type="submit"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Save name for ${section.id}`}
                  >
                    <CheckIcon />
                  </Button>
                </form>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Move ${section.label} up`}
                  disabled={index === 0}
                  onClick={() => saveSections(moveItem(sections, index, -1))}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Move ${section.label} down`}
                  disabled={index === sections.length - 1}
                  onClick={() => saveSections(moveItem(sections, index, 1))}
                >
                  <ArrowDownIcon />
                </Button>
              </div>
            ))}
          </SettingsGroup>
        </SettingsSection>
        <SettingsSection
          id="command-center-actions"
          title="Quick actions"
          headerAction={
            <Button
              size="sm"
              variant="ghost"
              disabled={actions.length >= 20}
              onClick={() => setEditing("new")}
            >
              <PlusIcon />
              Add action
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground">
            Add up to 20 shortcuts to tabs, links, app pages or instructions. They appear in Launch,
            on Home and in the command palette.
          </p>
          <SettingsGroup>
            {actions.length === 0 && editing === null ? (
              <p className="p-4 text-sm text-muted-foreground">No quick actions yet.</p>
            ) : null}
            {actions.map((action, index) => (
              <div key={action.id} className="flex flex-wrap items-center gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{action.label}</p>
                  <p className="truncate text-xs text-muted-foreground">{action.target}</p>
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Move ${action.label} up`}
                  disabled={index === 0}
                  onClick={() => saveActions(moveItem(actions, index, -1))}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Move ${action.label} down`}
                  disabled={index === actions.length - 1}
                  onClick={() => saveActions(moveItem(actions, index, 1))}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Edit ${action.label}`}
                  onClick={() => setEditing(action.id)}
                >
                  <PencilIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${action.label}`}
                  onClick={() => {
                    saveActions(actions.filter((item) => item.id !== action.id));
                    if (editing === action.id) setEditing(null);
                  }}
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
            {editing !== null ? (
              <ActionEditor
                key={`${editing}:${JSON.stringify(editedAction)}`}
                action={editedAction}
                sections={sections}
                onCancel={() => setEditing(null)}
                onSave={(action) => {
                  saveActions(
                    editedAction
                      ? actions.map((item) => (item.id === action.id ? action : item))
                      : [...actions, action],
                  );
                  setEditing(null);
                }}
              />
            ) : null}
          </SettingsGroup>
        </SettingsSection>
      </fieldset>
      {!canWrite ? (
        <p className="text-sm text-muted-foreground">
          {!available
            ? PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE
            : `This connection lacks permission to change settings on ${primary?.label ?? "the primary environment"}.`}
        </p>
      ) : null}
    </SettingsPageContainer>
  );
}
