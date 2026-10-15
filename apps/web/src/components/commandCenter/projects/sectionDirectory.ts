import type { CommandCenterSection, CommandCenterSectionStatus } from "@t3tools/contracts";
import { paginateCollection } from "../collectionPaging";

/** Filters the section directory while keeping an active edit visible and mounted. */
export function selectSectionPage({
  sections,
  search,
  status,
  page,
  editing,
}: {
  readonly sections: ReadonlyArray<CommandCenterSection>;
  readonly search: string;
  readonly status: CommandCenterSectionStatus | "all";
  readonly page: number;
  readonly editing: CommandCenterSection["id"] | "new" | null;
}) {
  const needle = search.trim().toLocaleLowerCase();
  const matching = sections.filter(
    (section) =>
      (status === "all" || section.status === status) &&
      (!needle ||
        [section.name, section.blocker, section.trying, ...section.missing].some((value) =>
          value?.toLocaleLowerCase().includes(needle),
        )),
  );
  const editingIndex = matching.findIndex((section) => section.id === editing);
  const directory = paginateCollection(
    matching,
    editingIndex >= 0 ? Math.floor(editingIndex / 10) + 1 : page,
    10,
  );
  const visible = [...directory.items];
  const edited = sections.find((section) => section.id === editing);
  if (edited && !visible.includes(edited)) visible.unshift(edited);
  return { ...directory, visible };
}
