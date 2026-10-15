import { cn } from "~/lib/utils";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { COMMAND_CENTER_SECTION_INFO } from "./customization";
import type { CommandCenterTab } from "./tabs";

/**
 * One tab per visible section: below `lg` only the open tab keeps its label (tooltips are
 * mouse-only, so touch screens never see them), and the description sits in a tooltip. The
 * strip scrolls sideways instead of wrapping.
 */
export function SectionNavigation({
  sections,
  active,
  onChange,
  badges,
}: {
  readonly sections: readonly { id: CommandCenterTab; label: string }[];
  readonly active: CommandCenterTab;
  readonly onChange: (tab: CommandCenterTab) => void;
  readonly badges?: Partial<Record<CommandCenterTab, number>>;
}) {
  return (
    <nav aria-label="Command Center sections" className="min-w-0 overflow-x-auto">
      <ToggleGroup
        variant="segmented"
        aria-label="Command Center view"
        value={[active]}
        onValueChange={(values) => {
          const section = sections.find((item) => item.id === values[0]);
          if (section) onChange(section.id);
        }}
      >
        {sections.map((section) => {
          const info = COMMAND_CENTER_SECTION_INFO[section.id];
          const Icon = info.icon;
          return (
            <Tooltip key={section.id}>
              <TooltipTrigger render={<Toggle value={section.id} aria-label={section.label} />}>
                <Icon aria-hidden="true" />
                <span className={cn("max-w-32 truncate", section.id !== active && "max-lg:hidden")}>
                  {section.label}
                </span>
                {(badges?.[section.id] ?? 0) > 0 ? (
                  <span className="text-xs tabular-nums">{badges?.[section.id]}</span>
                ) : null}
              </TooltipTrigger>
              <TooltipPopup side="bottom" className="max-w-64">
                <p className="font-medium">{section.label}</p>
                <p>{info.description}</p>
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </ToggleGroup>
    </nav>
  );
}
