import { projectColor } from "../look.ts";
import { cn } from "./cn.ts";

/** Small rounded square in the project's stable colour. `projectKey` is "<machineId>:<projectId>". */
export function ProjectDot({ projectKey, className }: { projectKey: string; className?: string }) {
  return <span aria-hidden style={{ background: projectColor(projectKey) }} className={cn("inline-block size-2.5 shrink-0 rounded-[3px]", className)} />;
}

/** Initials tile in the project's colour (project headers, cards). */
export function Avatar({ name, projectKey, className }: { name: string; projectKey: string; className?: string }) {
  const initials = name.split(/[\s\-_/]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  return (
    <span aria-hidden style={{ background: projectColor(projectKey) }} className={cn("inline-grid size-10 shrink-0 place-items-center rounded-xl text-sm font-bold text-white", className)}>
      {initials}
    </span>
  );
}
