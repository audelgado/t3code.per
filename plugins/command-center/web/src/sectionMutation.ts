/** Ignore repeated submissions until the current mutation settles, including failures. */
export function createExclusiveAction() {
  let pending = false;
  return async (action: () => Promise<void>) => {
    if (pending) return;
    pending = true;
    try { await action(); } finally { pending = false; }
  };
}
