import { LegendList, type LegendListRef } from "@legendapp/list/react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ProjectId } from "@t3tools/contracts";
import { ChevronsUpDownIcon, CrosshairIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { pinnedFirst } from "./projects/projectDirectory";
import { useCommandCenter, useCommandCenterEnvironments } from "./shared";

const EMPTY_PROJECT = "__command_center_all_projects__";

function normalizeSearch(value: string) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/** Search the complete project catalog, pinned projects first, while rendering only visible options. */
export function ProjectPicker({
  projects,
  value,
  onValueChange,
  nullableLabel = "All projects",
  placeholder = "Select project",
  ariaLabel = "Project",
  searchPlaceholder = "Search projects…",
  allowEmpty = true,
  compact = false,
}: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly value: ProjectId | null;
  readonly onValueChange: (value: ProjectId | null) => void;
  readonly nullableLabel?: string;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly searchPlaceholder?: string;
  readonly allowEmpty?: boolean;
  /** Below `sm` the trigger shows only an icon, for the page's one-row header. */
  readonly compact?: boolean;
}) {
  const environments = useCommandCenterEnvironments();
  const entries = usePrimarySettings((settings) => settings.commandCenter.projects);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const listRef = useRef<LegendListRef | null>(null);
  const highlightedValueRef = useRef<string | null>(null);
  const options = useMemo(() => {
    const environmentLabels = new Map(
      environments.map((environment) => {
        const duplicateLabel = environments.some(
          (other) =>
            other.environmentId !== environment.environmentId && other.label === environment.label,
        );
        return [
          environment.environmentId,
          duplicateLabel
            ? `${environment.label} · ${environment.environmentId}`
            : environment.label,
        ];
      }),
    );
    return new Map(
      pinnedFirst(projects, entries).map((project) => [
        project.id as string,
        {
          project,
          environment: environmentLabels.get(project.environmentId) ?? project.environmentId,
        },
      ]),
    );
  }, [projects, environments, entries]);
  const selected = value === null ? undefined : options.get(value);
  const unavailable = value !== null && selected === undefined;
  const canClear = allowEmpty || unavailable;
  const emptyLabel = allowEmpty ? nullableLabel : "Clear unavailable project";
  const items = useMemo(
    () => (canClear ? [EMPTY_PROJECT, ...options.keys()] : [...options.keys()]),
    [canClear, options],
  );
  const filteredItems = useMemo(() => {
    const search = normalizeSearch(query.trim());
    if (!search) return items;
    return items.filter((id) => {
      if (id === EMPTY_PROJECT) return normalizeSearch(emptyLabel).includes(search);
      const option = options.get(id);
      return (
        option !== undefined &&
        normalizeSearch(
          `${option.project.title} ${option.project.workspaceRoot} ${option.environment}`,
        ).includes(search)
      );
    });
  }, [items, emptyLabel, options, query]);
  const selectItem = (id: string | null) => {
    if (id === EMPTY_PROJECT && canClear) onValueChange(null);
    else if (id !== null) {
      const option = options.get(id);
      if (option) onValueChange(option.project.id);
    }
    setOpen(false);
    setQuery("");
    highlightedValueRef.current = null;
  };

  return (
    <Combobox
      items={items}
      filteredItems={filteredItems}
      virtualized
      autoHighlight
      open={open}
      value={value ?? (allowEmpty ? EMPTY_PROJECT : null)}
      itemToStringLabel={(id) => {
        const option = options.get(id);
        return option ? `${option.project.title} · ${option.environment}` : emptyLabel;
      }}
      onValueChange={selectItem}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        setQuery("");
        if (!nextOpen) highlightedValueRef.current = null;
      }}
      onItemHighlighted={(id, details) => {
        highlightedValueRef.current = id ?? null;
        if (details.reason === "keyboard" && details.index >= 0) {
          void listRef.current?.scrollIndexIntoView({ index: details.index, animated: false });
        }
      }}
    >
      <ComboboxTrigger
        render={<Button type="button" variant="outline" size="sm" />}
        aria-label={ariaLabel}
      >
        {compact ? <CrosshairIcon aria-hidden="true" /> : null}
        <span className={compact ? "max-w-40 truncate max-sm:hidden" : "max-w-52 truncate"}>
          {selected
            ? `${selected.project.title} · ${selected.environment}`
            : unavailable
              ? "Project unavailable"
              : value === null && allowEmpty
                ? nullableLabel
                : placeholder}
        </span>
        <ChevronsUpDownIcon aria-hidden="true" />
      </ComboboxTrigger>
      <ComboboxPopup>
        <ComboboxSearchInput
          aria-label={searchPlaceholder}
          placeholder={searchPlaceholder}
          value={query}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229)
              return;
            event.preventDefault();
            event.stopPropagation();
            const highlighted = highlightedValueRef.current;
            if (highlighted === null || !filteredItems.includes(highlighted)) return;
            (
              event as typeof event & { preventBaseUIHandler?: () => void }
            ).preventBaseUIHandler?.();
            selectItem(highlighted);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            void listRef.current?.scrollToOffset({ offset: 0, animated: false });
          }}
        />
        <ComboboxEmpty>No projects found.</ComboboxEmpty>
        <div className="h-64 max-h-(--available-height) min-h-0 w-80 max-w-full overflow-hidden">
          <ComboboxListVirtualized>
            <LegendList
              ref={listRef}
              data={filteredItems}
              keyExtractor={(id) => id}
              estimatedItemSize={48}
              drawDistance={240}
              className="h-full overflow-x-hidden overscroll-y-contain"
              renderItem={({ item: id, index }) => {
                const option = options.get(id);
                return (
                  <ComboboxItem value={id} index={index}>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{option?.project.title ?? emptyLabel}</span>
                      {option ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {option.environment} · {option.project.workspaceRoot}
                        </span>
                      ) : null}
                    </div>
                  </ComboboxItem>
                );
              }}
            />
          </ComboboxListVirtualized>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}

/** Empty state of a one-project tab (Canvas, a workflow library): a line and a focus picker. */
export function FocusPrompt({ text }: { readonly text: string }) {
  const { projects, projectId, setProjectFocus } = useCommandCenter();
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <p className="text-sm text-muted-foreground">{text}</p>
      <ProjectPicker
        projects={projects}
        value={projectId}
        onValueChange={setProjectFocus}
        allowEmpty={false}
        placeholder="Choose a project"
        ariaLabel="Project focus"
      />
    </div>
  );
}
