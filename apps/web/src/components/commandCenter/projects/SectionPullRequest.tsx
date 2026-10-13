import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { CommandCenterSection } from "@t3tools/contracts";
import { LinkIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { cn } from "~/lib/utils";
import { usePullRequestPreviewTarget, useOpenPrLink } from "~/lib/openPullRequestLink";
import { useEnvironmentQuery } from "~/state/query";
import { linkedPullRequestDetailAtom, pullRequestEnvironment } from "~/state/pullRequests";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { PullRequestGlyph } from "../../pullRequest/pullRequestIcons";
import {
  PullRequestReviewDecisionGlyph,
  PullRequestStateGlyph,
  pullRequestChecksStatePresentation,
} from "../../pullRequest/pullRequestPresentation";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { toastManager } from "../../ui/toast";
import { useDocumentVisible } from "../infra/useDocumentVisible";
import { useCommandCenter } from "../shared";
import { pullRequestLinkFromInput } from "./logic";

/**
 * A section's linked pull request: its live state (read only while the window shows, through
 * the same cached summary the sidebar's PR badges use) and, for operators, link / change / unlink.
 */
export function SectionPullRequest({
  section,
  project,
}: {
  readonly section: CommandCenterSection;
  readonly project: EnvironmentProject;
}) {
  const { primaryEnvironmentId, canOperate } = useCommandCenter();
  const permitted = useAtomValue(
    serverEnvironment.setCommandCenterSectionPullRequest.permissionAtom(primaryEnvironmentId),
  );
  // `canOperate` is false while the primary machine reconnects, when changes are paused.
  const canEdit = canOperate && permitted;
  const [open, setOpen] = useState(false);
  const prUrl = section.prUrl ?? null;
  if (prUrl === null && !canEdit) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {prUrl === null ? null : (
        <LinkedPullRequest project={project} url={prUrl} number={section.prNumber ?? null} />
      )}
      {canEdit ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={
                  prUrl === null
                    ? `Link a pull request to ${section.name}`
                    : `Change the pull request of ${section.name}`
                }
              />
            }
          >
            <LinkIcon />
          </PopoverTrigger>
          <PopoverPopup width="md" align="start" padding="compact">
            <PullRequestLinkForm
              section={section}
              project={project}
              onDone={() => setOpen(false)}
            />
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  );
}

function LinkedPullRequest({
  project,
  url,
  number,
}: {
  readonly project: EnvironmentProject;
  readonly url: string;
  readonly number: number | null;
}) {
  const visible = useDocumentVisible();
  const openPrLink = useOpenPrLink();
  // Null when the PR is outside this project's host or the server cannot read pull requests;
  // the link still works, it just shows no state.
  const target = usePullRequestPreviewTarget(project.environmentId, url);
  const summary = useEnvironmentQuery(
    visible && target !== null ? linkedPullRequestDetailAtom(target) : null,
  ).data;
  const checks =
    summary?.checksState == null ? null : pullRequestChecksStatePresentation(summary.checksState);
  return (
    <>
      {summary ? (
        <PullRequestStateGlyph
          state={summary.state}
          isDraft={summary.isDraft === true}
          className="size-3.5"
        />
      ) : (
        <PullRequestGlyph.pullRequest aria-hidden className="size-3.5 text-muted-foreground" />
      )}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 truncate font-medium hover:underline"
        onClick={(event) => openPrLink(event, url)}
      >
        {number === null ? "Pull request" : `#${number}`}
        {summary ? ` ${summary.title}` : ""}
      </a>
      {summary?.reviewDecision ? (
        <PullRequestReviewDecisionGlyph decision={summary.reviewDecision} />
      ) : null}
      {checks ? (
        <checks.Icon aria-label={checks.label} className={cn("size-3.5", checks.toneClassName)} />
      ) : null}
    </>
  );
}

function PullRequestLinkForm({
  section,
  project,
  onDone,
}: {
  readonly section: CommandCenterSection;
  readonly project: EnvironmentProject;
  readonly onDone: () => void;
}) {
  const { primaryEnvironmentId } = useCommandCenter();
  const setLink = useAtomCommand(
    serverEnvironment.setCommandCenterSectionPullRequest,
    "command center link pull request",
  );
  const [text, setText] = useState(section.prUrl ?? "");
  const [busy, setBusy] = useState(false);
  const parsed = pullRequestLinkFromInput(text);

  const save = async (link: { prUrl: string | null; prNumber: number | null }) => {
    setBusy(true);
    const result = await setLink({
      environmentId: primaryEnvironmentId,
      input: { id: section.id, ...link },
    });
    setBusy(false);
    if (result._tag === "Success") return onDone();
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not link the pull request",
        description: String(squashAtomCommandFailure(result)),
      });
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (parsed) void save(parsed);
  };

  return (
    <div className="flex flex-col gap-2">
      <form className="flex gap-2" onSubmit={submit}>
        <Input
          size="sm"
          autoFocus
          aria-label="Pull request URL"
          placeholder="Paste a pull request URL"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" size="xs" disabled={busy || parsed === null}>
          Link
        </Button>
      </form>
      <OpenPullRequests project={project} disabled={busy} onPick={(link) => void save(link)} />
      {section.prUrl ? (
        <Button
          size="xs"
          variant="ghost-destructive"
          disabled={busy}
          onClick={() => void save({ prUrl: null, prNumber: null })}
        >
          Unlink pull request
        </Button>
      ) : null}
    </div>
  );
}

/** The project's open pull requests, read (and cached) only while the link popover is open. */
function OpenPullRequests({
  project,
  disabled,
  onPick,
}: {
  readonly project: EnvironmentProject;
  readonly disabled: boolean;
  readonly onPick: (link: { prUrl: string; prNumber: number }) => void;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(project.environmentId));
  const supported = config?.environment.capabilities.pullRequests === true;
  const list = useEnvironmentQuery(
    supported
      ? pullRequestEnvironment.list({
          environmentId: project.environmentId,
          input: { state: "open", projectId: project.id, limit: 20 },
        })
      : null,
  );
  if (!supported) return null;
  const entries = list.data?.entries ?? [];
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">Open pull requests</span>
      {list.isPending && entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : list.error !== null && entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">Could not read them: {list.error}</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">None open in {project.title}.</p>
      ) : (
        <ul className="flex max-h-56 flex-col overflow-y-auto">
          {entries.map((entry) => (
            <li key={entry.url}>
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled}
                className="w-full justify-start"
                onClick={() => onPick({ prUrl: entry.url, prNumber: entry.number })}
              >
                <span className="shrink-0 tabular-nums text-muted-foreground">#{entry.number}</span>
                <span className="min-w-0 truncate">{entry.title}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
