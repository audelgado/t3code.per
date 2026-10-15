import type { CommandCenterTab } from "./tabs";

const CHORD_TABS: Readonly<Record<string, CommandCenterTab>> = {
  h: "home",
  w: "work",
  p: "projects",
  t: "team",
  i: "infra",
  f: "finance",
  a: "artifacts",
  c: "canvas",
  o: "workflows",
};

/** Event timestamps bound the chord without starting a timer or reserving Home's digits. */
export function resolvePageKey(
  key: string,
  at: number,
  chordAt: number | null,
  current: CommandCenterTab,
): { readonly chordAt: number | null; readonly tab?: CommandCenterTab } {
  if (key === "g") return { chordAt: at };
  if (chordAt !== null && at >= chordAt && at - chordAt <= 1500) {
    const tab = CHORD_TABS[key];
    return { chordAt: null, ...(tab ? { tab } : {}) };
  }
  if ((key === "[" || key === "]") && current !== "work") return { chordAt: null, tab: "work" };
  return { chordAt: null };
}
