import type {
  CommandCenterArtifact,
  CommandCenterCanvasEdge,
  CommandCenterCanvasEdgeId,
  CommandCenterCanvasItem,
  CommandCenterCanvasItemId,
  CommandCenterMemoryEntry,
  CommandCenterSection,
  EnvironmentId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { LibraryIcon, XIcon } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import ChatMarkdown from "../../ChatMarkdown";
import { HtmlRenderDocument } from "../../files/BrowserDocumentFrame";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { ScrollArea } from "../../ui/scroll-area";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../../ui/sheet";
import { Textarea } from "../../ui/textarea";
import { SECTION_STATUS_LABEL } from "../projects/logic";
import { useCommandCenter } from "../shared";
import {
  CANVAS_KIND_LABEL,
  type CanvasCardView,
  type CanvasLookups,
  describeCard,
} from "./canvasLogic";

export type CanvasSheetTarget =
  | { readonly type: "item"; readonly itemId: CommandCenterCanvasItemId }
  | { readonly type: "new-note" };

const NOTE_MAX_LENGTH = 2_000;

/** What opening a card shows: the artifact, section or memory entry it points at, or the note. */
export function CanvasCardSheet(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Kept after closing so the sheet keeps its content while it animates out. */
  readonly target: CanvasSheetTarget | null;
  /** The target card, or null for a new note or a card removed meanwhile. */
  readonly item: CommandCenterCanvasItem | null;
  readonly view: CanvasCardView | null;
  readonly lookups: CanvasLookups;
  readonly items: ReadonlyArray<CommandCenterCanvasItem>;
  readonly edges: ReadonlyArray<CommandCenterCanvasEdge>;
  readonly canOperate: boolean;
  readonly onCreateNote: (text: string) => Promise<void>;
  readonly onSaveNote: (item: CommandCenterCanvasItem, text: string) => Promise<void>;
  readonly onRemoveEdge: (id: CommandCenterCanvasEdgeId) => void;
}) {
  const { target, item, view } = props;
  const title =
    target?.type === "new-note" ? "New note" : item && view ? view.title : "Card removed";
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            {target?.type === "new-note"
              ? "A free note on this project's canvas."
              : item
                ? CANVAS_KIND_LABEL[item.kind]
                : "This card is no longer on the canvas."}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-4 px-6 pb-6">
            {target?.type === "new-note" ? (
              <NoteForm
                key="new"
                initial=""
                canOperate={props.canOperate}
                onSave={props.onCreateNote}
              />
            ) : item ? (
              <>
                <CardBody
                  item={item}
                  lookups={props.lookups}
                  canOperate={props.canOperate}
                  onSaveNote={props.onSaveNote}
                />
                <Connections
                  item={item}
                  items={props.items}
                  edges={props.edges}
                  lookups={props.lookups}
                  canOperate={props.canOperate}
                  onRemoveEdge={props.onRemoveEdge}
                />
              </>
            ) : null}
          </div>
        </ScrollArea>
      </SheetPopup>
    </Sheet>
  );
}

function CardBody({
  item,
  lookups,
  canOperate,
  onSaveNote,
}: {
  readonly item: CommandCenterCanvasItem;
  readonly lookups: CanvasLookups;
  readonly canOperate: boolean;
  readonly onSaveNote: (item: CommandCenterCanvasItem, text: string) => Promise<void>;
}) {
  const ref = item.refId;
  switch (item.kind) {
    case "note":
      return (
        <NoteForm
          key={item.id}
          initial={item.text ?? ""}
          canOperate={canOperate}
          onSave={(text) => onSaveNote(item, text)}
        />
      );
    case "artifact": {
      const artifact = ref === null ? undefined : lookups.artifacts.get(ref);
      return artifact ? <ArtifactDetail artifact={artifact} /> : <Gone what="artifact" />;
    }
    case "section": {
      const section = ref === null ? undefined : lookups.sections.get(ref);
      return section ? <SectionDetail section={section} /> : <Gone what="section" />;
    }
    case "memory": {
      const entry = ref === null ? undefined : lookups.memory.get(ref);
      return entry ? <MemoryDetail entry={entry} /> : <Gone what="memory entry" />;
    }
  }
}

function Gone({ what }: { readonly what: string }) {
  return (
    <p className="text-sm text-muted-foreground">
      This {what} was deleted. Remove the card, or keep it as a reminder.
    </p>
  );
}

