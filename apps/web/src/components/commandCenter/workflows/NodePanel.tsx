import { useAtomValue } from "@effect/atom-react";
import {
  type CommandCenterAgentProfile,
  type CommandCenterSkillSummary,
  type CommandCenterWorkflow,
  type CommandCenterWorkflowEdge,
  type CommandCenterWorkflowNode,
  type CommandCenterWorkflowNodeId,
  CommandCenterWorkflowGateCheck,
  CommandCenterWorkflowOutput,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";
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
import { scheduledTaskDefaultModel } from "../../settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../../settings/settingsLayout";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";
import { type TextRewrite, TextOptimizer } from "./text/TextOptimizer";
import {
  GATE_CHECK_LABEL,
  NODE_KIND_LABEL,
  nodeTitle,
  omitKey,
  OUTPUT_LABEL,
  parallelParentOf,
  profileLabel,
} from "./workflowLogic";

const DEFAULT_PROFILE = "__default";
const CUSTOM_PROFILE = "__custom";
const isGateCheck = Schema.is(CommandCenterWorkflowGateCheck);
const isOutput = Schema.is(CommandCenterWorkflowOutput);

/** Names its control through the group, since fields hold inputs, selects and checkboxes. */
export function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="space-y-1.5">
      <Label id={labelId}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function Problems({ errors }: { readonly errors: ReadonlyArray<string> }) {
  if (errors.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs text-destructive-foreground" role="alert">
      {errors.map((error) => (
        <li key={error}>{error}</li>
      ))}
    </ul>
  );
}

export interface NodePanelProps {
  readonly workflow: CommandCenterWorkflow;
  readonly node: CommandCenterWorkflowNode;
  readonly problems: ReadonlyArray<string>;
  readonly agents: ReadonlyArray<CommandCenterAgentProfile>;
  /** The project's skills; null while loading. */
  readonly skills: ReadonlyArray<CommandCenterSkillSummary> | null;
  /** Where the project lives; models come from its providers. */
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  /** "Rewrite shorter" for prompts; absent without the grant. */
  readonly rewrite?: TextRewrite | undefined;
  /** `field` groups typing in one field into one undo step. */
  readonly onChange: (node: CommandCenterWorkflowNode, field: string) => void;
  /** Resolves to an error to show, or null once renamed. */
  readonly onRename: (id: string) => string | null;
  readonly onConnect: (from: CommandCenterWorkflowNodeId, to: CommandCenterWorkflowNodeId) => void;
  readonly onDisconnect: (edge: CommandCenterWorkflowEdge) => void;
  readonly onRemove: () => void;
}

/** Edits the selected node. Every change goes straight into the draft; Save writes the file. */
export function NodePanel(props: NodePanelProps) {
  const { workflow, node, problems, disabled, onChange } = props;
  const parent = parallelParentOf(workflow, node.id);

  return (
    <fieldset disabled={disabled} className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">
          {NODE_KIND_LABEL[node.kind]} · {nodeTitle(node)}
        </h3>
        <Button size="sm" variant="ghost-destructive" onClick={props.onRemove}>
          <Trash2Icon />
          Delete
        </Button>
      </div>
      <Problems errors={problems} />
      <IdField key={node.id} id={node.id} onRename={props.onRename} />
      <Field label="Title">
        <Input
          value={node.title ?? ""}
          placeholder={node.id}
          onChange={(event) => {
            const title = event.target.value;
            onChange(title.trim() === "" ? omitKey(node, "title") : { ...node, title }, "title");
          }}
        />
      </Field>

      {node.kind === "agent" ? (
        <>
          <Field
            label="Prompt"
            hint="Use {{input:name}} for an input and {{snippet:name}} for a shared snippet."
          >
            <Textarea
              size="lg"
              value={node.prompt}
              placeholder="What this agent should do."
              onChange={(event) => onChange({ ...node, prompt: event.target.value }, "prompt")}
            />
            <TextOptimizer
              value={node.prompt}
              onChange={(prompt) => onChange({ ...node, prompt }, "prompt-optimized")}
              kind="prompt"
              rewrite={props.rewrite}
            />
          </Field>
          <ProfileField
            profile={node.profile}
            agents={props.agents}
            environmentId={props.environmentId}
            disabled={disabled}
            onChange={(profile) =>
              onChange(
                profile === undefined ? omitKey(node, "profile") : { ...node, profile },
                "profile",
              )
            }
          />
          <SkillsField
            selected={node.skills}
            skills={props.skills}
            onChange={(skills) => onChange({ ...node, skills }, "skills")}
          />
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`${node.id}-worktree`}>Work in its own worktree</Label>
            <Switch
              id={`${node.id}-worktree`}
              checked={node.worktree}
              onCheckedChange={(worktree) => onChange({ ...node, worktree }, "worktree")}
            />
          </div>
          <Field label="Hands on" hint="What the next steps receive from this one.">
            <Select
              value={node.outputs}
              onValueChange={(value) =>
                isOutput(value) && onChange({ ...node, outputs: value }, "outputs")
              }
            >
              <SelectTrigger aria-label="Hands on">
                <SelectValue>{OUTPUT_LABEL[node.outputs]}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {Object.entries(OUTPUT_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
        </>
      ) : node.kind === "skill" ? (
        <>
          <Field label="Skill" hint="Runs in a cheap agent.">
            <Select
              value={node.skill}
              onValueChange={(value) => {
                const skill = props.skills?.find((candidate) => candidate.name === value);
                if (skill) onChange({ ...node, skill: skill.name }, "skill");
              }}
            >
              <SelectTrigger aria-label="Skill">
                <SelectValue>{node.skill}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {(props.skills ?? []).map((skill) => (
                  <SelectItem key={skill.name} value={skill.name}>
                    {skill.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field label="Arguments">
            <Textarea
              value={node.args ?? ""}
              placeholder="Optional text passed to the skill."
              onChange={(event) => onChange({ ...node, args: event.target.value }, "args")}
            />
            <TextOptimizer
              value={node.args ?? ""}
              onChange={(args) => onChange({ ...node, args }, "args-optimized")}
              kind="prompt"
              rewrite={props.rewrite}
            />
          </Field>
        </>
      ) : node.kind === "ask" ? (
        <>
          <Field label="Question" hint="The run pauses here until you answer.">
            <Textarea
              value={node.question}
              onChange={(event) => onChange({ ...node, question: event.target.value }, "question")}
            />
          </Field>
          <ChoicesField
            key={node.id}
            choices={node.choices ?? []}
            onChange={(choices) =>
              onChange(
                choices.length === 0 ? omitKey(node, "choices") : { ...node, choices },
                "choices",
              )
            }
          />
        </>
      ) : node.kind === "parallel" ? (
        <>
          <Field
            label="For each item of"
            hint="An input, or a step whose reply is a list (JSON array or one item per line)."
          >
            <Select
              value={node.over}
              onValueChange={(value) => value && onChange({ ...node, over: value }, "over")}
            >
              <SelectTrigger aria-label="For each item of">
                <SelectValue>{node.over || "Pick an input or step"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {workflow.inputs.map((input) => (
                  <SelectItem key={`input:${input.name}`} value={input.name}>
                    Input: {input.label}
                  </SelectItem>
                ))}
                {workflow.nodes
                  .filter((candidate) => candidate.id !== node.id && candidate.id !== node.node)
                  .map((candidate) => (
                    <SelectItem key={`node:${candidate.id}`} value={candidate.id}>
                      Step: {nodeTitle(candidate)}
                    </SelectItem>
                  ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field label="Run" hint="An agent or skill step with no connections of its own.">
            <Select
              value={node.node}
              onValueChange={(value) => {
                const body = workflow.nodes.find((candidate) => candidate.id === value);
                if (body) onChange({ ...node, node: body.id }, "node");
              }}
            >
              <SelectTrigger aria-label="Step to run for each item">
                <SelectValue>{node.node}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {workflow.nodes
                  .filter((candidate) => candidate.kind === "agent" || candidate.kind === "skill")
                  .map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {nodeTitle(candidate)}
                    </SelectItem>
                  ))}
              </SelectPopup>
            </Select>
          </Field>
        </>
      ) : (
        <Field
          label="Check"
          hint={
            node.check === "manual"
              ? "The run waits for you to approve or reject."
              : "A cheap agent runs it; the run continues only when it passes."
          }
        >
          <Select
            value={node.check}
            onValueChange={(value) =>
              isGateCheck(value) && onChange({ ...node, check: value }, "check")
            }
          >
            <SelectTrigger aria-label="Check">
              <SelectValue>{GATE_CHECK_LABEL[node.check]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {Object.entries(GATE_CHECK_LABEL).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
      )}

      {parent ? (
        <p className="text-xs text-muted-foreground">
          Runs once per item inside {nodeTitle(parent)}, so it has no connections of its own.
        </p>
      ) : (
        <ConnectionsField {...props} />
      )}
    </fieldset>
  );
}

function IdField({
  id,
  onRename,
}: {
  readonly id: string;
  readonly onRename: NodePanelProps["onRename"];
}) {
  const [value, setValue] = useState(id);
  const [error, setError] = useState<string | null>(null);
  const commit = () => {
    const problem = onRename(value);
    setError(problem);
    if (problem === null) setValue(value.trim());
  };
  return (
    <Field label="Id" hint={error ?? "Other steps and parallel nodes refer to it by this id."}>
      <Input
        value={value}
        aria-invalid={error !== null || undefined}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
    </Field>
  );
}

const parseChoices = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

function ChoicesField({
  choices,
  onChange,
}: {
  readonly choices: ReadonlyArray<string>;
  readonly onChange: (choices: string[]) => void;
}) {
  // Kept as typed so blank lines survive while editing; the node gets the non-empty ones.
  const [text, setText] = useState(choices.join("\n"));
  // Undo, redo or a reloaded file changed the choices: show theirs.
  if (parseChoices(text).join("\n") !== choices.join("\n")) setText(choices.join("\n"));
  return (
    <Field
      label="Choices"
      hint="One per line. The first continues the run; any other stops it (resume asks again). Leave empty for a free answer."
    >
      <Textarea
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onChange(parseChoices(event.target.value));
        }}
      />
    </Field>
  );
}

function SkillsField({
  selected,
  skills,
  onChange,
}: {
  readonly selected: ReadonlyArray<CommandCenterSkillSummary["name"]>;
  readonly skills: ReadonlyArray<CommandCenterSkillSummary> | null;
  readonly onChange: (skills: Array<CommandCenterSkillSummary["name"]>) => void;
}) {
  const known = new Set((skills ?? []).map((skill) => skill.name as string));
  const missing = selected.filter((name) => !known.has(name));
  return (
    <Field
      label="Skills"
      hint={
        skills === null
          ? "Loading skills…"
          : skills.length === 0
            ? "This project has no skills in .agents/skills or .claude/skills yet."
            : "Listed in the prompt so the agent uses them."
      }
    >
      <div className="flex flex-col gap-1.5">
        {(skills ?? []).map((skill) => (
          <label key={skill.name} className="flex min-w-0 items-start gap-2 text-sm">
            <Checkbox
              checked={selected.includes(skill.name)}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...selected, skill.name]
                    : selected.filter((name) => name !== skill.name),
                )
              }
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{skill.name}</span>
              {skill.description ? (
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {skill.description}
                </span>
              ) : null}
            </span>
          </label>
        ))}
        {missing.map((name) => (
          <div key={name} className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{name} (not in this project)</span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Remove ${name}`}
              onClick={() => onChange(selected.filter((current) => current !== name))}
            >
              <XIcon />
            </Button>
          </div>
        ))}
      </div>
    </Field>
  );
}

type AgentProfile = Extract<CommandCenterWorkflowNode, { kind: "agent" }>["profile"];

/** A Command Center agent (its role and model), a model picked here, or the server default. */
function ProfileField({
  profile,
  agents,
  environmentId,
  disabled,
  onChange,
}: {
  readonly profile: AgentProfile;
  readonly agents: ReadonlyArray<CommandCenterAgentProfile>;
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onChange: (profile: AgentProfile) => void;
}) {
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
  const selection = typeof profile === "object" ? profile : null;
  const activeInstanceId = selection?.instanceId ?? instanceEntries[0]?.instanceId ?? null;
  const activeModel = selection?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, activeInstanceId, activeModel),
    [settings, providers, activeInstanceId, activeModel],
  );
  const live = agents.filter((agent) => agent.archivedAt === null);
  const value =
    profile === undefined
      ? DEFAULT_PROFILE
      : typeof profile === "string"
        ? (agents.find((agent) => agent.id === profile || agent.name === profile)?.id ?? profile)
        : CUSTOM_PROFILE;

  return (
    <Field
      label="Agent"
      hint={
        typeof profile === "string" && !agents.some((agent) => agent.id === value)
          ? "This agent is not in Command Center; the run uses the default model."
          : "A Command Center agent brings its role prompt and model."
      }
    >
      <Select
        value={value}
        onValueChange={(next) => {
          if (next === DEFAULT_PROFILE) onChange(undefined);
          else if (next === CUSTOM_PROFILE) {
            const fallback = scheduledTaskDefaultModel(settings, null, instanceEntries);
            if (fallback) onChange(fallback);
          } else {
            const agent = agents.find((candidate) => candidate.id === next);
            if (agent) onChange(agent.id);
          }
        }}
      >
        <SelectTrigger aria-label="Agent">
          <SelectValue>
            {value === CUSTOM_PROFILE ? "Pick a model" : profileLabel(profile, agents)}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={DEFAULT_PROFILE}>Default model</SelectItem>
          {live.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {agent.name}
              {agent.role ? ` · ${agent.role}` : ""}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_PROFILE} disabled={instanceEntries.length === 0}>
            Pick a model…
          </SelectItem>
        </SelectPopup>
      </Select>
      {selection && activeInstanceId !== null ? (
        <ProviderModelPicker
          environmentId={environmentId}
          disabled={disabled}
          activeInstanceId={activeInstanceId}
          model={activeModel}
          lockedProvider={null}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          isComposerOwned={false}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          onInstanceModelChange={(instanceId, model) => {
            if (selection.instanceId !== instanceId || selection.model !== model) {
              onChange({ instanceId, model });
            }
          }}
        />
      ) : null}
    </Field>
  );
}

function ConnectionsField({ workflow, node, onConnect, onDisconnect }: NodePanelProps) {
  const incoming = workflow.edges.filter((edge) => edge.to === node.id);
  const bodies = new Set(
    workflow.nodes.flatMap((candidate) => (candidate.kind === "parallel" ? [candidate.node] : [])),
  );
  const candidates = workflow.nodes.filter(
    (candidate) =>
      candidate.id !== node.id &&
      !bodies.has(candidate.id) &&
      !incoming.some((edge) => edge.from === candidate.id),
  );
  const titleOf = (id: string) => {
    const found = workflow.nodes.find((candidate) => candidate.id === id);
    return found ? nodeTitle(found) : id;
  };
  return (
    <Field label="Runs after" hint="Starts once every step listed here is done.">
      <div className="flex flex-col gap-1">
        {incoming.length === 0 ? (
          <p className="text-sm text-muted-foreground">Starts when the run starts.</p>
        ) : (
          incoming.map((edge) => (
            <div key={edge.from} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{titleOf(edge.from)}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Stop waiting for ${titleOf(edge.from)}`}
                onClick={() => onDisconnect(edge)}
              >
                <XIcon />
              </Button>
            </div>
          ))
        )}
        {candidates.length > 0 ? (
          <Select
            value=""
            onValueChange={(value) => {
              const from = candidates.find((candidate) => candidate.id === value);
              if (from) onConnect(from.id, node.id);
            }}
          >
            <SelectTrigger aria-label="Add a step this one waits for" size="sm">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <PlusIcon className="size-3.5" />
                Wait for another step
              </span>
            </SelectTrigger>
            <SelectPopup>
              {candidates.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {nodeTitle(candidate)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
      </div>
    </Field>
  );
}
