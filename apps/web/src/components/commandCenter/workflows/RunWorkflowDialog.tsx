import type { CommandCenterWorkflowInput } from "@t3tools/contracts";
import { PlayIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Textarea } from "../../ui/textarea";
import { Field } from "./NodePanel";
import { runInputs } from "./workflowLogic";

/** Asks for a workflow's inputs, then starts a run. Mount it only while open. */
export function RunWorkflowDialog({
  title,
  inputs,
  onClose,
  onStart,
}: {
  readonly title: string;
  readonly inputs: ReadonlyArray<CommandCenterWorkflowInput>;
  readonly onClose: () => void;
  /** Resolves true once the run started. */
  readonly onStart: (inputs: Record<string, string>) => Promise<boolean>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const { inputs: given, missing } = runInputs(inputs, values);

  const start = async () => {
    if (missing.length > 0 || starting) return;
    setStarting(true);
    const started = await onStart(given);
    setStarting(false);
    if (started) onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-lg">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <DialogHeader>
            <DialogTitle>Run {title}</DialogTitle>
            <DialogDescription>
              {inputs.length === 0
                ? "This workflow takes no inputs."
                : "Blank fields use their default."}
            </DialogDescription>
          </DialogHeader>
          {inputs.length > 0 ? (
            <DialogPanel>
              <fieldset disabled={starting} className="space-y-4">
                {inputs.map((input, index) => (
                  <Field key={input.name} label={input.label}>
                    <Textarea
                      size="sm"
                      autoFocus={index === 0}
                      value={values[input.name] ?? ""}
                      placeholder={input.default ?? "Required"}
                      onChange={(event) =>
                        setValues((current) => ({ ...current, [input.name]: event.target.value }))
                      }
                    />
                  </Field>
                ))}
              </fieldset>
            </DialogPanel>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" disabled={starting} />}>
              Cancel
            </DialogClose>
            <Button
              type="submit"
              size="sm"
              disabled={starting || missing.length > 0}
              title={missing.length > 0 ? `Fill in ${missing.join(", ")}` : undefined}
            >
              <PlayIcon />
              {starting ? "Starting…" : "Run"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
