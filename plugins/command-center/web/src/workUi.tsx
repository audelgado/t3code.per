// Small pieces Hoy, Lista, Tablero and the detail share.
import { Fragment, type ReactNode } from "react";
import { projectColor, stageLabel, STAGES, TONES, type Tone } from "./look.ts";
import { cn } from "./ui/cn.ts";
import { ProjectDot } from "./ui/ProjectDot.tsx";

/** Git stage as seven dots: done in the project's colour, the current one ringed in the status tone. Static. */
export function Stepper({ stage, projectKey, tone }: { stage: number; projectKey: string; tone: Tone }) {
  const color = projectColor(projectKey);
  const cur = TONES[tone].fg;
  return (
    <span role="img" aria-label={`Etapa: ${stageLabel(stage)}`} className="inline-flex shrink-0 items-center">
      {STAGES.map((name, i) => (
        <Fragment key={name}>
          {i > 0 && <span aria-hidden className="block h-0.5 w-2 bg-line" style={i <= stage ? { background: color } : undefined} />}
          <span
            aria-hidden
            className="block size-[9px] rounded-full border-2 border-line bg-panel"
            style={i < stage ? { background: color, borderColor: color } : i === stage ? { borderColor: cur, boxShadow: `0 0 0 3px color-mix(in srgb, ${cur} 22%, transparent)` } : undefined}
          />
        </Fragment>
      ))}
    </span>
  );
}

/** Project colour square and name. */
export function ProjectTag({ projectKey, name, className }: { projectKey: string; name: string; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs text-tx2", className)}>
      <ProjectDot projectKey={projectKey} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** A failure next to the thing that failed. Never clears what the user typed. */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-ctl bg-fail-bg px-3 py-2 text-[13px] text-[#7f1d1d] break-words">
      {children}
    </p>
  );
}

/** Coloured section heading: dot, label and count. */
export function GroupHeader({ tone, label, count }: { tone: Tone; label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 border-b border-soft bg-[#faf9f7] px-4 py-1.5 text-[11.5px] font-semibold tracking-wide text-muted-fg uppercase md:px-5">
      <span aria-hidden className="size-2 rounded-full" style={{ background: TONES[tone].fg }} />
      {label} · {count}
    </div>
  );
}
