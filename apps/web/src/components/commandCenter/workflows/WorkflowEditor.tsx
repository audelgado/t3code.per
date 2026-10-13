import {
  type CommandCenterSkillSummary,
  type CommandCenterWorkflow,
  type CommandCenterWorkflowDetail,
  type CommandCenterWorkflowNode,
  type CommandCenterWorkflowNodeKind,
  type CommandCenterWorkflowSlug,
  COMMAND_CENTER_WORKFLOW_NODE_KINDS,
  type EnvironmentId,
  parseCommandCenterWorkflow,
  type ProjectId,
} from "@t3tools/contracts";
import { ArrowLeftIcon, PlayIcon, PlusIcon, SaveIcon, Trash2Icon, Undo2Icon } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { Textarea } from "../../ui/textarea";
import { toastManager } from "../../ui/toast";
import { placeNewCard } from "../canvas/canvasLogic";
import { useCommandCenter } from "../shared";
import { NodePanel, Problems } from "./NodePanel";
import { useTextRewrite } from "./text/useTextRewrite";
import { WorkflowShortcutField } from "./WorkflowShortcutField";
import { SharedSnippetButton } from "./text/SharedSnippetButton";
import type { WorkflowCommands } from "./useWorkflowCommands";
import { NODE_KIND_ICON, WorkflowCanvas } from "./WorkflowCanvas";
import {
  addNode,
  checkDraft,
  connectNodes,
  describeNode,
  disconnectNodes,
  moveNode,
  NODE_HEIGHT,
  NODE_KIND_LABEL,
  NODE_LIMIT,
  NODE_WIDTH,
  nodePositions,
  nodeTitle,
  removeNode,
  renameNode,
  replaceNode,
  restoreNode,
} from "./workflowLogic";
import { WorkflowSettings } from "./WorkflowSettings";

/** Undo steps kept per editor. */
const HISTORY_LIMIT = 100;

interface Doc {
  readonly present: CommandCenterWorkflow;
  /** The file as last read or saved; equal to `present` means nothing to save. */
  readonly base: CommandCenterWorkflow;
  /** `updatedAt` of the file version `base` came from. */
  readonly known: string;
  readonly past: ReadonlyArray<CommandCenterWorkflow>;
  /** Field of the last edit, so typing in one field is one undo step. */
  readonly field: string | null;
}

const docFrom = (detail: CommandCenterWorkflowDetail, workflow: CommandCenterWorkflow): Doc => ({
  present: workflow,
  base: workflow,
  known: detail.updatedAt,
  past: [],
  field: null,
});

function isTextField(target: EventTarget) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  );
}

/**
 * Edits one workflow file: the graph on a canvas, the selected step (or the workflow) in a side
 * panel, problems inline. Save writes `.t3/workflows/<slug>.json`; a change to the file from
 * elsewhere reloads it, or asks first when there are unsaved edits.
 */
