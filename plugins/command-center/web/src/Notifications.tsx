import { useEffect, useState } from "react";
import { disablePush, enablePush, pushState, testPush, type PushState } from "./push.ts";
import { Button } from "./ui/Button.tsx";
import { Chip } from "./ui/Chip.tsx";
import { Panel } from "./ui/Panel.tsx";
import type { Tone } from "./look.ts";

const STATE: Record<PushState, { label: string; tone: Tone }> = {
  unsupported: { label: "No disponible", tone: "queue" },
  denied: { label: "Bloqueadas", tone: "fail" },
  off: { label: "Desactivadas", tone: "queue" },
  on: { label: "Activadas", tone: "ok" },
};

/** Flota / Notificaciones: avisos push de este dispositivo. The server keeps no history, so there is no inbox. */
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
      setNote({ text: e instanceof Error ? e.message : "Algo salió mal", bad: true });
    } finally {
      setBusy(false);
    }
  };
  const enable = run(async () => (setState(await enablePush()), null));
  const disable = run(async () => (setState(await disablePush()), "Las notificaciones están desactivadas en este dispositivo."));
  const test = run(async () => {
    const { sent } = await testPush();
    return sent > 0 ? `Enviada a ${sent} ${sent === 1 ? "dispositivo" : "dispositivos"}.` : "Ningún dispositivo la recibió. Desactivá las notificaciones y volvé a activarlas.";
  });

  return (
    <div className="max-w-xl">
      <Panel title="Este dispositivo" action={state && <Chip tone={STATE[state].tone}>{STATE[state].label}</Chip>}>
        <p className="px-4 py-3 text-sm text-muted-fg">
          Tus tareas del Command Center: aprobaciones, preguntas, tareas terminadas o fallidas y alertas de máquinas. Los demás hilos de T3 avisan por T3 Connect desde la app de T3.
          {" "}Los avisos de todas tus máquinas llegan a este dispositivo. Para elegir dónde ejecutar una tarea, usa Sistema en Pedir.
        </p>
        {state === "unsupported" && (
          <p className="px-4 py-3 text-sm text-need">Este navegador no puede recibir notificaciones. En iPhone, agrega el Command Center a la pantalla de inicio y abrilo desde ahí.</p>
        )}
        {state === "denied" && <p className="px-4 py-3 text-sm text-need">Las notificaciones están bloqueadas. Permitilas en los ajustes del sistema para esta app.</p>}
        {(state === "off" || state === "on") && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            {state === "off" ? (
              <Button variant="primary" disabled={busy} onClick={enable}>
                {busy ? "Activando…" : "Activar"}
              </Button>
            ) : (
              <>
                <Button disabled={busy} onClick={test}>
                  Enviar prueba
                </Button>
                <Button variant="danger" disabled={busy} onClick={disable}>
                  Desactivar
                </Button>
              </>
            )}
          </div>
        )}
        {note && (
          <p role={note.bad ? "alert" : "status"} className={note.bad ? "px-4 py-3 text-sm text-fail" : "px-4 py-3 text-sm text-muted-fg"}>
            {note.text}
          </p>
        )}
      </Panel>
    </div>
  );
}
