import { useSyncExternalStore } from "react";

const query = "(max-width: 767px)";

/** True below the 768px breakpoint. CSS (`md:`) is preferred; use this only when the markup itself differs. */
export const useIsPhone = () =>
  useSyncExternalStore(
    (f) => {
      const m = matchMedia(query);
      m.addEventListener("change", f);
      return () => m.removeEventListener("change", f);
    },
    () => matchMedia(query).matches,
  );
