import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { CommandCenterSnippetName, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../../../ui/button";
import { Spinner } from "../../../ui/spinner";
import { toastManager } from "../../../ui/toast";

const reportFailure =
  (title: string) =>
  <A, E>(result: AtomCommandResult<A, E>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title,
        description: String(squashAtomCommandFailure(result)),
      });
    }
    return result;
  };

/**
 * The project's shared snippets (`.t3/workflows/snippets`), which prompts pull in with
 * `{{snippet:name}}`. Delete moves one to the trash and offers Undo.
 */
export function SnippetsPanel({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const snippets = useEnvironmentQuery(
    serverEnvironment.commandCenterSnippets({ environmentId, input: { projectId } }),
  );
  const canWrite = useAtomValue(
    serverEnvironment.deleteCommandCenterSnippet.permissionAtom(environmentId),
  );
  const options = { reportFailure: false } as const;
  const remove = useAtomCommand(serverEnvironment.deleteCommandCenterSnippet, {
    ...options,
    label: "command center delete snippet",
  });
  const restore = useAtomCommand(serverEnvironment.restoreCommandCenterSnippet, {
    ...options,
    label: "command center restore snippet",
  });

  const deleteWithUndo = async (name: CommandCenterSnippetName) => {
    const input = { projectId, name };
    const result = await remove({ environmentId, input }).then(
      reportFailure("Could not delete the snippet"),
    );
    if (result._tag !== "Success") return;
    const id = toastManager.add({
      type: "info",
      title: `Deleted ${name}`,
      description: "Prompts that use it fail until you restore it or remove the reference.",
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(id);
          void restore({ environmentId, input }).then(
            reportFailure("Could not restore the snippet"),
          );
        },
      },
    });
  };

  const list = snippets.data?.snippets ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Snippets</h3>
        <span className="text-xs text-muted-foreground">
          Shared text for prompts, used as {"{{snippet:name}}"}.
        </span>
      </div>
      {snippets.error !== null ? (
        <p className="text-sm text-destructive-foreground">{snippets.error}</p>
      ) : snippets.data === null ? (
        <Spinner size="sm" tone="muted" />
      ) : list.length === 0 ? (
        <p className="rounded-xl border border-dashed py-8 text-center text-sm text-muted-foreground">
          No snippets yet. When several prompts share a paragraph, the editor offers to make it one.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {list.map((snippet) => (
            <li key={snippet.name} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{snippet.name}</span>
              <span className="text-xs text-muted-foreground">
                {snippet.chars} chars · {formatRelativeTimeLabel(snippet.updatedAt)}
              </span>
              {canWrite ? (
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label={`Delete ${snippet.name}`}
                  onClick={() => void deleteWithUndo(snippet.name)}
                >
                  <Trash2Icon />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
