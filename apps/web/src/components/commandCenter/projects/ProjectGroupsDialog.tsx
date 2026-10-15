import { COMMAND_CENTER_MAX_PROJECT_GROUPS } from "@t3tools/contracts";
import { CheckIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useUpdatePrimarySettings } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { toastManager } from "../../ui/toast";
import { type ProjectEntry, type ProjectGroup, updateProjectEntries } from "./projectDirectory";

/** One group: rename saves on Enter, the check button or leaving the field, when valid. */
function GroupRow({
  group,
  count,
  nameError,
  onRename,
  onDelete,
}: {
  readonly group: ProjectGroup;
  readonly count: number;
  readonly nameError: (value: string, exceptId: string | null) => string | null;
  readonly onRename: (name: string) => void;
  readonly onDelete: () => void;
}) {
  const [value, setValue] = useState(group.name);
  const [savedName, setSavedName] = useState(group.name);
  if (savedName !== group.name) {
    setSavedName(group.name);
    setValue(group.name);
  }
  const trimmed = value.trim();
  const unchanged = trimmed === group.name;
  const error = unchanged ? null : nameError(trimmed, group.id);
  const save = () => {
    if (!unchanged && error === null) onRename(trimmed);
  };
  return (
    <li className="flex items-start gap-2 p-2">
      <form
        className="flex min-w-0 flex-1 items-start gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <Input
            size="sm"
            aria-label={`Name of ${group.name}`}
            aria-invalid={error !== null || undefined}
            maxLength={40}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onBlur={save}
          />
          {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
        </div>
        <Button
          type="submit"
          size="icon-sm"
          variant="ghost"
          disabled={unchanged || error !== null}
          aria-label={`Save name of ${group.name}`}
        >
          <CheckIcon />
        </Button>
      </form>
      <span className="shrink-0 pt-1.5 text-xs tabular-nums text-muted-foreground">
        {count} projects
      </span>
      <Button
        size="icon-sm"
        variant="ghost-destructive"
        aria-label={`Delete ${group.name}; its projects stay`}
        onClick={onDelete}
      >
        <Trash2Icon />
      </Button>
    </li>
  );
}

/** Creates, renames and deletes project groups. Deleting a group only ungroups its projects. */
export function ProjectGroupsDialog({
  open,
  onOpenChange,
  groups,
  entries,
  counts,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly groups: ReadonlyArray<ProjectGroup>;
  readonly entries: ReadonlyArray<ProjectEntry>;
  /** Projects in each group, by group id. */
  readonly counts: ReadonlyMap<string, number>;
}) {
  const updateSettings = useUpdatePrimarySettings();
  const [name, setName] = useState("");
  const nameError = (value: string, exceptId: string | null) =>
    value === ""
      ? "Enter a group name."
      : groups.some(
            (group) => group.id !== exceptId && group.name.toLowerCase() === value.toLowerCase(),
          )
        ? "A group with this name already exists."
        : null;
  const saveGroups = (projectGroups: ProjectGroup[]) =>
    updateSettings({ commandCenter: { projectGroups } });
  // Ungroups the members, then offers Undo, which writes back both arrays as they were. Pin or
  // group changes made while its toast is open are overwritten by Undo (accepted).
  const deleteGroup = (group: ProjectGroup) => {
    const previous = { projectGroups: [...groups], projects: [...entries] };
    updateSettings({
      commandCenter: {
        projectGroups: groups.filter((item) => item.id !== group.id),
        projects: updateProjectEntries(
          entries,
          entries.filter((entry) => entry.groupId === group.id).map((entry) => entry.key),
          { groupId: null },
        ),
      },
    });
    const toastId = toastManager.add({
      type: "info",
      title: `Deleted ${group.name}`,
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(toastId);
          updateSettings({ commandCenter: previous });
        },
      },
    });
  };
  const full = groups.length >= COMMAND_CENTER_MAX_PROJECT_GROUPS;
  const createError = name.trim() === "" ? null : nameError(name.trim(), null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Project groups</DialogTitle>
          <DialogDescription>
            Group chips filter the Projects directory. Select projects there to move them into a
            group. Deleting a group keeps its projects.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <form
              className="flex items-start gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const value = name.trim();
                if (full || nameError(value, null) !== null) return;
                saveGroups([...groups, { id: randomUUID(), name: value }]);
                setName("");
              }}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <Input
                  size="sm"
                  aria-label="New group name"
                  placeholder={full ? "Group limit reached" : "New group, such as Clients"}
                  maxLength={40}
                  disabled={full}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                {createError ? (
                  <p className="text-xs text-destructive-foreground">{createError}</p>
                ) : null}
              </div>
              <Button
                type="submit"
                size="sm"
                disabled={full || name.trim() === "" || createError !== null}
              >
                <PlusIcon />
                Create group
              </Button>
            </form>
            {groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">No groups yet.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {groups.map((group) => (
                  <GroupRow
                    key={group.id}
                    group={group}
                    count={counts.get(group.id) ?? 0}
                    nameError={nameError}
                    onRename={(value) =>
                      saveGroups(
                        groups.map((item) =>
                          item.id === group.id ? { ...item, name: value } : item,
                        ),
                      )
                    }
                    onDelete={() => deleteGroup(group)}
                  />
                ))}
              </ul>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button size="sm" variant="outline" />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
