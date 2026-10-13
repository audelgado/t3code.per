import type {
  CommandCenterArtifact,
  CommandCenterArtifactDetail,
  CommandCenterArtifactId,
  CommandCenterArtifactVersion,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  ExternalLinkIcon,
  GitCompareIcon,
  HistoryIcon,
  Maximize2Icon,
  Minimize2Icon,
  RotateCcwIcon,
  SendHorizontalIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import ChatMarkdown from "~/components/ChatMarkdown";
import { formatBytes } from "~/lib/formatBytes";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { HtmlRenderDocument } from "../../files/BrowserDocumentFrame";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { ScrollArea } from "../../ui/scroll-area";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../../ui/sheet";
import { toastManager } from "../../ui/toast";
import { Toggle } from "../../ui/toggle";
import { ORCHESTRATOR_INPUT_ID } from "../shared";
import { ArtifactDiff } from "./ArtifactDiff";
import { previousArtifactVersion } from "./artifactLogic";
import { useArtifactCommands } from "./useArtifactCommands";

export interface ArtifactViewerProps {
  readonly environmentId: EnvironmentId;
  /** Open artifact; null closes the sheet. */
  readonly artifactId: CommandCenterArtifactId | null;
  /** Its row in the live list, when loaded there; a newer `currentVersion` refreshes the view. */
  readonly liveArtifact: CommandCenterArtifact | null;
  readonly onClose: () => void;
  readonly onSendToAgent: (artifact: CommandCenterArtifact) => void;
  /** Called after the artifact is archived or restored, so older pages can drop their copy. */
  readonly onArchivedChange: (artifact: CommandCenterArtifact) => void;
}

/** One artifact in a side sheet: the page, its history, a diff against the previous version. */
export function ArtifactViewer(props: ArtifactViewerProps) {
  const [expanded, setExpanded] = useState(false);
  // Send to agent closes the sheet into the orchestrator bar instead of back onto the card.
  const toOrchestrator = useRef(false);
  const { onSendToAgent } = props;
  const sendToAgent = useCallback(
    (artifact: CommandCenterArtifact) => {
      toOrchestrator.current = true;
      onSendToAgent(artifact);
    },
    [onSendToAgent],
  );
  return (
    <Sheet open={props.artifactId !== null} onOpenChange={(open) => !open && props.onClose()}>
      <SheetPopup
        side="right"
        className={expanded ? "max-w-none" : "max-w-4xl"}
        finalFocus={() => {
          if (!toOrchestrator.current) return true;
          toOrchestrator.current = false;
          return document.getElementById(ORCHESTRATOR_INPUT_ID);
        }}
      >
        {/* Keyed so each artifact opens on its current version with the diff off. */}
        {props.artifactId !== null ? (
          <ViewerBody
            key={props.artifactId}
            {...props}
            onSendToAgent={sendToAgent}
            artifactId={props.artifactId}
            expanded={expanded}
            onExpandedChange={setExpanded}
          />
        ) : null}
      </SheetPopup>
    </Sheet>
  );
}

function ViewerBody({
  environmentId,
  artifactId,
  liveArtifact,
  onClose,
  onSendToAgent,
  onArchivedChange,
  expanded,
  onExpandedChange,
}: ArtifactViewerProps & {
  readonly artifactId: CommandCenterArtifactId;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
}) {
  const commands = useArtifactCommands();
  // The current version carries the artifact row and the full history; another version is
  // fetched only while it is selected.
  const current = useEnvironmentQuery(
    serverEnvironment.commandCenterArtifact({ environmentId, input: { id: artifactId } }),
  );
  const loadedVersion = current.data?.artifact.currentVersion;
  const liveVersion = liveArtifact?.currentVersion;
  const refreshCurrent = current.refresh;
  // An agent (or another client) saved a new version: the live list says so first.
  useEffect(() => {
    if (liveVersion !== undefined && loadedVersion !== undefined && liveVersion > loadedVersion) {
      refreshCurrent();
    }
  }, [liveVersion, loadedVersion, refreshCurrent]);

  const [selected, setSelected] = useState<number | null>(null);
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const detail = current.data;
  const selectedVersion =
    selected !== null && selected !== detail?.version.version ? selected : null;
  const other = useEnvironmentQuery(
    selectedVersion === null
      ? null
      : serverEnvironment.commandCenterArtifact({
          environmentId,
          input: { id: artifactId, version: selectedVersion },
        }),
  );
  const shown: CommandCenterArtifactDetail | null = selectedVersion === null ? detail : other.data;
  const previous =
    detail && shown ? previousArtifactVersion(detail.versions, shown.version.version) : null;
  // HTML views load the page from its attachment; only a diff pulls both sources over the socket.
  const diffing = comparing && previous !== null && shown !== null;
  const before = useEnvironmentQuery(
    diffing
      ? serverEnvironment.commandCenterArtifact({
          environmentId,
          input: { id: artifactId, version: previous, includeContent: true },
        })
      : null,
  );
  const after = useEnvironmentQuery(
    diffing
      ? serverEnvironment.commandCenterArtifact({
          environmentId,
          input: { id: artifactId, version: shown.version.version, includeContent: true },
        })
      : null,
  );

  if (detail === null) {
    return (
      <>
        <SheetHeader>
          <SheetTitle>
            <span className="block truncate pe-8">{liveArtifact?.title ?? "Artifact"}</span>
          </SheetTitle>
          <SheetDescription>
            {current.error ? `Could not load this artifact: ${current.error}` : "Loading…"}
          </SheetDescription>
        </SheetHeader>
        {current.error ? (
          <div className="px-6">
            <Button size="sm" variant="outline" onClick={refreshCurrent}>
              Try again
            </Button>
          </div>
        ) : null}
      </>
    );
  }

  const artifact = detail.artifact;
  const archived = artifact.archivedAt !== null;
  const viewing = shown?.version ?? null;
  const isCurrent = viewing?.version === artifact.currentVersion;

  const restoreVersion = async () => {
    if (viewing === null || busy) return;
    setBusy(true);
    const result = await commands.restoreVersion(artifact, viewing.version);
    setBusy(false);
    if (result._tag !== "Success") return;
    setSelected(null);
    toastManager.add({
      type: "success",
      title: `Restored v${viewing.version} as v${result.value.version.version}`,
    });
  };
  const setArchived = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    const result = next
      ? await commands.archiveWithUndo(artifact)
      : (await commands.unarchive(artifact))._tag === "Success";
    setBusy(false);
    if (!result) return;
    onArchivedChange(artifact);
    if (next) onClose();
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>
          <span className="block truncate pe-8">{artifact.title}</span>
        </SheetTitle>
        <SheetDescription>
          {artifact.kind === "html" ? "HTML" : "Markdown"} · v{artifact.currentVersion} · updated{" "}
          {formatRelativeTimeLabel(artifact.updatedAt)}
          {archived ? " · deleted" : ""}
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
        <Button size="sm" onClick={() => onSendToAgent(artifact)}>
          <SendHorizontalIcon />
          Send to agent
        </Button>
        <Toggle
          size="sm"
          variant="outline"
          pressed={comparing}
          disabled={previous === null}
          onPressedChange={setComparing}
        >
          <GitCompareIcon />
          {previous === null ? "No earlier version" : `Diff with v${previous}`}
        </Toggle>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={expanded ? "Narrow the view" : "Widen to full page"}
          aria-pressed={expanded}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
        </Button>
        {artifact.kind === "html" && viewing !== null ? (
          <OpenInTabButton environmentId={environmentId} attachmentId={viewing.attachmentId} />
        ) : null}
        <div className="flex-1" />
        {commands.canWrite ? (
          archived ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void setArchived(false)}
            >
              <Undo2Icon />
              Restore
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost-destructive"
              disabled={busy}
              onClick={() => void setArchived(true)}
            >
              <Trash2Icon />
              Delete
            </Button>
          )
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col border-t md:flex-row">
        <div className="flex min-h-64 min-w-0 flex-1 flex-col">
          {shown === null ? (
            <p className="p-6 text-sm text-muted-foreground" role="status">
              {other.error ? `Could not load v${selectedVersion}: ${other.error}` : "Loading…"}
            </p>
          ) : comparing && previous !== null ? (
            before.data === null || after.data === null ? (
              <p className="p-6 text-sm text-muted-foreground" role="status">
                {before.error || after.error
                  ? `Could not load the versions to compare: ${before.error ?? after.error}`
                  : "Loading…"}
              </p>
            ) : (
              <ScrollArea className="min-h-0 flex-1">
                <ArtifactDiff
                  kind={artifact.kind}
                  before={before.data.content ?? ""}
                  after={after.data.content ?? ""}
                  cacheKey={`${artifact.id}:${previous}:${shown.version.version}`}
                />
              </ScrollArea>
            )
          ) : artifact.kind === "html" ? (
            <HtmlVersionFrame
              key={shown.version.attachmentId}
              environmentId={environmentId}
              version={shown.version}
              title={artifact.title}
            />
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <ChatMarkdown
                text={shown.content ?? ""}
                cwd={undefined}
                environmentId={environmentId}
                className="mx-auto max-w-4xl px-6 py-5"
              />
            </ScrollArea>
          )}
        </div>
        <VersionList
          versions={detail.versions}
          currentVersion={artifact.currentVersion}
          viewing={viewing?.version ?? null}
          onSelect={(version) => setSelected(version === artifact.currentVersion ? null : version)}
          restore={
            !isCurrent && viewing !== null && commands.canWrite
              ? { busy, onRestore: () => void restoreVersion() }
              : null
          }
        />
      </div>
    </>
  );
}

