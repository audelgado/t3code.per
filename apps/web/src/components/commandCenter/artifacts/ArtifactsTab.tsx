import {
  CommandCenterArtifactId,
  type CommandCenterArtifact,
  type CommandCenterArtifactListInput,
  type ProjectId,
} from "@t3tools/contracts";
import { artifactAgentReference } from "@t3tools/client-runtime/command-center-delegation";
import { FileUpIcon, SearchIcon } from "lucide-react";
import { type DragEvent, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useDebouncedValue } from "~/state/queries";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../ui/input-group";
import { toastManager } from "../../ui/toast";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { useCommandCenter } from "../shared";
import { ArtifactImportDialog } from "./ArtifactImportDialog";
import { ArtifactThumbnail } from "./ArtifactThumbnail";
import { ArtifactViewer } from "./ArtifactViewer";
import {
  ARTIFACT_PAGE_SIZE,
  artifactImportFileError,
  livePageBoundary,
  mergeArtifactPages,
  nextArtifactCursor,
} from "./artifactLogic";
import { useArtifactCommands } from "./useArtifactCommands";

interface OlderPages {
  /** Filter and live-page boundary these pages were fetched against; any change drops them. */
  readonly key: string;
  readonly rows: ReadonlyArray<CommandCenterArtifact>;
  readonly hasMore: boolean;
}

const NO_OLDER: OlderPages = { key: "", rows: [], hasMore: false };

/**
 * The artifacts library: HTML and Markdown pages saved by you (import, paste, drop) or by agents
 * (MCP `artifact_save`), for every project or the one picked in the page's project filter.
 */
