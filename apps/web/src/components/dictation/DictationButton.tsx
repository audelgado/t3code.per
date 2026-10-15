import { MicIcon, MicOffIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { useWebDictation } from "./useWebDictation";

export function DictationButton({ onText }: { readonly onText: (text: string) => void }) {
  const { supported, listening, interim, error, start, stop } = useWebDictation(onText);
  useEffect(() => {
    if (error?.startsWith("Microphone permission denied"))
      toastManager.add({ type: "error", title: error });
  }, [error]);
  if (!supported) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant={listening ? "secondary" : "ghost"}
              aria-pressed={listening}
              aria-label={listening ? "Stop dictation" : "Start dictation"}
              onPointerDown={(event) => event.preventDefault()}
              onClick={listening ? stop : start}
            />
          }
        >
          {listening ? <MicOffIcon /> : <MicIcon />}
        </TooltipTrigger>
        <TooltipPopup>
          {interim || "Dictate (speech is sent to the browser's recognition service)"}
        </TooltipPopup>
      </Tooltip>
      {error ? (
        <span role="status" className="max-w-48 text-xs text-destructive">
          {error}
        </span>
      ) : null}
      {listening ? (
        <span role="status" className="sr-only">
          {interim || "Listening"}
        </span>
      ) : null}
    </div>
  );
}
