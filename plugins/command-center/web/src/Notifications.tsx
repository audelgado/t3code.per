import { useEffect, useState } from "react";
import { disablePush, enablePush, pushState, testPush, type PushState } from "./push.ts";
import { Button } from "./ui/Button.tsx";
import { Badge, Card } from "./ui/fields.tsx";

const label: Record<PushState, string> = { unsupported: "not available", denied: "blocked", off: "off", on: "on" };

export function Notifications() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  useEffect(() => {
    pushState().then(setState, () => setState("unsupported"));
  }, []);

  const run = (fn: () => Promise<string | null>) => async () => {
    setBusy(true);
    setNote(null);
    try {
      const text = await fn();
      if (text) setNote({ text, bad: false });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : "Something went wrong", bad: true });
    } finally {
      setBusy(false);
    }
  };
  const enable = run(async () => (setState(await enablePush()), null));
  const disable = run(async () => (setState(await disablePush()), "Notifications are off on this device."));
  const test = run(async () => {
    const { sent } = await testPush();
    return sent > 0 ? `Sent to ${sent} device${sent === 1 ? "" : "s"}.` : "No device received it. Turn notifications off and on again.";
  });

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Notifications</h1>
      <Card className="grid gap-3">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 font-medium">This device</span>
          {state && <Badge>{label[state]}</Badge>}
        </div>
        <p className="text-muted-fg">
          Your Command Center tasks: approvals, questions, finished and failed tasks, and machine alerts. Other T3 threads
          notify through T3 Connect in the T3 app.
        </p>
        {state === "unsupported" && (
          <p className="text-warn">
            This browser cannot receive notifications. On iPhone, add the Command Center to the Home Screen and open it from
            there.
          </p>
        )}
        {state === "denied" && <p className="text-warn">Notifications are blocked. Allow them in the system settings for this app.</p>}
        {state === "off" && (
          <Button variant="primary" disabled={busy} onClick={enable}>
            {busy ? "Turning on..." : "Turn on"}
          </Button>
        )}
        {state === "on" && (
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy} onClick={test}>
              Send test
            </Button>
            <Button variant="danger" disabled={busy} onClick={disable}>
              Turn off
            </Button>
          </div>
        )}
        {note && (
          <p role={note.bad ? "alert" : "status"} className={note.bad ? "text-bad" : "text-muted-fg"}>
            {note.text}
          </p>
        )}
      </Card>
    </div>
  );
}
