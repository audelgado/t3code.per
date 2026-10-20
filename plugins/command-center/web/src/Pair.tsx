import { useEffect, useRef, useState } from "react";
import { call, connect } from "./api.ts";
import { Button } from "./ui/Button.tsx";
import { Field, Input } from "./ui/fields.tsx";

/** Consumes the single-use token from /pair#token=... (or a pasted one), then clears it from the URL. Renders without the shell. */
export function Pair() {
  const fromUrl = new URLSearchParams(location.hash.replace(/^#(pair\?)?/, "")).get("token");
  const [token, setToken] = useState(fromUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const auto = useRef(false);

  const submit = async (t: string) => {
    setBusy(true);
    setError(null);
    try {
      await call("POST /api/pair", { body: { token: t.trim() } });
      history.replaceState(null, "", "/#home");
      connect();
    } catch (e) {
      history.replaceState(null, "", "/pair#pair");
      setToken("");
      setError(e instanceof Error ? e.message : "No se pudo vincular");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (fromUrl && !auto.current) {
      auto.current = true; // StrictMode would otherwise spend the single-use token twice
      void submit(fromUrl);
    }
  }, []);

  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-5">
      <form
        className="grid w-full max-w-[400px] gap-3.5 rounded-card border border-line bg-panel p-6 md:p-[26px]"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(token);
        }}
      >
        <span aria-hidden className="grid size-10 place-items-center rounded-xl bg-fg text-sm font-bold text-white">
          CC
        </span>
        <div className="grid gap-1.5">
          <h1 className="text-xl">Vincula este dispositivo</h1>
          <p className="text-sm leading-normal text-muted-fg">
            Ejecuta <code>pair</code> en el servidor y abre el link que imprime, o pega el token aquí.
          </p>
        </div>
        <Field label="Token de vinculación">
          <Input className="font-mono" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
        </Field>
        {error && (
          <p role="alert" className="text-fail">
            {error}
          </p>
        )}
        <Button variant="primary" type="submit" className="h-10 md:h-10" disabled={busy || !token.trim()}>
          {busy ? "Vinculando…" : "Vincular"}
        </Button>
        <p className="text-xs text-muted-fg">La sesión queda abierta 180 días en este dispositivo.</p>
      </form>
    </main>
  );
}
