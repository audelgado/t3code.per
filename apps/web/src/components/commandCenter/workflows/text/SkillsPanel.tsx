import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  executeAtomQuery,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandCenterSkillName,
  type CommandCenterSkillSummary,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useContext, useState } from "react";

import { useProject } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../../../ui/badge";
import { Button } from "../../../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../../ui/empty";
import { Input } from "../../../ui/input";
import { Label } from "../../../ui/label";
import { Spinner } from "../../../ui/spinner";
import { Textarea } from "../../../ui/textarea";
import { toastManager } from "../../../ui/toast";
import { parseSkillFile } from "./textLogic";
import { type TextRewrite, TextOptimizer } from "./TextOptimizer";
import { useTextRewrite } from "./useTextRewrite";

const isSkillName = Schema.is(CommandCenterSkillName);

interface SkillDraft {
  readonly mode: "create" | "update";
  readonly name: string;
  readonly description: string;
  readonly content: string;
}

const reportFailure =
  (title: string) =>
  <A, E>(result: AtomCommandResult<A, E>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title,
        description: String(squashAtomCommandFailure(result)),
      });
    }
    return result;
  };

/**
 * The project's own skills (`.agents/skills`, mirrored to `.claude/skills` so every provider
 * sees them): list, create and edit `SKILL.md` with the text optimizer, and delete (both copies
 * go to `.t3/workflows/.trash`, with Undo).
 */
