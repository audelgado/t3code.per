import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthPreviewOperateScope,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
} from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { useNavigate } from "@tanstack/react-router";
import { GlobeIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { openUrlInPreview } from "~/browser/openFileInPreview";
import { resolveReachableServerUrl } from "~/browser/browserTargetResolver";
import { isPreviewAvailableFor } from "~/browser/previewRuntime";
import { recordVisitForThread } from "~/browserHistoryStore";
import { readLocalApi } from "~/localApi";
import { useRightPanelStore } from "~/rightPanelStore";
import { readThreadShells } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { getConfiguredPreviewUrls } from "../../preview/previewEmptyStateLogic";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { toastManager } from "../../ui/toast";
import { previewThreadFor } from "./logic";

/**
 * Opens the project's preview in T3's browser panel. The panel lives beside a thread, so this
 * opens it in the project's latest thread on `environmentId` and goes there. Without a thread
 * (or a browser in this client) a URL falls back to the system browser.
 */
function useOpenProjectPreview(project: EnvironmentProject, environmentId: EnvironmentId) {
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const canPreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const navigate = useNavigate();
  return async (url: string | null) => {
    const threadId = previewThreadFor(readThreadShells(), environmentId, project.id);
    if (threadId === null || !canPreview || !isPreviewAvailableFor(environmentId)) {
      // A dev server's localhost is the server machine's; the system browser only gets a URL this
      // device can actually reach.
      const external = url === null ? null : resolveReachableServerUrl(environmentId, url);
      if (external !== null) {
        try {
          await readLocalApi()?.shell.openExternal(external);
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Could not open the preview",
            description: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      const unreachable =
        url === null ? "" : ` ${url} runs on that machine, and this device cannot reach it.`;
      toastManager.add({
        type: "info",
        ...(threadId === null
          ? {
              title: "No thread to open the preview in",
              description: `The preview browser opens beside a thread. Start one in ${project.title} first.${unreachable}`,
            }
          : !canPreview
            ? {
                title: "Preview is not allowed here",
                description: `This connection cannot use the preview browser.${unreachable}`,
              }
            : {
                title: "No preview browser in this window",
                description: `Open the preview from the desktop app or the web app.${unreachable}`,
              }),
      });
      return;
    }
    const threadRef = scopeThreadRef(environmentId, threadId);
    if (url === null) {
      // An empty tab shows the panel's own start page: running dev servers and recent URLs.
      useRightPanelStore.getState().openBrowser(threadRef, null);
    } else {
      const result = await openUrlInPreview({ threadRef, url, openPreview });
      if (isAtomCommandInterrupted(result)) return;
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not open the preview",
          description: String(squashAtomCommandFailure(result)),
        });
        return;
      }
      recordVisitForThread(threadRef, url);
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  };
}

/**
 * "Open preview" for a project on one machine: its configured preview URLs (project scripts),
 * or the browser panel's start page, which lists running dev servers.
 */
export function ProjectPreviewButton({
  project,
  environmentId = project.environmentId,
  compact = false,
}: {
  readonly project: EnvironmentProject;
  /** Machine whose dev server to open; the project's own environment by default. */
  readonly environmentId?: EnvironmentId;
  /** Icon-only, for dense rows. */
  readonly compact?: boolean;
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const urls = useMemo(
    () =>
      getConfiguredPreviewUrls(resolveProjectScripts(settings ?? DEFAULT_SERVER_SETTINGS, project)),
    [project, settings],
  );
  const open = useOpenProjectPreview(project, environmentId);
  const [busy, setBusy] = useState(false);
  const run = (url: string | null) => {
    setBusy(true);
    void open(url).finally(() => setBusy(false));
  };
  const buttonProps = compact
    ? ({
        size: "icon-xs",
        variant: "ghost-muted",
        "aria-label": `Open ${project.title} preview`,
      } as const)
    : ({ size: "xs", variant: "outline" } as const);
  const content = (
    <>
      <GlobeIcon />
      {compact ? null : "Preview"}
    </>
  );

  if (urls.length === 0) {
    return (
      <Button {...buttonProps} disabled={busy} onClick={() => run(null)}>
        {content}
      </Button>
    );
  }
  return (
    <Menu>
      <MenuTrigger render={<Button {...buttonProps} disabled={busy} />}>{content}</MenuTrigger>
      <MenuPopup align="end">
        {urls.map((url) => (
          <MenuItem key={url} onClick={() => run(url)}>
            {url}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onClick={() => run(null)}>Browser start page</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
