import type {
  CommandCenterMemoryEntry,
  CommandCenterMemoryKind,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MessageSquareIcon, Trash2Icon } from "lucide-react";
import { useMemo, useRef, useState, type FormEvent } from "react";

import { useThreadShells } from "~/state/entities";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { ScrollArea } from "../../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../../ui/sheet";
import { Textarea } from "../../ui/textarea";
import { CollectionPager } from "../CollectionPager";
import { showLoadOlder } from "../collectionPaging";
import { ProjectPicker } from "../ProjectPicker";
import { useCommandCenter, useCommandCenterCommands } from "../shared";
import {
  groupMemoryByDay,
  mergeMemoryPages,
  nextMemoryCursor,
  selectMemoryPage,
  type MemoryProjectFilter,
} from "./memoryLogic";

export interface MemoryDrawerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Kind filter the drawer opens with, such as `todo` from Home's Todos. */
  readonly initialKind?: CommandCenterMemoryKind | "all";
  /** Project filter the drawer opens with; the focused project when left out. */
  readonly initialProject?: MemoryProjectFilter;
}

const KINDS = [
  { value: "progress", label: "Progress" },
  { value: "decision", label: "Decision" },
  { value: "todo", label: "Todo" },
  { value: "handoff", label: "Handoff" },
  { value: "note", label: "Note" },
] as const satisfies ReadonlyArray<{ value: CommandCenterMemoryKind; label: string }>;

const KIND_LABEL = new Map<string, string>(KINDS.map((kind) => [kind.value, kind.label]));
const SOURCE_VARIANT = { user: "secondary", agent: "info", system: "outline" } as const;
const NO_PROJECT = "none";

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function formatDay(day: string) {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return dayFormat.format(new Date(year, month - 1, date));
}

/** Memory timeline: filter by project and kind, search, mark todos done, add entries. */
export function MemoryDrawer({
  open,
  onOpenChange,
  initialKind = "all",
  initialProject,
}: MemoryDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>Memory</SheetTitle>
          <SheetDescription>Where things stand, newest first.</SheetDescription>
        </SheetHeader>
        {/* Mounted only while open, so the thread shell subscription stays off when closed. */}
        <MemoryBody initialKind={initialKind} {...(initialProject ? { initialProject } : {})} />
      </SheetPopup>
    </Sheet>
  );
}