export function SkillsPanel({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const registry = useContext(RegistryContext);
  const rewrite = useTextRewrite(environmentId, projectId);
  const removeSkill = useAtomCommand(serverEnvironment.deleteCommandCenterSkill, {
    label: "command center delete skill",
    reportFailure: false,
  });
  const restoreSkill = useAtomCommand(serverEnvironment.restoreCommandCenterSkill, {
    label: "command center restore skill",
    reportFailure: false,
  });
  const project = useProject({ environmentId, projectId });
  const skills = useEnvironmentQuery(
    serverEnvironment.commandCenterSkills({ environmentId, input: { projectId } }),
  );
  const canWrite = useAtomValue(
    serverEnvironment.createCommandCenterSkill.permissionAtom(environmentId),
  );
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const edit = async (skill: CommandCenterSkillSummary) => {
    if (project === null) return;
    setOpening(skill.name);
    // Either copy is the same skill; Claude's folder is the fallback for hand-made ones.
    const folder = skill.inAgents ? ".agents" : ".claude";
    const result = await executeAtomQuery(
      registry,
      projectEnvironment.readFile({
        environmentId,
        input: {
          cwd: project.workspaceRoot,
          relativePath: `${folder}/skills/${skill.name}/SKILL.md`,
        },
      }),
      { refresh: true, reportFailure: false },
    ).then(reportFailure("Could not open the skill"));
    setOpening(null);
    if (result._tag !== "Success") return;
    if (result.value.truncated) {
      toastManager.add({
        type: "error",
        title: "This skill is too large to edit here",
        description: `Edit ${folder}/skills/${skill.name}/SKILL.md in your editor.`,
      });
      return;
    }
    const parsed = parseSkillFile(result.value.contents);
    setDraft({
      mode: "update",
      name: skill.name,
      description: parsed.description || (skill.description ?? ""),
      content: parsed.content,
    });
  };

  const deleteWithUndo = async (name: CommandCenterSkillName) => {
    const input = { projectId, name };
    const result = await removeSkill({ environmentId, input }).then(
      reportFailure("Could not delete the skill"),
    );
    if (result._tag !== "Success") return;
    const id = toastManager.add({
      type: "info",
      title: `Deleted ${name}`,
      description: "Removed from .agents/skills and .claude/skills.",
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(id);
          void restoreSkill({ environmentId, input }).then(
            reportFailure("Could not restore the skill"),
          );
        },
      },
    });
  };

  const list = skills.data?.skills ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Skills</h3>
        <span className="text-xs text-muted-foreground">
          Saved to .agents/skills and .claude/skills, so every provider uses them.
        </span>
        {canWrite ? (
          <div className="ms-auto">
            <Button
              variant="outline"
              size="xs"
              onClick={() => setDraft({ mode: "create", name: "", description: "", content: "" })}
            >
              <PlusIcon />
              New skill
            </Button>
          </div>
        ) : null}
      </div>
      {skills.error !== null ? (
        <p className="text-sm text-destructive-foreground">{skills.error}</p>
      ) : skills.data === null ? (
        <Spinner size="sm" tone="muted" />
      ) : list.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No skills yet</EmptyTitle>
            <EmptyDescription>
              A skill is a reusable instruction set an agent loads when it applies. Create one here
              or ask an agent to save one.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="divide-y rounded-md border">
          {list.map((skill) => (
            <li key={skill.name} className="flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-sm">{skill.name}</span>
                  {skill.inAgents && skill.inClaude ? null : (
                    <Badge variant="warning" size="sm">
                      {skill.inAgents ? "Missing for Claude" : "Missing for Codex"}
                    </Badge>
                  )}
                </div>
                {skill.description !== null ? (
                  <p className="line-clamp-2 text-xs text-muted-foreground">{skill.description}</p>
                ) : null}
              </div>
              {canWrite ? (
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label={`Edit ${skill.name}`}
                  disabled={opening !== null || project === null}
                  onClick={() => void edit(skill)}
                >
                  {opening === skill.name ? <Spinner size="xs" /> : <PencilIcon />}
                </Button>
              ) : null}
              {canWrite && isSkillName(skill.name) ? (
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label={`Delete ${skill.name}`}
                  onClick={() => void deleteWithUndo(skill.name)}
                >
                  <Trash2Icon />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {draft !== null ? (
        <SkillEditorDialog
          key={`${draft.mode}:${draft.name}`}
          environmentId={environmentId}
          projectId={projectId}
          initial={draft}
          rewrite={rewrite}
          onClose={() => setDraft(null)}
        />
      ) : null}
    </div>
  );
}

function SkillEditorDialog({
  environmentId,
  projectId,
  initial,
  rewrite,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly initial: SkillDraft;
  readonly rewrite: TextRewrite | undefined;
  readonly onClose: () => void;
}) {
  const createSkill = useAtomCommand(serverEnvironment.createCommandCenterSkill, {
    label: "command center create skill",
    reportFailure: false,
  });
  const updateSkill = useAtomCommand(serverEnvironment.updateCommandCenterSkill, {
    label: "command center update skill",
    reportFailure: false,
  });
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [content, setContent] = useState(initial.content);
  const [saving, setSaving] = useState(false);
  const creating = initial.mode === "create";
  const nameError =
    creating && name !== "" && !isSkillName(name)
      ? "Use lowercase words joined by hyphens, like review-checklist."
      : null;
  const ready = isSkillName(name) && description.trim() !== "" && content.trim() !== "" && !saving;

  const save = async () => {
    if (!ready || !isSkillName(name)) return;
    setSaving(true);
    const input = {
      projectId,
      name,
      description: description.trim(),
      content: content.trim(),
    };
    const result = creating
      ? await createSkill({ environmentId, input }).then(
          reportFailure("Could not create the skill"),
        )
      : await updateSkill({ environmentId, input }).then(reportFailure("Could not save the skill"));
    setSaving(false);
    if (result._tag === "Success") onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-3xl">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{creating ? "New skill" : `Edit ${initial.name}`}</DialogTitle>
            <DialogDescription>
              Written as SKILL.md to .agents/skills/{name || "<name>"} and mirrored to
              .claude/skills/{name || "<name>"}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <fieldset disabled={saving} className="space-y-3">
              {creating ? (
                <div className="space-y-1">
                  <Label htmlFor="skill-name">Name</Label>
                  <Input
                    id="skill-name"
                    placeholder="review-checklist"
                    value={name}
                    maxLength={64}
                    aria-invalid={nameError !== null || undefined}
                    onChange={(event) => setName(event.target.value)}
                  />
                  {nameError !== null ? (
                    <p className="text-xs text-destructive-foreground">{nameError}</p>
                  ) : null}
                </div>
              ) : null}
              <div className="space-y-1">
                <Label htmlFor="skill-description">When to use it</Label>
                <Input
                  id="skill-description"
                  placeholder="Use when reviewing a pull request before merge."
                  value={description}
                  maxLength={1024}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="skill-content">Instructions</Label>
                <Textarea
                  id="skill-content"
                  rows={14}
                  value={content}
                  maxLength={100_000}
                  onChange={(event) => setContent(event.target.value)}
                />
                <TextOptimizer
                  value={content}
                  onChange={setContent}
                  kind="skill"
                  rewrite={rewrite}
                />
              </div>
            </fieldset>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
              Cancel
            </DialogClose>
            <Button type="submit" size="sm" disabled={!ready}>
              {creating ? "Create skill" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
