import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { create } from "zustand";

import { useProject } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  decideWorkflowRun,
  type ParsedWorkflowCommand,
  planWorkflowInputs,
  type WorkflowChoice,
  workflowChoices,
  type WorkflowRunDecision,
} from "~/workflowCommand";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { toastManager } from "./ui/toast";

/**
 * The workflows a project can run: its `.t3/workflows` files, then the built-in starters it has
 * not saved. Subscribes only while `enabled`, so callers mount it with an open menu or a typed
 * `/wf`, never in the background.
 */
export function useWorkflowChoices(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  enabled = true,
) {
  const active = enabled && environmentId !== null && projectId !== null;
  const saved = useEnvironmentQuery(
    active
      ? serverEnvironment.commandCenterWorkflowsLive({ environmentId, input: { projectId } })
      : null,
  );
  const starters = useEnvironmentQuery(
    active ? serverEnvironment.commandCenterWorkflowStarters({ environmentId, input: {} }) : null,
  );
  const ready =
    (saved.data !== null || saved.error !== null) &&
    (starters.data !== null || starters.error !== null);
  return {
    choices: workflowChoices(saved.data?.workflows ?? [], starters.data?.starters ?? []),
    ready,
    error: saved.error ?? starters.error,
  };
}

export interface WorkflowRunRequest {
  /** Where the project lives; the run starts there. */
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly command: ParsedWorkflowCommand;
}

const useRequestStore = create<{
  readonly request: (WorkflowRunRequest & { readonly nonce: number }) | null;
}>(() => ({ request: null }));
let nonce = 0;

/**
 * Starts a workflow from anywhere (orchestrator bar, composer, palette, keybinding, Run button).
 * It runs straight away when every input has a value; otherwise, or when the slug is unknown,
 * it asks in a dialog.
 */
export function requestWorkflowRun(request: WorkflowRunRequest): void {
  nonce += 1;
  useRequestStore.setState({ request: { ...request, nonce } });
}

export function runWorkflowNow(environmentId: EnvironmentId, projectId: ProjectId, slug: string) {
  requestWorkflowRun({ environmentId, projectId, command: { slug, inputs: {}, text: "" } });
}

const closeRequest = () => useRequestStore.setState({ request: null });

/** Mounted once, app-wide; renders nothing until a run is requested. */
export function RunWorkflowHost() {
  const request = useRequestStore((state) => state.request);
  return request === null ? null : <RunWorkflowRequest key={request.nonce} request={request} />;
}

