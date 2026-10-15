import {
  GitBranchIcon,
  MessageSquarePlusIcon,
  NotebookPenIcon,
  RocketIcon,
  WorkflowIcon,
} from "lucide-react";
import { Button } from "../../ui/button";
import { Kbd } from "../../ui/kbd";
import type { QuickAction } from "../customization";
import { focusOrchestrator } from "../shared";

export function LaunchGrid({
  actions,
  onRun,
  onMore,
  onNewThread,
  onNewWork,
}: {
  readonly actions: readonly QuickAction[];
  readonly onRun: (action: QuickAction) => void;
  readonly onMore: () => void;
  readonly onNewThread: () => void;
  readonly onNewWork: () => void;
}) {
  const tiles = [
    { id: "thread", label: "New thread", key: "n", icon: MessageSquarePlusIcon, run: onNewThread },
    { id: "work", label: "New work", key: "w", icon: GitBranchIcon, run: onNewWork },
    { id: "plan", label: "Plan work", key: "p", icon: WorkflowIcon, run: focusOrchestrator },
    {
      id: "note",
      label: "Save note",
      key: "s",
      icon: NotebookPenIcon,
      run: () =>
        onRun({ id: "home-note", label: "Save note", kind: "prompt", target: "remember: " }),
    },
    ...actions.slice(0, 4).map((action, index) => ({
      id: action.id,
      label: action.label,
      key: ["a", "b", "c", "d"][index]!,
      icon: RocketIcon,
      run: () => onRun(action),
    })),
  ];
  return (
    <div className="space-y-2">
      <div
        className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2"
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.repeat
          )
            return;
          const tile = tiles.find((entry) => entry.key === event.key.toLowerCase());
          if (tile) {
            event.preventDefault();
            event.stopPropagation();
            tile.run();
          }
        }}
      >
        {tiles.map((tile) => (
          <button
            key={tile.id}
            type="button"
            onClick={tile.run}
            className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-card/40 p-3 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          >
            <tile.icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{tile.label}</span>
            <Kbd>{tile.key.toUpperCase()}</Kbd>
          </button>
        ))}
      </div>
      {actions.length > 4 ? (
        <Button size="xs" variant="ghost" onClick={onMore}>
          More ({actions.length - 4})
        </Button>
      ) : null}
    </div>
  );
}
