import { useEffect, useRef, useState } from "react";
import { call, connect } from "./api.ts";
import { Button } from "./ui/Button.tsx";
import { Input } from "./ui/fields.tsx";

/** Consumes the single-use token from /pair#token=... (or a pasted one), then clears it from the URL. */
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
      setError(e instanceof Error ? e.message : "Pairing failed");
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
    <main className="mx-auto grid max-w-sm gap-4 px-4 pt-[max(4rem,env(safe-area-inset-top))]">
      <h1 className="text-xl font-semibold">Pair this device</h1>
      <p className="text-muted-fg">
        Run <code>pair</code> on the server and open the link it prints, or paste the token here.
      </p>
      <Input
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="Pairing token"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      {error && (
        <p role="alert" className="text-bad">
          {error}
        </p>
      )}
      <Button variant="primary" disabled={busy || !token.trim()} onClick={() => void submit(token)}>
        {busy ? "Pairing..." : "Pair"}
      </Button>
    </main>
  );
}
