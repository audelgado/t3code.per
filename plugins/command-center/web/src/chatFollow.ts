import { useEffect, useRef, useState } from "react";
import { isChatNearEnd } from "./chatScroll.ts";

/** Recuerda la posición anterior a la actualización para respetar la lectura del historial. */
export function useChatFollow(revision: unknown, scope: string, enabled = true) {
  const end = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const jump = () => { following.current = true; setAway(false); end.current?.scrollIntoView({ block: "nearest" }); };
  useEffect(() => {
    if (!enabled || !end.current) return;
    following.current = true;
    setAway(false);
    let container = end.current.parentElement;
    while (container && !/(auto|scroll)/.test(getComputedStyle(container).overflowY)) container = container.parentElement;
    const target = container ?? window;
    const measure = () => {
      if (!end.current) return;
      // El formulario puede estar después del historial; importa el final del chat, no el de la página.
      const viewportTop = container ? container.getBoundingClientRect().top + container.clientTop : 0;
      const viewportHeight = container?.clientHeight ?? innerHeight;
      const transcriptBottom = end.current.getBoundingClientRect().bottom - viewportTop;
      following.current = isChatNearEnd(0, viewportHeight, transcriptBottom);
      setAway(!following.current);
    };
    target.addEventListener("scroll", measure, { passive: true });
    return () => target.removeEventListener("scroll", measure);
  }, [scope, enabled]);
  useEffect(() => { if (enabled && following.current) end.current?.scrollIntoView({ block: "nearest" }); }, [revision, scope, enabled]);
  return { end, away, jump };
}
