import type {
  CommandCenterCanvasItemKind,
  CommandCenterMemoryEntry,
  ProjectId,
} from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { CollectionPager } from "../CollectionPager";
import { paginateCollection } from "../collectionPaging";
import { SECTION_STATUS_LABEL, sortSections } from "../projects/logic";
import { useCommandCenter, useCommandCenterCommands } from "../shared";
import { refKey } from "./canvasLogic";

type PickableKind = Exclude<CommandCenterCanvasItemKind, "note">;

interface PickerRow {
  readonly kind: PickableKind;
  readonly refId: string;
  readonly title: string;
  readonly detail: string;
}

/** Artifacts offered per group; the search goes to the server, so older ones stay reachable. */
const ARTIFACT_PAGE = 50;
/** The project's memory entries offered, newest first (the snapshot holds only the newest overall). */
const MEMORY_PAGE = 200;

/**
 * Puts existing rows on the board: this project's (and global) artifacts, its sections and its
 * memory entries. Mounted only while open, so its artifact subscriptions run only then.
 */
export function CanvasPicker({
  projectId,
  onBoard,
  onOpenChange,
  onAdd,
}: {
  readonly projectId: ProjectId;
  /** `refKey`s of rows already on the board. */
  readonly onBoard: ReadonlySet<string>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAdd: (kind: PickableKind, refId: string) => Promise<boolean>;
}) {
  const { snapshot, primaryEnvironmentId } = useCommandCenter();
  const { listMemory } = useCommandCenterCommands();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("Artifacts");
  const [page, setPage] = useState(1);
  const query = useDebouncedValue(search.trim(), 250);
  const artifactInput = (scope: ProjectId | null) => ({
    projectId: scope,
    limit: ARTIFACT_PAGE,
    ...(query === "" ? {} : { query }),
  });
  const projectArtifacts = useEnvironmentQuery(
    serverEnvironment.commandCenterArtifactsLive({
      environmentId: primaryEnvironmentId,
      input: artifactInput(projectId),
    }),
  );
  const globalArtifacts = useEnvironmentQuery(
    serverEnvironment.commandCenterArtifactsLive({
      environmentId: primaryEnvironmentId,
      input: artifactInput(null),
    }),
  );
  const artifactsError = projectArtifacts.error ?? globalArtifacts.error;
  const artifacts =
    projectArtifacts.data && globalArtifacts.data
      ? [...projectArtifacts.data.artifacts, ...globalArtifacts.data.artifacts]
      : undefined;
  // One read of the project's memory when the picker opens; the snapshot fills in newer edits.
  const [olderMemory, setOlderMemory] = useState<ReadonlyArray<CommandCenterMemoryEntry>>([]);
  useEffect(() => {
    let current = true;
    void listMemory({ projectId, limit: MEMORY_PAGE }).then((result) => {
      if (current && result._tag === "Success") setOlderMemory(result.value.entries);
    });
    return () => {
      current = false;
    };
  }, [listMemory, projectId]);
  // Added during this visit; the board's own list catches up after its refresh.
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set());

  const groups = useMemo(() => {
    const rows: Array<{ label: string; rows: PickerRow[] }> = [
      {
        label: "Artifacts",
        rows: (artifacts ?? []).map((artifact) => ({
          kind: "artifact",
          refId: artifact.id,
          title: artifact.title,
          detail: `${artifact.kind === "html" ? "HTML" : "Markdown"} · v${artifact.currentVersion}${artifact.projectId === null ? " · all projects" : ""}`,
        })),
      },
      {
        label: "Sections",
        rows: sortSections(
          snapshot.sections.filter((section) => section.projectId === projectId),
        ).map((section) => ({
          kind: "section",
          refId: section.id,
          title: section.name,
          detail: SECTION_STATUS_LABEL[section.status],
        })),
      },
      {
        label: "Memory",
        rows: [
          ...new Map(
            [...olderMemory, ...snapshot.memory]
              .filter((entry) => entry.projectId === projectId)
              .map((entry) => [entry.id, entry] as const),
          ).values(),
        ]
          .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map((entry) => ({
            kind: "memory",
            refId: entry.id,
            title: entry.text.split("\n", 1)[0] ?? entry.text,
            detail: entry.kind.charAt(0).toUpperCase() + entry.kind.slice(1),
          })),
      },
    ];
    // Artifacts are already searched on the server; the rest is filtered here.
    const needle = search.trim().toLowerCase();
    return rows.map((group) => ({
      label: group.label,
      rows: group.rows.filter(
        (row) =>
          !onBoard.has(refKey(row.kind, row.refId)) &&
          (needle === "" ||
            group.label === "Artifacts" ||
            row.title.toLowerCase().includes(needle)),
      ),
    }));
  }, [artifacts, olderMemory, onBoard, projectId, search, snapshot.memory, snapshot.sections]);

  const add = async (row: PickerRow) => {
    const key = refKey(row.kind, row.refId);
    if (added.has(key)) return;
    setAdded((current) => new Set(current).add(key));
    if (!(await onAdd(row.kind, row.refId))) {
      setAdded((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };
  const group = groups.find((candidate) => candidate.label === kind) ?? groups[0]!;
  const directory = paginateCollection(group.rows, page, 15);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Add to canvas</DialogTitle>
          <DialogDescription>
            Choose a source, find an item and add it to the middle of the board view.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            autoFocus
            type="search"
            aria-label="Search"
            placeholder="Search artifacts, sections and memory"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
          <ToggleGroup
            aria-label="Canvas item source"
            variant="segmented"
            value={[kind]}
            onValueChange={(values) => {
              if (groups.some((candidate) => candidate.label === values[0])) {
                setKind(values[0]!);
                setPage(1);
              }
            }}
          >
            {groups.map((candidate) => (
              <Toggle key={candidate.label} value={candidate.label}>
                {candidate.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <section key={group.label} className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground">{group.label}</h3>
            {group.label === "Artifacts" && artifacts === undefined ? (
              <p className="text-sm text-muted-foreground" role="status">
                {artifactsError ? `Could not load artifacts: ${artifactsError}` : "Loading…"}
              </p>
            ) : group.rows.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">
                {search.trim()
                  ? "No available items match your search."
                  : "Nothing else to add from this source."}
              </p>
            ) : (
              <ul className="flex flex-col">
                {directory.items.map((row) => {
                  const done = added.has(refKey(row.kind, row.refId));
                  return (
                    <li key={row.refId}>
                      <button
                        type="button"
                        disabled={done}
                        onClick={() => void add(row)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:text-muted-foreground"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{row.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {row.detail}
                          </span>
                        </span>
                        {done ? (
                          <CheckIcon aria-label="Added" className="size-3.5 shrink-0" />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <CollectionPager {...directory} label={kind.toLowerCase()} onPageChange={setPage} />
          {kind === "Artifacts" &&
          (projectArtifacts.data?.hasMore || globalArtifacts.data?.hasMore) ? (
            <p className="text-xs text-muted-foreground">
              Showing the newest available artifacts. Search by title to find older pages.
            </p>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
