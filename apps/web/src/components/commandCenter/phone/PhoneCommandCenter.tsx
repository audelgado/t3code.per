import {
  CheckCheckIcon,
  GitBranchIcon,
  HouseIcon,
  MoreHorizontalIcon,
  RouteIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { useCommandCenterAttention } from "../shared";
import type { CommandCenterTab } from "../tabs";
import { PhoneDone } from "./PhoneDone";
import { PhoneToday } from "./PhoneToday";

export type PhoneScreen = "today" | "done" | "work" | "route";
export function PhoneCommandCenter({
  screen,
  onScreenChange,
  askBar,
  work,
  route,
  sections,
  onOpenSection,
}: {
  readonly screen: PhoneScreen;
  readonly onScreenChange: (screen: PhoneScreen) => void;
  readonly askBar: ReactNode;
  readonly work: ReactNode;
  readonly route: ReactNode;
  readonly sections: ReadonlyArray<{ readonly id: CommandCenterTab; readonly label: string }>;
  readonly onOpenSection: (tab: CommandCenterTab) => void;
}) {
  const attention = useCommandCenterAttention();
  const nav = [
    {
      id: "today",
      label: `Today${attention.length ? ` · ${attention.length}` : ""}`,
      icon: HouseIcon,
    },
    { id: "done", label: "Done", icon: CheckCheckIcon },
    { id: "work", label: "Work", icon: GitBranchIcon },
    { id: "route", label: "Route", icon: RouteIcon },
  ] as const;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto py-4">
        {screen === "today" ? (
          <PhoneToday onDone={() => onScreenChange("done")} />
        ) : screen === "done" ? (
          <PhoneDone />
        ) : screen === "work" ? (
          work
        ) : (
          route
        )}
      </div>
      <div
        className="z-10 -mx-4 shrink-0 bg-background"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {askBar}
        <nav
          className="flex items-center justify-around border-t px-1 py-2"
          aria-label="Command Center phone screens"
        >
          {nav.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={cn(
                "flex h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg text-xs focus-visible:outline-2 focus-visible:outline-ring",
                screen === id
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
              aria-current={screen === id ? "page" : undefined}
              onClick={() => onScreenChange(id)}
            >
              <Icon className="size-4" />
              <span className="max-w-full truncate">{label}</span>
            </button>
          ))}
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  className="flex h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label="More sections"
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
              <span>More</span>
            </MenuTrigger>
            <MenuPopup>
              {sections
                .filter((section) => section.id !== "home" && section.id !== "work")
                .map((section) => (
                  <MenuItem key={section.id} onClick={() => onOpenSection(section.id)}>
                    {section.label}
                  </MenuItem>
                ))}
            </MenuPopup>
          </Menu>
        </nav>
      </div>
    </div>
  );
}