export function WorkflowEditor({
  environmentId,
  projectId,
  slug,
  fileUpdatedAt,
  commands,
  onBack,
  onRun,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly slug: CommandCenterWorkflowSlug;
  /** The file's modification time from the live list; null once it is gone, undefined unknown. */
  readonly fileUpdatedAt: string | null | undefined;
  readonly commands: WorkflowCommands;
  readonly onBack: () => void;
  readonly onRun: (workflow: CommandCenterWorkflow) => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.commandCenterWorkflow({ environmentId, input: { projectId, slug } }),
  );
  const detail = query.data;
  // The live list carries every change to the file (here, an agent's or an editor's); re-read
  // the file when its time moves past the version on screen.
  const refresh = query.refresh;
  const requested = useRef<string | null>(null);
  useEffect(() => {
    if (typeof fileUpdatedAt !== "string" || detail === null) return;
    if (fileUpdatedAt === detail.updatedAt || requested.current === fileUpdatedAt) return;
    requested.current = fileUpdatedAt;
    refresh();
  }, [detail, fileUpdatedAt, refresh]);

  // A new or copied file reaches the live list a moment after it is saved; it is gone only once
  // the list has had it.
  const [listed, setListed] = useState(false);
  if (typeof fileUpdatedAt === "string" && !listed) setListed(true);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [conflict, setConflict] = useState<CommandCenterWorkflowDetail | null>(null);
  const [seen, setSeen] = useState<CommandCenterWorkflowDetail | null>(null);
  if (detail !== null && detail !== seen) {
    setSeen(detail);
    if (doc === null || detail.updatedAt !== doc.known) {
      // Unsaved edits are never replaced without asking; a file that no longer parses opens raw.
      if (doc !== null && doc.present !== doc.base) setConflict(detail);
      else setDoc(detail.workflow === null ? null : docFrom(detail, detail.workflow));
    }
  }

  if (detail === null) {
    return (
      <section className="flex flex-col gap-3">
        <div>
          <Button size="sm" variant="ghost" onClick={onBack}>
            <ArrowLeftIcon />
            Workflows
          </Button>
        </div>
        <p className="py-12 text-center text-sm text-muted-foreground" role="status">
          {query.error ? `Could not open the workflow: ${query.error}` : "Opening the workflow…"}
        </p>
      </section>
    );
  }
  if (doc === null) {
    return (
      <RawWorkflowEditor
        detail={detail}
        canWrite={commands.canWrite}
        onBack={onBack}
        onSave={async (workflow) => {
          const result = await commands.save(workflow);
          return result._tag === "Success";
        }}
      />
    );
  }
  return (
    <GraphEditor
      environmentId={environmentId}
      projectId={projectId}
      doc={doc}
      setDoc={setDoc}
      conflict={conflict}
      onResolveConflict={(reload) => {
        if (conflict && reload) {
          setDoc(conflict.workflow === null ? null : docFrom(conflict, conflict.workflow));
        } else if (conflict) {
          setDoc((current) => current && { ...current, known: conflict.updatedAt });
        }
        setConflict(null);
      }}
      // A save overwrote the other change, so there is nothing left to decide.
      onSaved={() => setConflict(null)}
      fileGone={listed && fileUpdatedAt === null}
      commands={commands}
      onBack={onBack}
      onRun={onRun}
    />
  );
}

