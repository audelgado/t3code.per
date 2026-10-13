import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import { useNavigate } from "@tanstack/react-router";
import { LibraryIcon, Maximize2Icon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { usePrimarySettings } from "~/hooks/useSettings";
import { useThreadShell } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import type { ChatFileAttachment } from "~/types";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { observeResize } from "~/lib/observeResize";

// A frame may load its URL a little after mounting.
const MIN_URL_LIFE_MS = 5 * 60_000;

/**
 * An agent's HTML render inline in the thread: the page itself on the thread's
 * own background, at the server's measured height for this width until the
 * page reports its own. Loading and failure hold the same box so nothing below
 * it moves.
 */
export function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly onOpen: (attachment: ChatFileAttachment) => void;
  /** The thread the page belongs to; Save to library files it under the thread's project. */
  readonly threadRef?: ScopedThreadRef | undefined;
}) {
  const { attachmentId, title } = props.htmlRender;
  // The frame takes the page's measured height at its own width, read before
  // first paint so the reserved box is already the right size.
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    return observeResize(box, ([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
  }, []);
  // Client fonts can wrap a page taller than the server measured it; a frame
  // left short would scroll inside the thread and take the reader's scroll.
  const [contentHeight, setContentHeight] = useState<number>();
  const height = htmlRenderFrameHeight(props.htmlRender, width, contentHeight);
  const fileName = htmlRenderFileName(title);
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      fileName,
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId, fileName],
  );
  // A cached URL with life left is reused, so the browser's cache serves the
  // page again; one near expiry is minted afresh, since a frame cannot report a
  // failed load. The page keeps its first URL for its lifetime.
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const assetUrl = useAssetUrlState(src === null ? props.environmentId : null, resource);
  const cachedUrl = assetUrl._tag === "Success" ? assetUrl.url : null;
  const cachedExpiresAt = assetUrl._tag === "Success" ? assetUrl.expiresAt : 0;
  const cacheFailed = assetUrl._tag === "Failure";
  const refresh = useAssetUrlRefresh(props.environmentId, resource);
  // At most one mint per mount: expiry is server time and the check uses the
  // client clock, so a skewed clock must not mint again on every update.
  const minting = useRef(false);
  useEffect(() => {
    if (src !== null || minting.current) return;
    if (cacheFailed) {
      // oxlint-disable-next-line react/set-state-in-effect -- Mirrors the cached URL's failure.
      setFailed(true);
      return;
    }
    if (cachedUrl === null) return;
    if (cachedExpiresAt - Date.now() > MIN_URL_LIFE_MS) {
      setSrc(cachedUrl);
      return;
    }
    minting.current = true;
    void refresh().then(
      (url) => (url === null ? setFailed(true) : setSrc(url)),
      () => setFailed(true),
    );
  }, [cacheFailed, cachedExpiresAt, cachedUrl, refresh, src]);

  return (
    <div ref={boxRef} className="group/html-render relative" style={{ height }}>
      {src !== null ? (
        <>
          <HtmlRenderDocument
            src={src}
            title={title}
            className="block size-full"
            onContentHeight={setContentHeight}
          />
          <div className="absolute end-2 top-2 flex gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
            <SaveToLibraryButton
              environmentId={props.environmentId}
              threadRef={props.threadRef}
              attachmentId={attachmentId}
              title={title}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Open in panel"
                    size="icon-xs"
                    variant="glass"
                    onClick={() =>
                      props.onOpen({
                        type: "file",
                        id: attachmentId,
                        name: fileName,
                        mimeType: "text/html",
                        // Unknown here; the preview leaves it out.
                        sizeBytes: 0,
                        htmlRender: true,
                      })
                    }
                  />
                }
              >
                <Maximize2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="left">Open in panel</TooltipPopup>
            </Tooltip>
          </div>
        </>
      ) : failed ? (
        <p className="flex size-full items-center justify-center text-muted-foreground text-xs">
          Unable to load {title}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Copies the page into Command Center's artifact library. The library lives on the primary
 * machine and reads the page from its own attachment store, so this shows only for pages there.
 */
function SaveToLibraryButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly attachmentId: string;
  readonly title: string;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const enabled = usePrimarySettings((settings) => settings.commandCenter.enabled);
  const permitted = useAtomValue(
    serverEnvironment.saveCommandCenterArtifact.permissionAtom(primaryEnvironmentId),
  );
  const shell = useThreadShell(props.threadRef ?? null);
  const save = useAtomCommand(serverEnvironment.saveCommandCenterArtifact, "save to library");
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!enabled || !permitted || props.environmentId !== primaryEnvironmentId) return null;

  const run = async () => {
    setBusy(true);
    const result = await save({
      environmentId: props.environmentId,
      input: {
        title: props.title,
        fromAttachmentId: props.attachmentId,
        ...(shell ? { projectId: shell.projectId, threadId: shell.id } : {}),
      },
    });
    setBusy(false);
    if (result._tag !== "Success") return;
    const { artifact } = result.value;
    const id = toastManager.add({
      type: "success",
      title: `Saved ${artifact.title} to Artifacts`,
      actionProps: {
        children: "Open",
        onClick: () => {
          toastManager.close(id);
          void navigate({ to: "/command", search: { tab: "artifacts", artifact: artifact.id } });
        },
      },
    });
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Save to library"
            size="icon-xs"
            variant="glass"
            disabled={busy}
            onClick={() => void run()}
          />
        }
      >
        <LibraryIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="left">Save to Artifacts</TooltipPopup>
    </Tooltip>
  );
}