function RunWorkflowRequest({ request }: { readonly request: WorkflowRunRequest }) {
  const { environmentId, projectId, command } = request;
  const navigate = useNavigate();
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const { choices, ready, error } = useWorkflowChoices(environmentId, projectId);
  const canRun = useAtomValue(
    serverEnvironment.startCommandCenterWorkflowRun.permissionAtom(environmentId),
  );
  const start = useAtomCommand(serverEnvironment.startCommandCenterWorkflowRun, {
    reportFailure: false,
  });
  const [prompt, setPrompt] = useState<{
    readonly slug: string;
    readonly values: Readonly<Record<string, string>>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  // Decided once, when both lists first arrive (render-time state, so it never flickers);
  // later file changes only refresh the prompt's choices.
  const [decision, setDecision] = useState<WorkflowRunDecision | null>(null);
  if (decision === null && ready) {
    const next = decideWorkflowRun(choices, command, { canRun, error });
    setDecision(next);
    if (next.kind === "prompt") setPrompt({ slug: next.slug, values: next.values });
  }

  const run = async (choice: WorkflowChoice, inputs: Readonly<Record<string, string>>) => {
    const result = await start({
      environmentId,
      input: {
        projectId,
        slug: choice.slug,
        inputs: Object.fromEntries(
          Object.entries(inputs)
            .map(([name, value]) => [name, value.trim()] as const)
            .filter(([, value]) => value !== ""),
        ),
        ...(choice.starter ? { workflow: choice.starter } : {}),
      },
    });
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not start ${choice.title}`,
        description: String(squashAtomCommandFailure(result)),
      });
      // A prompt stays open so the values can be fixed; a direct run has nothing to keep.
      if (prompt === null) closeRequest();
      return;
    }
    const id = toastManager.add({
      type: "success",
      title: `Started ${choice.title}`,
      ...(project ? { description: `In ${project.title}` } : {}),
      actionProps: {
        children: "View",
        onClick: () => {
          toastManager.close(id);
          void navigate({
            to: "/command",
            search: { tab: "workflows", project: projectId, run: result.value.id },
          });
        },
      },
    });
    closeRequest();
  };

  const promptFor = (choice: WorkflowChoice | undefined) => {
    const plan = choice ? planWorkflowInputs(choice.inputs, command) : null;
    setPrompt({ slug: choice?.slug ?? "", values: plan?.inputs ?? {} });
  };

  const onDecision = useEffectEvent((next: WorkflowRunDecision) => {
    if (next.kind === "run") {
      void run(next.choice, next.inputs);
    } else if (next.kind === "blocked") {
      toastManager.add({
        type: "error",
        title: next.title,
        ...(next.description === null ? {} : { description: next.description }),
      });
      closeRequest();
    }
  });
  useEffect(() => {
    if (decision !== null) onDecision(decision);
  }, [decision]);

  if (prompt === null) return null;
  const choice = choices.find((candidate) => candidate.slug === prompt.slug);
  const plan =
    choice && choice.slug === command.slug ? planWorkflowInputs(choice.inputs, command) : null;
  const notes = [
    command.slug !== "" && !choices.some((candidate) => candidate.slug === command.slug)
      ? `There is no workflow "${command.slug}" in this project.`
      : null,
    plan && plan.unknown.length > 0
      ? `Not an input of this workflow: ${plan.unknown.join(", ")}.`
      : null,
    plan && plan.leftover !== "" ? `Not used: ${plan.leftover}` : null,
    choice?.error ? `This workflow cannot run: ${choice.error}` : null,
  ].filter((note) => note !== null);
  const missing =
    choice?.inputs.filter(
      (input) => !input.default?.trim() && !prompt.values[input.name]?.trim(),
    ) ?? [];

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : closeRequest())}>
      <DialogPopup className="max-w-lg">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (choice && choice.error === null && missing.length === 0 && !busy) {
              setBusy(true);
              void run(choice, prompt.values).finally(() => setBusy(false));
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{choice ? `Run ${choice.title}` : "Run a workflow"}</DialogTitle>
            <DialogDescription>
              {[choice?.description, project ? `In ${project.title}.` : null]
                .filter(Boolean)
                .join(" ")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <fieldset disabled={busy} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Workflow</Label>
                <Select
                  value={prompt.slug}
                  onValueChange={(slug) =>
                    promptFor(choices.find((candidate) => candidate.slug === slug))
                  }
                >
                  <SelectTrigger aria-label="Workflow">
                    <SelectValue>{choice?.title ?? "Choose a workflow"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {choices.map((candidate) => (
                      <SelectItem key={candidate.slug} value={candidate.slug}>
                        {candidate.starter ? `${candidate.title} (built-in)` : candidate.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              {choice?.inputs.map((input, index) => (
                <div key={input.name} className="flex flex-col gap-1.5">
                  <Label htmlFor={`run-workflow-${input.name}`}>{input.label}</Label>
                  <Input
                    id={`run-workflow-${input.name}`}
                    autoFocus={index === 0}
                    placeholder={input.default?.trim() ? input.default : "Required"}
                    value={prompt.values[input.name] ?? ""}
                    onChange={(event) =>
                      setPrompt({
                        ...prompt,
                        values: { ...prompt.values, [input.name]: event.target.value },
                      })
                    }
                  />
                </div>
              ))}
              {notes.map((note) => (
                <p key={note} className="text-sm text-muted-foreground">
                  {note}
                </p>
              ))}
            </fieldset>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" disabled={busy} />}>
              Cancel
            </DialogClose>
            <Button
              type="submit"
              size="sm"
              disabled={busy || !choice || choice.error !== null || missing.length > 0}
            >
              <PlayIcon />
              Run
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function RunWorkflowMenuItems({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  // Mounted only while the menu is open, so the list is live only then.
  const { choices, ready, error } = useWorkflowChoices(environmentId, projectId);
  if (!ready) return <MenuItem disabled>Loading workflows…</MenuItem>;
  if (choices.length === 0) return <MenuItem disabled>{error ?? "No workflows yet"}</MenuItem>;
  return choices.map((choice) => (
    <MenuItem
      key={choice.slug}
      onClick={() => runWorkflowNow(environmentId, projectId, choice.slug)}
    >
      {choice.starter ? `${choice.title} (built-in)` : choice.title}
    </MenuItem>
  ));
}

/** "Run" menu listing a project's workflows; picking one runs it or asks for its inputs. */
export function RunWorkflowMenu({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const canRun = useAtomValue(
    serverEnvironment.startCommandCenterWorkflowRun.permissionAtom(environmentId),
  );
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" disabled={!canRun} />}>
        <PlayIcon />
        Run
      </MenuTrigger>
      <MenuPopup align="end">
        <RunWorkflowMenuItems environmentId={environmentId} projectId={projectId} />
      </MenuPopup>
    </Menu>
  );
}
