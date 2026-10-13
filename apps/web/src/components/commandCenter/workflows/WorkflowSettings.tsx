import type { CommandCenterWorkflow, CommandCenterWorkflowInput } from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { Field, Problems } from "./NodePanel";
import { omitKey } from "./workflowLogic";

/** The workflow's own fields, shown in the side panel while no step is selected. */
export function WorkflowSettings({
  workflow,
  problems,
  disabled,
  onChange,
}: {
  readonly workflow: CommandCenterWorkflow;
  /** Errors that name no step. */
  readonly problems: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onChange: (workflow: CommandCenterWorkflow, field: string) => void;
}) {
  const setInput = (index: number, input: CommandCenterWorkflowInput, field: string) =>
    onChange(
      {
        ...workflow,
        inputs: workflow.inputs.map((current, position) => (position === index ? input : current)),
      },
      `input:${index}:${field}`,
    );
  const addInput = () => {
    const taken = new Set(workflow.inputs.map((input) => input.name));
    let n = workflow.inputs.length + 1;
    while (taken.has(`input_${n}`)) n++;
    onChange(
      { ...workflow, inputs: [...workflow.inputs, { name: `input_${n}`, label: `Input ${n}` }] },
      "inputs",
    );
  };

  return (
    <fieldset disabled={disabled} className="flex flex-col gap-4">
      <h3 className="text-sm font-medium">Workflow</h3>
      <p className="text-xs text-muted-foreground">
        Saved as .t3/workflows/{workflow.slug}.json. Select a step to edit it.
      </p>
      <Problems errors={problems} />
      <Field label="Title">
        <Input
          value={workflow.title}
          onChange={(event) => onChange({ ...workflow, title: event.target.value }, "title")}
        />
      </Field>
      <Field label="Description">
        <Textarea
          value={workflow.description}
          placeholder="What this workflow is for."
          onChange={(event) =>
            onChange({ ...workflow, description: event.target.value }, "description")
          }
        />
      </Field>
      <Field label="Inputs" hint="Asked for when the workflow runs. Prompts use {{input:name}}.">
        <div className="flex flex-col gap-3">
          {workflow.inputs.map((input, index) => (
            // Index keys: renaming an input must not remount (and blur) its fields.
            // oxlint-disable-next-line react/no-array-index-key
            <div key={index} className="grid grid-cols-2 gap-1.5 rounded-lg border p-2">
              <Input
                size="sm"
                aria-label="Name"
                value={input.name}
                placeholder="name"
                onChange={(event) =>
                  setInput(index, { ...input, name: event.target.value }, "name")
                }
              />
              <Input
                size="sm"
                aria-label="Label"
                value={input.label}
                placeholder="Label"
                onChange={(event) =>
                  setInput(index, { ...input, label: event.target.value }, "label")
                }
              />
              <Input
                size="sm"
                aria-label="Default"
                value={input.default ?? ""}
                placeholder="Default (optional)"
                onChange={(event) =>
                  setInput(
                    index,
                    event.target.value === ""
                      ? omitKey(input, "default")
                      : { ...input, default: event.target.value },
                    "default",
                  )
                }
              />
              <Button
                size="sm"
                variant="ghost-destructive"
                onClick={() =>
                  onChange(
                    {
                      ...workflow,
                      inputs: workflow.inputs.filter((_, position) => position !== index),
                    },
                    "inputs",
                  )
                }
              >
                <XIcon />
                Remove
              </Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={addInput}>
            <PlusIcon />
            Add input
          </Button>
        </div>
      </Field>
    </fieldset>
  );
}