function useVersionUrl(environmentId: EnvironmentId, attachmentId: string) {
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId],
  );
  return useAssetUrlState(environmentId, resource);
}

/** The stored page, sandboxed like an agent's inline render (the server stored its bootstrap). */
function HtmlVersionFrame({
  environmentId,
  version,
  title,
}: {
  readonly environmentId: EnvironmentId;
  readonly version: CommandCenterArtifactVersion;
  readonly title: string;
}) {
  const url = useVersionUrl(environmentId, version.attachmentId);
  if (url._tag === "Success") {
    return <HtmlRenderDocument src={url.url} title={title} className="min-h-0 w-full flex-1" />;
  }
  return (
    <p className="p-6 text-sm text-muted-foreground" role="status">
      {url._tag === "Failure" ? `Unable to load ${title}.` : "Loading…"}
    </p>
  );
}

/** Opens the page alone in a browser tab; the server serves it sandboxed there too. */
function OpenInTabButton({
  environmentId,
  attachmentId,
}: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
}) {
  const url = useVersionUrl(environmentId, attachmentId);
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label="Open in a new tab"
      disabled={url._tag !== "Success"}
      onClick={() => {
        if (url._tag === "Success") window.open(url.url, "_blank", "noopener,noreferrer");
      }}
    >
      <ExternalLinkIcon />
    </Button>
  );
}