function GraphEditor({
  environmentId,
  projectId,
  doc,
  setDoc,
  conflict,
  onSaved,
  onResolveConflict,
  fileGone,
  commands,
  onBack,
  onRun,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly doc: Doc;
  readonly setDoc: (update: (current: Doc | null) => Doc | null) => void;
  readonly conflict: CommandCenterWorkflowDetail | null;
  readonly onSaved: () => void;
  readonly onResolveConflict: (reload: boolean) => void;
  readonly fileGone: boolean;
  readonly commands: WorkflowCommands;
  readonly onBack: () => void;
  readonly onRun: (workflow: CommandCenterWorkflow) => void;
}) {
  const { snapshot } = useCommandCenter();
  const skillsQuery = useEnvironmentQuery(
    serverEnvironment.commandCenterSkills({ environmentId, input: { projectId } }),
  );
  const skills: ReadonlyArray<CommandCenterSkillSummary> | null = skillsQuery.data?.skills ?? null;
  const draft = doc.present;
  const dirty = draft !== doc.base;
  const check = useMemo(() => checkDraft(draft), [draft]);
  const positions = useMemo(() => nodePositions(draft), [draft]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const selected = draft.nodes.find((node) => node.id === selectedId) ?? null;
  const disabled = !commands.canWrite || saving;
  const agents = snapshot.agentProfiles;
  const rewrite = useTextRewrite(environmentId, projectId);

  const apply = (next: CommandCenterWorkflow, field: string | null = null) =>
    setDoc((current) =>
      current === null || next === current.present
        ? current
        : {
            ...current,
            present: next,
            past:
              field !== null && current.field === field
                ? current.past
                : [...current.past.slice(-(HISTORY_LIMIT - 1)), current.present],
            field,
          },
    );
  const undo = () =>
    setDoc((current) => {
      const previous = current?.past.at(-1);
      return current && previous
        ? { ...current, present: previous, past: current.past.slice(0, -1), field: null }
        : current;
    });

  const add = (kind: CommandCenterWorkflowNodeKind) => {
    if (draft.nodes.length >= NODE_LIMIT) {
      toastManager.add({ type: "error", title: `A workflow holds up to ${NODE_LIMIT} steps` });
      return;
    }
    const from = selected ? positions.get(selected.id) : undefined;
    let maxX = 0;
    for (const point of positions.values()) maxX = Math.max(maxX, point.x + NODE_WIDTH);
    const start = from
      ? { x: from.x, y: from.y + NODE_HEIGHT + 48 }
      : { x: draft.nodes.length === 0 ? 40 : maxX + 72, y: 40 };
    const result = addNode(
      draft,
      kind,
      placeNewCard(start, positions.values()),
      skills?.[0]?.name ?? null,
    );
    apply(result.workflow);
    setSelectedId(result.id);
  };

  const remove = (id: string) => {
    const before = draft;
    const node = before.nodes.find((candidate) => candidate.id === id);
    if (!node) return;
    apply(removeNode(before, id));
    if (selectedId === id) setSelectedId(null);
    const toastId = toastManager.add({
      type: "info",
      title: `Deleted ${nodeTitle(node)}`,
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(toastId);
          setDoc((current) =>
            current
              ? {
                  ...current,
                  present: restoreNode(current.present, before, id),
                  past: [...current.past, current.present],
                  field: null,
                }
              : current,
          );
        },
      },
    });
  };

  const connect = (from: CommandCenterWorkflowNode["id"], to: CommandCenterWorkflowNode["id"]) => {
    const result = connectNodes(draft, from, to);
    if ("error" in result) toastManager.add({ type: "info", title: result.error });
    else apply(result.workflow);
  };

  const save = async () => {
    if (check.workflow === null || saving) return;
    setSaving(true);
    const result = await commands.save(check.workflow);
    setSaving(false);
    if (result._tag !== "Success") return;
    const saved = result.value;
    if (saved.workflow === null) return;
    const workflow = saved.workflow;
    setDoc(
      (current) =>
        current && {
          ...current,
          present: workflow,
          base: workflow,
          known: saved.updatedAt,
          field: null,
        },
    );
    onSaved();
    toastManager.add({ type: "success", title: "Workflow saved" });
  };

  const deleteWorkflow = async () => {
    if (await commands.removeWithUndo(draft.slug, draft.title)) onBack();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    // Save works from any field; undo in a text field is the field's own.
    if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    } else if (event.key.toLowerCase() === "z" && !event.shiftKey && !isTextField(event.target)) {
      event.preventDefault();
      undo();
    }
  };

  return (
    <section className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon />
          Workflows
        </Button>
        <h2 className="min-w-0 truncate text-sm font-medium">{draft.title || draft.slug}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {draft.nodes.length} / {NODE_LIMIT} steps
          {dirty ? " · unsaved" : ""}
        </span>
        <div className="min-w-0 flex-1" />
        {commands.canWrite ? (
          <>
            <SharedSnippetButton
              environmentId={environmentId}
              projectId={projectId}
              workflow={draft}
              onChange={(next) => apply(next)}
            />
            <Menu>
              <MenuTrigger render={<Button size="sm" variant="outline" disabled={disabled} />}>
                <PlusIcon />
                Add step
              </MenuTrigger>
              <MenuPopup align="end">
                {COMMAND_CENTER_WORKFLOW_NODE_KINDS.map((kind) => {
                  const Icon = NODE_KIND_ICON[kind];
                  const noSkills = kind === "skill" && (skills?.length ?? 0) === 0;
                  return (
                    <MenuItem key={kind} disabled={noSkills} onClick={() => add(kind)}>
                      <Icon />
                      {NODE_KIND_LABEL[kind]}
                      {noSkills ? " (no skills in this project)" : ""}
                    </MenuItem>
                  );
                })}
              </MenuPopup>
            </Menu>
            <Button
              size="sm"
              variant="outline"
              disabled={doc.past.length === 0 || disabled}
              title="Undo (Ctrl+Z)"
              onClick={undo}
            >
              <Undo2Icon />
              Undo
            </Button>
            <Button
              size="sm"
              variant="ghost-destructive"
              disabled={disabled || fileGone}
              onClick={() => void deleteWorkflow()}
            >
              <Trash2Icon />
              Delete
            </Button>
            <Button
              size="sm"
              disabled={disabled || !dirty || check.workflow === null}
              title={
                check.workflow === null
                  ? `Fix ${check.errors.length} problem${check.errors.length === 1 ? "" : "s"} to save`
                  : "Save (Ctrl+S)"
              }
              onClick={() => void save()}
            >
              <SaveIcon />
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={!commands.canRun || dirty || fileGone || draft.nodes.length === 0}
          title={dirty ? "Save before running" : undefined}
          onClick={() => onRun(doc.base)}
        >
          <PlayIcon />
          Run
        </Button>
      </div>

      {conflict ? (
        <Alert variant="warning">
          <AlertTitle>This workflow changed on disk</AlertTitle>
          <AlertDescription>
            Someone (or an agent) saved a new version while you were editing. Reload to see it, or
            keep editing and your save replaces it.
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={() => onResolveConflict(false)}>
              Keep mine
            </Button>
            <Button size="sm" onClick={() => onResolveConflict(true)}>
              Reload
            </Button>
          </AlertAction>
        </Alert>
      ) : fileGone ? (
        <Alert variant="warning">
          <AlertTitle>The file was deleted</AlertTitle>
          <AlertDescription>Save to write it again, or go back to the library.</AlertDescription>
        </Alert>
      ) : null}
      {!commands.canWrite ? (
        <p className="text-xs text-muted-foreground">
          You can look at this workflow, but this connection cannot change files on that machine.
        </p>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-2">
          {check.general.length > 0 && selected !== null ? (
            <Problems errors={check.general} />
          ) : null}
          {draft.nodes.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Add a step to start. Connect steps to set their order; steps with nothing between them
              run at the same time.
            </p>
          ) : null}
          <WorkflowCanvas
            label={`${draft.title} steps`}
            workflow={draft}
            positions={positions}
            selectedId={selectedId}
            onSelect={setSelectedId}
            describe={(node) => describeNode(node, agents)}
            {...(commands.canWrite
              ? {
                  edit: {
                    problems: check.byNode,
                    onMove: (id, at) => apply(moveNode(draft, id, at)),
                    onConnect: connect,
                    onDisconnect: (edge) => apply(disconnectNodes(draft, edge.from, edge.to)),
                    onRemove: remove,
                  },
                }
              : {})}
          />
        </div>
        <aside className="flex min-w-0 flex-col gap-4 rounded-xl border p-3 lg:max-h-[min(65vh,680px)] lg:overflow-y-auto">
          {selected ? (
            <NodePanel
              key={selected.id}
              workflow={draft}
              node={selected}
              problems={check.byNode.get(selected.id) ?? []}
              agents={agents}
              skills={skills}
              environmentId={environmentId}
              disabled={disabled}
              rewrite={rewrite}
              onChange={(node, field) => apply(replaceNode(draft, node), `${node.id}:${field}`)}
              onRename={(id) => {
                const result = renameNode(draft, selected.id, id);
                if ("error" in result) return result.error;
                apply(result.workflow);
                setSelectedId(id.trim());
                return null;
              }}
              onConnect={connect}
              onDisconnect={(edge) => apply(disconnectNodes(draft, edge.from, edge.to))}
              onRemove={() => remove(selected.id)}
            />
          ) : (
            <>
              <WorkflowSettings
                workflow={draft}
                problems={check.general}
                disabled={disabled}
                onChange={(next, field) => apply(next, `workflow:${field}`)}
              />
              <WorkflowShortcutField environmentId={environmentId} slug={draft.slug} />
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

/** A file that does not parse: its problems and raw JSON, editable and saved once it parses. */
function RawWorkflowEditor({
  detail,
  canWrite,
  onBack,
  onSave,
}: {
  readonly detail: CommandCenterWorkflowDetail;
  readonly canWrite: boolean;
  readonly onBack: () => void;
  readonly onSave: (workflow: CommandCenterWorkflow) => Promise<boolean>;
}) {
  const [text, setText] = useState(detail.raw ?? "");
  const [errors, setErrors] = useState<ReadonlyArray<string>>(detail.errors);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      setErrors([`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
      return;
    }
    // The file name is the slug, whatever the JSON says.
    const result = parseCommandCenterWorkflow(
      typeof raw === "object" && raw !== null ? { ...raw, slug: detail.slug } : raw,
    );
    setErrors(result.errors);
    if (result.workflow === null) return;
    setSaving(true);
    await onSave(result.workflow);
    setSaving(false);
  };
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeftIcon />
          Workflows
        </Button>
        <h2 className="min-w-0 truncate text-sm font-medium">{detail.slug}.json</h2>
      </div>
      <Alert variant="error">
        <AlertTitle>This file cannot be opened in the editor</AlertTitle>
        <AlertDescription>
          <Problems errors={errors} />
        </AlertDescription>
      </Alert>
      <Textarea
        aria-label="Workflow JSON"
        size="lg"
        rows={20}
        value={text}
        readOnly={!canWrite}
        onChange={(event) => setText(event.target.value)}
      />
      {canWrite ? (
        <div className="flex justify-end">
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            <SaveIcon />
            {saving ? "Saving…" : "Check and save"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
