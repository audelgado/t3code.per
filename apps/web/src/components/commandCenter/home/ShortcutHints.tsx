import { Kbd } from "../../ui/kbd";
export function ShortcutHints() {
  return (
    <div className="hidden flex-wrap justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground sm:flex">
      {[
        ["/", "ask the team"],
        ["1-8", "open pinned"],
        ["[ ]", "rotate work"],
        ["w", "new work"],
        ["g w", "work"],
      ].map(([key, label]) => (
        <span key={key} className="inline-flex items-center gap-1.5">
          <Kbd>{key}</Kbd>
          {label}
        </span>
      ))}
    </div>
  );
}