const AUTHOR_LABEL = { user: "You", agent: "Agent" } as const;

function VersionList({
  versions,
  currentVersion,
  viewing,
  onSelect,
  restore,
}: {
  readonly versions: ReadonlyArray<CommandCenterArtifactVersion>;
  readonly currentVersion: number;
  readonly viewing: number | null;
  readonly onSelect: (version: number) => void;
  /** Shown while an older version is selected and the viewer may write. */
  readonly restore: { readonly busy: boolean; readonly onRestore: () => void } | null;
}) {
  return (
    <section
      aria-label="Version history"
      className="flex max-h-72 shrink-0 flex-col border-t md:max-h-none md:w-60 md:border-s md:border-t-0"
    >
      <h3 className="flex items-center gap-1.5 px-4 pt-3 pb-2 text-xs font-medium text-muted-foreground">
        <HistoryIcon aria-hidden className="size-3.5" />
        History
      </h3>
      {restore ? (
        <div className="px-3 pb-2">
          <Button size="sm" variant="outline" disabled={restore.busy} onClick={restore.onRestore}>
            <RotateCcwIcon />
            Restore v{viewing}
          </Button>
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <ol className="flex flex-col gap-0.5 px-2 pb-3">
          {versions.map((version) => (
            <li key={version.version}>
              <button
                type="button"
                aria-current={version.version === viewing ? "true" : undefined}
                onClick={() => onSelect(version.version)}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-start text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  version.version === viewing && "bg-accent",
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span className="font-medium text-foreground">v{version.version}</span>
                  {version.version === currentVersion ? (
                    <Badge size="sm" variant="secondary">
                      Current
                    </Badge>
                  ) : null}
                </span>
                <span className="truncate text-muted-foreground">
                  {version.authorLabel ?? AUTHOR_LABEL[version.author]} ·{" "}
                  {formatRelativeTimeLabel(version.createdAt)} · {formatBytes(version.sizeBytes)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </ScrollArea>
    </section>
  );
}
