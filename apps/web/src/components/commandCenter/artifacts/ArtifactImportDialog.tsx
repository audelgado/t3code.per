import { useRef, useState } from "react";

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
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { artifactImportTextError } from "./artifactLogic";

export const ARTIFACT_FILE_ACCEPT = ".html,.htm,.md,.markdown,.txt,text/html,text/markdown";

/**
 * Paste a page (for example a claude.ai artifact's source) or pick files. Pasted text is saved by
 * `onImportText`; picked files go to `onImportFiles`, the same path as dropping them on the tab.
 */
export function ArtifactImportDialog({
  open,
  onOpenChange,
  destination,
  onImportText,
  onImportFiles,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Where the page lands, e.g. "Acme" or "no project". */
  readonly destination: string;
  /** Resolves true once saved, which closes the dialog. */
  readonly onImportText: (content: string, title: string | null) => Promise<boolean>;
  readonly onImportFiles: (files: ReadonlyArray<File>) => void;
}) {
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const close = () => {
    onOpenChange(false);
    setContent("");
    setTitle("");
    setError(null);
  };
  const save = async () => {
    const problem = artifactImportTextError(content);
    setError(problem);
    if (problem !== null || saving) return;
    setSaving(true);
    const saved = await onImportText(content, title.trim() || null);
    setSaving(false);
    if (saved) close();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogPopup className="max-w-2xl">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Import a page</DialogTitle>
            <DialogDescription>
              Paste HTML or Markdown, or choose files. It is saved to {destination}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <fieldset disabled={saving} className="space-y-3">
              <Input
                aria-label="Title"
                placeholder="Title (optional, read from the page otherwise)"
                value={title}
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
              />
              <Textarea
                aria-label="Page source"
                aria-invalid={error !== null || undefined}
                aria-describedby={error !== null ? "artifact-import-error" : undefined}
                placeholder="<!doctype html>… or # A Markdown heading"
                rows={12}
                value={content}
                onChange={(event) => {
                  setContent(event.target.value);
                  if (error !== null) setError(null);
                }}
              />
              {error !== null ? (
                <p id="artifact-import-error" className="text-sm text-destructive-foreground">
                  {error}
                </p>
              ) : null}
              <input
                ref={fileInput}
                type="file"
                multiple
                accept={ARTIFACT_FILE_ACCEPT}
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = "";
                  if (files.length === 0) return;
                  onImportFiles(files);
                  close();
                }}
              />
            </fieldset>
          </DialogPanel>
          <DialogFooter>
            <div className="me-auto">
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => fileInput.current?.click()}
              >
                Choose files…
              </Button>
            </div>
            <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
              Cancel
            </DialogClose>
            <Button type="submit" size="sm" disabled={saving || content.trim() === ""}>
              Import
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