function NoteForm({
  initial,
  canOperate,
  onSave,
}: {
  readonly initial: string;
  readonly canOperate: boolean;
  readonly onSave: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const trimmed = text.trim();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || saving || trimmed === initial.trim()) return;
    setSaving(true);
    await onSave(trimmed);
    setSaving(false);
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={(event) => void submit(event)}>
      <Textarea
        aria-label="Note"
        placeholder="An idea, a question, a link…"
        autoFocus={initial === ""}
        readOnly={!canOperate}
        maxLength={NOTE_MAX_LENGTH}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      {canOperate ? (
        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            disabled={saving || !trimmed || trimmed === initial.trim()}
          >
            {initial === "" ? "Add to canvas" : "Save note"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function ArtifactDetail({ artifact: boardRow }: { readonly artifact: CommandCenterArtifact }) {
  const { primaryEnvironmentId } = useCommandCenter();
  const query = useEnvironmentQuery(
    serverEnvironment.commandCenterArtifact({
      environmentId: primaryEnvironmentId,
      input: { id: boardRow.id },
    }),
  );
  const detail = query.data;
  // The cached page can be older than the version the canvas reports (an agent saved since).
  const stale = detail !== null && detail.artifact.currentVersion < boardRow.currentVersion;
  // The fetched row is newer than the canvas's copy once it loads.
  const artifact = detail?.artifact ?? boardRow;
  const { refresh } = query;
  useEffect(() => {
    if (stale) refresh();
  }, [refresh, stale]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Badge variant="outline">{artifact.kind === "html" ? "HTML" : "Markdown"}</Badge>
        <span>Version {artifact.currentVersion}</span>
        <span>· updated {dateTimeFormat.format(new Date(artifact.updatedAt))}</span>
        {artifact.archivedAt ? <Badge variant="warning">Deleted</Badge> : null}
      </div>
      <div>
        {/* History, diff, restore and Send to agent live in the library's viewer. */}
        <Button
          size="sm"
          variant="outline"
          render={<Link to="/command" search={{ tab: "artifacts", artifact: artifact.id }} />}
        >
          <LibraryIcon />
          {artifact.archivedAt ? "Restore in Artifacts" : "Open in Artifacts"}
        </Button>
      </div>
      {detail === null ? (
        <p className="text-sm text-muted-foreground" role="status">
          {query.error ? `Could not load the page: ${query.error}` : "Loading the page…"}
        </p>
      ) : detail.artifact.kind === "html" ? (
        <HtmlArtifactFrame
          key={detail.version.attachmentId}
          environmentId={primaryEnvironmentId}
          attachmentId={detail.version.attachmentId}
          title={detail.artifact.title}
        />
      ) : (
        <ChatMarkdown text={detail.content ?? ""} cwd={undefined} />
      )}
    </div>
  );
}

function HtmlArtifactFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly title: string;
}) {
  const { attachmentId } = props;
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  if (asset._tag === "Failure") {
    return <p className="text-sm text-muted-foreground">Unable to load {props.title}.</p>;
  }
  return (
    <div className="h-[60vh] overflow-hidden rounded-lg border">
      {asset._tag === "Success" ? (
        // The frame keeps its first URL, so a later URL refresh does not reload the page.
        <HtmlRenderDocument src={asset.url} title={props.title} className="block size-full" />
      ) : null}
    </div>
  );
}

function SectionDetail({ section }: { readonly section: CommandCenterSection }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      <dt className="text-muted-foreground">Status</dt>
      <dd>{SECTION_STATUS_LABEL[section.status]}</dd>
      <dt className="text-muted-foreground">Tasks</dt>
      <dd className="tabular-nums">
        {section.tasksDone} of {section.tasksTotal} done
      </dd>
      {section.dueDate ? (
        <>
          <dt className="text-muted-foreground">Due</dt>
          <dd>{section.dueDate}</dd>
        </>
      ) : null}
      {section.trying ? (
        <>
          <dt className="text-muted-foreground">Trying</dt>
          <dd className="wrap-anywhere">{section.trying}</dd>
        </>
      ) : null}
      {section.blocker ? (
        <>
          <dt className="text-muted-foreground">Blocked by</dt>
          <dd className="wrap-anywhere">{section.blocker}</dd>
        </>
      ) : null}
      {section.missing.length > 0 ? (
        <>
          <dt className="text-muted-foreground">Missing</dt>
          <dd>
            <ul className="list-disc ps-4">
              {section.missing.map((entry) => (
                <li key={entry} className="wrap-anywhere">
                  {entry}
                </li>
              ))}
            </ul>
          </dd>
        </>
      ) : null}
      {section.prUrl ? (
        <>
          <dt className="text-muted-foreground">Pull request</dt>
          <dd>
            <a
              href={section.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4"
            >
              {section.prNumber ? `#${section.prNumber}` : section.prUrl}
            </a>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

function MemoryDetail({ entry }: { readonly entry: CommandCenterMemoryEntry }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Badge variant="outline">{entry.kind.charAt(0).toUpperCase() + entry.kind.slice(1)}</Badge>
        <span>{dateTimeFormat.format(new Date(entry.createdAt))}</span>
        {entry.kind === "todo" && entry.done ? <Badge variant="success">Done</Badge> : null}
      </div>
      <p className="text-sm whitespace-pre-wrap wrap-anywhere">{entry.text}</p>
    </div>
  );
}

/** The card's connections; the keyboard and touch way to remove one. */
function Connections({
  item,
  items,
  edges,
  lookups,
  canOperate,
  onRemoveEdge,
}: {
  readonly item: CommandCenterCanvasItem;
  readonly items: ReadonlyArray<CommandCenterCanvasItem>;
  readonly edges: ReadonlyArray<CommandCenterCanvasEdge>;
  readonly lookups: CanvasLookups;
  readonly canOperate: boolean;
  readonly onRemoveEdge: (id: CommandCenterCanvasEdgeId) => void;
}) {
  const linked = edges.filter((edge) => edge.fromItemId === item.id || edge.toItemId === item.id);
  if (linked.length === 0) return null;
  const byId = new Map(items.map((row) => [row.id as string, row] as const));
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">Connections</h3>
      <ul className="flex flex-col gap-1">
        {linked.map((edge) => {
          const outgoing = edge.fromItemId === item.id;
          const other = byId.get(outgoing ? edge.toItemId : edge.fromItemId);
          const otherTitle = other ? describeCard(other, lookups).title : "Removed card";
          return (
            <li key={edge.id} className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{outgoing ? "To" : "From"}</span>
              <span className="min-w-0 flex-1 truncate">
                {otherTitle}
                {edge.label ? ` (${edge.label})` : ""}
              </span>
              {canOperate ? (
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label={`Remove connection with ${otherTitle}`}
                  onClick={() => onRemoveEdge(edge.id)}
                >
                  <XIcon />
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