export function ArtifactsTab({
  openId: openParam,
  onOpenChange,
  onSendToAgent,
}: {
  /** Artifact open in the viewer (kept in the URL, so other views can link to it). */
  readonly openId: string | null;
  readonly onOpenChange: (artifactId: CommandCenterArtifactId | null) => void;
  /** Pre-fills the orchestrator bar with a reference to the artifact. */
  readonly onSendToAgent: (text: string, projectId: ProjectId | null) => void;
}) {
  const { primaryEnvironmentId, projectId, projects } = useCommandCenter();
  const commands = useArtifactCommands();
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 250);
  const filter = useMemo(
    () => ({
      ...(projectId !== null ? { projectId } : {}),
      ...(archived ? { archived: true } : {}),
      ...(query !== "" ? { query } : {}),
      limit: ARTIFACT_PAGE_SIZE,
    }),
    [archived, projectId, query],
  );
  const live = useEnvironmentQuery(
    serverEnvironment.commandCenterArtifactsLive({
      environmentId: primaryEnvironmentId,
      input: filter,
    }),
  );
  const liveRows = live.data?.artifacts ?? [];
  const pageKey = `${JSON.stringify(filter)}|${livePageBoundary(liveRows)}`;
  const [older, setOlder] = useState<OlderPages>(NO_OLDER);
  const olderRows = older.key === pageKey ? older.rows : [];
  const artifacts = mergeArtifactPages(liveRows, olderRows);
  const hasMore = older.key === pageKey ? older.hasMore : (live.data?.hasMore ?? false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const openId = openParam === null ? null : CommandCenterArtifactId.make(openParam);
  const setOpenId = onOpenChange;
  const [importOpen, setImportOpen] = useState(false);
  const [dragging, setDragging] = useState(false);

  const projectTitle = useMemo(
    () => new Map(projects.map((project) => [project.id, project.title] as const)),
    [projects],
  );
  const destination =
    projectId !== null ? (projectTitle.get(projectId) ?? "this project") : "no project";

  const loadOlder = async () => {
    const cursor = nextArtifactCursor(artifacts);
    if (loadingOlder || cursor === undefined) return;
    setLoadingOlder(true);
    const input: CommandCenterArtifactListInput = { ...filter, ...cursor };
    const result = await commands.list(input);
    setLoadingOlder(false);
    if (result._tag !== "Success") return;
    setOlder({
      key: pageKey,
      rows: [...olderRows, ...result.value.artifacts],
      hasMore: result.value.hasMore,
    });
  };
  // Archiving moves a row to the other view; the live page follows by itself, older pages do not.
  const forgetOlder = (artifact: CommandCenterArtifact) =>
    setOlder((current) => ({
      ...current,
      rows: current.rows.filter((row) => row.id !== artifact.id),
    }));

  const announceImport = (artifact: CommandCenterArtifact) => {
    const id = toastManager.add({
      type: "success",
      title: `Imported ${artifact.title}`,
      actionProps: {
        children: "Open",
        onClick: () => {
          toastManager.close(id);
          setOpenId(artifact.id);
        },
      },
    });
  };
  const importText = async (content: string, title: string | null) => {
    const result = await commands.import({
      content,
      projectId,
      ...(title !== null ? { title } : {}),
    });
    if (result._tag !== "Success") return false;
    announceImport(result.value.artifact);
    return true;
  };
  const importFiles = async (files: ReadonlyArray<File>) => {
    for (const file of files) {
      const problem = artifactImportFileError(file);
      if (problem !== null) {
        toastManager.add({ type: "error", title: "Could not import", description: problem });
        continue;
      }
      const result = await commands.import({
        content: await file.text(),
        fileName: file.name,
        projectId,
      });
      if (result._tag === "Success") announceImport(result.value.artifact);
    }
  };

  const sendToAgent = (artifact: CommandCenterArtifact) => {
    const text = artifactAgentReference(artifact);
    setOpenId(null);
    // The viewer closes into the orchestrator bar, so the text lands where the cursor is.
    onSendToAgent(text, artifact.projectId);
  };

  const canDrop = commands.canWrite && !archived;
  const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  const dropProps = canDrop
    ? {
        onDragOver: (event: DragEvent<HTMLDivElement>) => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          if (!dragging) setDragging(true);
        },
        onDragLeave: (event: DragEvent<HTMLDivElement>) => {
          const to = event.relatedTarget;
          if (!(to instanceof Node && event.currentTarget.contains(to))) setDragging(false);
        },
        onDrop: (event: DragEvent<HTMLDivElement>) => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          setDragging(false);
          void importFiles([...event.dataTransfer.files]);
        },
      }
    : {};

  return (
    <div
      {...dropProps}
      className={cn(
        "flex flex-col gap-3 rounded-xl outline-2 -outline-offset-2 outline-transparent",
        dragging && "outline-dashed outline-primary",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-64 max-sm:w-full">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              size="sm"
              aria-label="Search artifacts by title"
              placeholder="Search by title"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </InputGroup>
        </div>
        <ToggleGroup
          aria-label="Which artifacts"
          variant="segmented"
          value={[archived ? "deleted" : "active"]}
          onValueChange={(next) => {
            if (next[0] === "active" || next[0] === "deleted") setArchived(next[0] === "deleted");
          }}
        >
          <Toggle value="active">Library</Toggle>
          <Toggle value="deleted">Deleted</Toggle>
        </ToggleGroup>
        <div className="flex-1" />
        {commands.canWrite ? (
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
            <FileUpIcon />
            Import
          </Button>
        ) : null}
      </div>

      {live.data === null ? (
        <p className="py-12 text-center text-sm text-muted-foreground" role="status">
          {live.error ? `Could not load artifacts: ${live.error}` : "Loading artifacts…"}
        </p>
      ) : artifacts.length === 0 ? (
        <EmptyState
          archived={archived}
          searching={query !== ""}
          destination={projectId !== null ? destination : null}
          canWrite={commands.canWrite}
          onImport={() => setImportOpen(true)}
        />
      ) : (
        <>
          <ul
            aria-label="Artifacts"
            className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3"
          >
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(artifact.id)}
                  className="flex w-full flex-col overflow-hidden rounded-xl border bg-card text-start outline-none hover:border-ring/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <ArtifactThumbnail environmentId={primaryEnvironmentId} artifact={artifact} />
                  <span className="flex min-w-0 flex-col gap-1 p-3">
                    <span className="truncate text-sm font-medium">{artifact.title}</span>
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge size="sm" variant="outline">
                        {artifact.kind === "html" ? "HTML" : "MD"}
                      </Badge>
                      <span className="truncate">
                        {artifact.projectId !== null && projectId === null
                          ? `${projectTitle.get(artifact.projectId) ?? "Project"} · `
                          : ""}
                        v{artifact.currentVersion} · {formatRelativeTimeLabel(artifact.updatedAt)}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {hasMore ? (
            <div className="flex justify-center">
              <Button
                size="sm"
                variant="outline"
                disabled={loadingOlder}
                onClick={() => void loadOlder()}
              >
                {loadingOlder ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <ArtifactViewer
        environmentId={primaryEnvironmentId}
        artifactId={openId}
        liveArtifact={artifacts.find((artifact) => artifact.id === openId) ?? null}
        onClose={() => setOpenId(null)}
        onSendToAgent={sendToAgent}
        onArchivedChange={forgetOlder}
      />
      <ArtifactImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        destination={destination}
        onImportText={importText}
        onImportFiles={(files) => void importFiles(files)}
      />
    </div>
  );
}

function EmptyState({
  archived,
  searching,
  destination,
  canWrite,
  onImport,
}: {
  readonly archived: boolean;
  readonly searching: boolean;
  /** Project name when filtered to one. */
  readonly destination: string | null;
  readonly canWrite: boolean;
  readonly onImport: () => void;
}) {
  const text = searching
    ? "No artifacts match that title."
    : archived
      ? "Nothing deleted. Deleted artifacts wait here until you restore them."
      : `No pages saved${destination === null ? "" : ` to ${destination}`} yet. Ask an agent to save one to the library, or import a page.`;
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-12 text-center">
      <p className="max-w-sm text-sm text-muted-foreground">{text}</p>
      {canWrite && !archived && !searching ? (
        <Button size="sm" variant="outline" onClick={onImport}>
          <FileUpIcon />
          Import or drop a file
        </Button>
      ) : null}
    </div>
  );
}