function MemoryBody({
  initialKind,
  initialProject,
}: {
  readonly initialKind: CommandCenterMemoryKind | "all";
  readonly initialProject?: MemoryProjectFilter;
}) {
  const { snapshot, projects, projectId, canOperate, primaryEnvironmentId } = useCommandCenter();
  const shells = useThreadShells();
  // Delegated threads can live on any machine; links fall back to the primary environment.
  const threadEnvironment = useMemo(
    () => new Map(shells.map((shell) => [shell.id, shell.environmentId] as const)),
    [shells],
  );
  const [project, setProjectFilter] = useState<MemoryProjectFilter>(
    initialProject ?? projectId ?? "all",
  );
  const [kind, setKindFilter] = useState(initialKind);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [composing, setComposing] = useState(false);
  const filterVersion = useRef(0);
  const { listMemory } = useCommandCenterCommands();
  // Pages older than the snapshot's newest-100 window; live only for done/upsert (snapshot wins).
  const [older, setOlder] = useState<ReadonlyArray<CommandCenterMemoryEntry>>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const memory = useMemo(() => mergeMemoryPages(snapshot.memory, older), [older, snapshot.memory]);
  const cursor = nextMemoryCursor(snapshot.memory, older);
  const loadOlder = async () => {
    if (loadingOlder || cursor === undefined) return;
    setLoadingOlder(true);
    const requestVersion = filterVersion.current;
    const result = await listMemory({
      ...cursor,
      limit: 50,
      // "No project" has no server filter; those pages are filtered here.
      ...(project !== "all" && project !== NO_PROJECT ? { projectId: project } : {}),
      ...(kind !== "all" ? { kind } : {}),
    });
    setLoadingOlder(false);
    if (requestVersion !== filterVersion.current) return;
    if (result._tag !== "Success") return;
    setOlder((current) => [...current, ...result.value.entries]);
    setHasMore(result.value.hasMore);
  };
  // Older pages were fetched for the previous filter, so a new filter pages from scratch.
  const resetOlder = () => {
    filterVersion.current += 1;
    setOlder([]);
    setHasMore(true);
    setPage(1);
  };
  const setProject = (next: MemoryProjectFilter) => {
    setProjectFilter(next);
    resetOlder();
  };
  const setKind = (next: CommandCenterMemoryKind | "all") => {
    setKindFilter(next);
    resetOlder();
  };
  const forgetOlder = (id: CommandCenterMemoryEntry["id"]) =>
    setOlder((current) => current.filter((entry) => entry.id !== id));
  const days = useMemo(
    () => groupMemoryByDay(memory, { project, kind, search }),
    [kind, memory, project, search],
  );
  const directory = useMemo(() => selectMemoryPage(days, page), [days, page]);
  const projectTitle = useMemo(
    () => new Map(projects.map((item) => [item.id, item.title] as const)),
    [projects],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-6">
      {canOperate ? (
        <div className="space-y-2">
          <Button
            size="sm"
            variant="outline"
            aria-expanded={composing}
            aria-controls="memory-composer"
            onClick={() => setComposing(!composing)}
          >
            {composing ? "Hide entry form" : "Add memory entry"}
          </Button>
          <div id="memory-composer" hidden={!composing}>
            <AddMemoryForm defaultProjectId={projectId} />
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <ProjectPicker
          projects={projects}
          value={project === "all" || project === NO_PROJECT ? null : project}
          // The empty option reads "No project" while that filter is on, so picking it keeps it.
          onValueChange={(value) =>
            setProject(value ?? (project === NO_PROJECT ? NO_PROJECT : "all"))
          }
          ariaLabel="Filter memory by project"
          nullableLabel={project === NO_PROJECT ? "No project" : "All projects"}
        />
        <Button
          size="sm"
          variant={project === NO_PROJECT ? "secondary" : "ghost"}
          aria-pressed={project === NO_PROJECT}
          onClick={() => setProject(project === NO_PROJECT ? "all" : NO_PROJECT)}
        >
          No project
        </Button>
        <div className="w-32">
          <Select
            value={kind}
            onValueChange={(value) =>
              setKind(KINDS.find((item) => item.value === value)?.value ?? "all")
            }
          >
            <SelectTrigger aria-label="Filter by kind" size="sm">
              <SelectValue>{kind === "all" ? "All kinds" : KIND_LABEL.get(kind)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All kinds</SelectItem>
              {KINDS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <Input
          type="search"
          size="sm"
          aria-label="Search memory"
          placeholder="Search loaded entries…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
      </div>
      <ScrollArea key={directory.page} className="min-h-0 flex-1">
        {days.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground text-sm">
            {memory.length === 0 ? "Nothing saved yet." : "No entries match."}
          </p>
        ) : (
          <ol className="flex flex-col gap-4">
            {directory.days.map((day) => (
              <li key={day.day} className="flex flex-col gap-2">
                <h3 className="font-medium text-muted-foreground text-xs">{formatDay(day.day)}</h3>
                <ul className="flex flex-col gap-2">
                  {day.entries.map((entry) => (
                    <MemoryRow
                      key={entry.id}
                      entry={entry}
                      projectTitle={entry.projectId ? projectTitle.get(entry.projectId) : undefined}
                      threadEnvironmentId={
                        entry.threadId
                          ? (threadEnvironment.get(entry.threadId) ?? primaryEnvironmentId)
                          : primaryEnvironmentId
                      }
                      canOperate={canOperate}
                      onDeleted={forgetOlder}
                    />
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        )}
        {showLoadOlder(directory, hasMore) && cursor !== undefined ? (
          <div className="flex justify-center py-3">
            <Button
              size="sm"
              variant="ghost"
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
            >
              {loadingOlder ? "Loading…" : "Load older"}
            </Button>
          </div>
        ) : null}
      </ScrollArea>
      <p className="text-xs text-muted-foreground">
        Search covers loaded entries. Load older history to include more.
      </p>
      <CollectionPager {...directory} label="memory entries" onPageChange={setPage} />
    </div>
  );
}

function MemoryRow({
  entry,
  projectTitle,
  threadEnvironmentId,
  canOperate,
  onDeleted,
}: {
  readonly entry: CommandCenterMemoryEntry;
  readonly projectTitle: string | undefined;
  readonly threadEnvironmentId: EnvironmentId;
  readonly canOperate: boolean;
  /** Older-page rows are not in the snapshot, so a delete event cannot remove them. */
  readonly onDeleted: (id: CommandCenterMemoryEntry["id"]) => void;
}) {
  const { setMemoryDone, removeWithUndo } = useCommandCenterCommands();
  const isTodo = entry.kind === "todo";

  return (
    <li className="flex gap-2 rounded-lg border bg-card p-2.5">
      {isTodo ? (
        <Checkbox
          aria-label={entry.done ? "Mark todo as open" : "Mark todo as done"}
          checked={entry.done}
          disabled={!canOperate}
          onCheckedChange={(checked) => void setMemoryDone({ id: entry.id, done: checked })}
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p
          className={
            isTodo && entry.done
              ? "whitespace-pre-wrap text-muted-foreground text-sm line-through"
              : "whitespace-pre-wrap text-sm"
          }
        >
          {entry.text}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
          <Badge size="sm" variant="outline">
            {KIND_LABEL.get(entry.kind)}
          </Badge>
          <Badge size="sm" variant={SOURCE_VARIANT[entry.source]}>
            {entry.source}
          </Badge>
          {projectTitle ? <span className="truncate">{projectTitle}</span> : null}
          <span>{timeFormat.format(new Date(entry.createdAt))}</span>
          {entry.threadId ? (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: threadEnvironmentId, threadId: entry.threadId }}
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <MessageSquareIcon className="size-3" />
              Open thread
            </Link>
          ) : null}
        </div>
      </div>
      {canOperate ? (
        <Button
          size="icon-xs"
          variant="ghost-destructive"
          aria-label="Delete memory entry"
          onClick={() =>
            void removeWithUndo(
              { entity: "memory", id: entry.id },
              {
                entity: "memory",
                value: {
                  id: entry.id,
                  projectId: entry.projectId,
                  sectionId: entry.sectionId,
                  threadId: entry.threadId,
                  kind: entry.kind,
                  text: entry.text,
                  done: entry.done,
                  source: entry.source,
                },
              },
              "Deleted memory entry",
            ).then((deleted) => {
              if (deleted) onDeleted(entry.id);
            })
          }
        >
          <Trash2Icon />
        </Button>
      ) : null}
    </li>
  );
}

function AddMemoryForm({ defaultProjectId }: { readonly defaultProjectId: ProjectId | null }) {
  const { projects } = useCommandCenter();
  const { upsert } = useCommandCenterCommands();
  const [kind, setKind] = useState<CommandCenterMemoryKind>("note");
  const [projectId, setProjectId] = useState<ProjectId | null>(defaultProjectId);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    const result = await upsert({
      entity: "memory",
      value: {
        projectId,
        sectionId: null,
        threadId: null,
        kind,
        text: trimmed,
        done: false,
        source: "user",
      },
    });
    setSaving(false);
    if (result._tag === "Success") setText("");
  };

  return (
    <form className="flex flex-col gap-2 rounded-lg border bg-card p-2.5" onSubmit={submit}>
      <Textarea
        size="sm"
        aria-label="New memory entry"
        placeholder="Where we left off, a decision, a todo…"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-32">
          <Select
            value={kind}
            onValueChange={(value) =>
              setKind(KINDS.find((item) => item.value === value)?.value ?? "note")
            }
          >
            <SelectTrigger aria-label="Kind" size="sm">
              <SelectValue>{KIND_LABEL.get(kind)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {KINDS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="min-w-0 flex-1">
          <ProjectPicker
            projects={projects}
            value={projectId}
            onValueChange={setProjectId}
            nullableLabel="No project"
            ariaLabel="Memory entry project"
          />
        </div>
        <Button type="submit" size="sm" disabled={saving || !text.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}
