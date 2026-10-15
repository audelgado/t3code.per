import { PencilIcon, RocketIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { QuickAction } from "./customization";

/** DOM id of the Launch trigger, so Home's "More" can bring it into view before opening it. */
export const LAUNCH_TRIGGER_ID = "command-center-launch";

/**
 * Every quick action, from any tab. Controlled so Home's "More" can open it too; the edit item
 * leads to Settings, where actions are added, reordered and removed.
 */
export function LaunchMenu({
  actions,
  open,
  onOpenChange,
  onRun,
  onEdit,
}: {
  readonly actions: readonly QuickAction[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRun: (action: QuickAction) => void;
  readonly onEdit: () => void;
}) {
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              id={LAUNCH_TRIGGER_ID}
              render={<Button size="sm" variant="outline" aria-label="Launch" />}
            />
          }
        >
          <RocketIcon />
          <span className="max-lg:hidden">Launch</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">Quick actions</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end">
        {actions.map((action) => (
          <MenuItem key={action.id} onClick={() => onRun(action)}>
            <span className="max-w-64 truncate">{action.label}</span>
          </MenuItem>
        ))}
        {actions.length > 0 ? <MenuSeparator /> : null}
        <MenuItem onClick={onEdit}>
          <PencilIcon />
          {actions.length > 0 ? "Edit quick actions" : "Add quick action"}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
