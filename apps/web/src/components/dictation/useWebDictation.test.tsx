import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useWebDictation } from "./useWebDictation";
import type { WebRecognition } from "./webDictation";

class FakeRecognition implements WebRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: WebRecognition["onresult"] = null;
  onerror: WebRecognition["onerror"] = null;
  onend: WebRecognition["onend"] = null;
  start = vi.fn();
  abort = vi.fn();
  stop = vi.fn();
  constructor() {
    FakeRecognition.instances.push(this);
  }
}

describe("dictation lifecycle", () => {
  const renderers: ReactTestRenderer[] = [];
  afterEach(async () => {
    await act(async () => {
      for (const renderer of renderers) renderer.unmount();
    });
    renderers.length = 0;
    FakeRecognition.instances = [];
    vi.unstubAllGlobals();
  });
  it("inserts all final segments once and releases the microphone on blur and unmount", async () => {
    const browser = Object.assign(new EventTarget(), { SpeechRecognition: FakeRecognition });
    vi.stubGlobal("window", browser);
    vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
    vi.stubGlobal("navigator", { language: "es-AR" });
    const onFinal = vi.fn();
    let state!: ReturnType<typeof useWebDictation>;
    function Probe() {
      const hook = useWebDictation(onFinal);
      useLayoutEffect(() => {
        state = hook;
      });
      return null;
    }
    await act(async () => {
      renderers.push(create(<Probe />));
    });
    await act(async () => state.start());
    const recognition = FakeRecognition.instances[0]!;
    expect(state.listening).toBe(true);
    expect(recognition.lang).toBe("es-AR");
    await act(async () =>
      recognition.onresult?.({
        resultIndex: 0,
        results: [
          { isFinal: true, 0: { transcript: "hello" } },
          { isFinal: true, 0: { transcript: "world" } },
          { isFinal: false, 0: { transcript: "next" } },
        ],
      }),
    );
    expect(onFinal.mock.calls).toEqual([["hello world"]]);
    expect(state.interim).toBe("next");
    await act(async () => browser.dispatchEvent(new Event("blur")));
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(state.listening).toBe(false);
    await act(async () => state.start());
    const next = FakeRecognition.instances[1]!;
    await act(async () => renderers[0]!.unmount());
    expect(next.abort).toHaveBeenCalledOnce();
  });
  it("stops the previous microphone when another input starts and stops on tab hide", async () => {
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), { SpeechRecognition: FakeRecognition }),
    );
    const page = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal("document", page);
    vi.stubGlobal("navigator", { language: "en-US" });
    const states: ReturnType<typeof useWebDictation>[] = [];
    function Probe({ index }: { index: number }) {
      const hook = useWebDictation(vi.fn());
      useLayoutEffect(() => {
        states[index] = hook;
      });
      return null;
    }
    await act(async () => {
      renderers.push(
        create(
          <>
            <Probe index={0} />
            <Probe index={1} />
          </>,
        ),
      );
    });
    await act(async () => states[0]!.start());
    await act(async () => states[1]!.start());
    expect(FakeRecognition.instances[0]!.abort).toHaveBeenCalledOnce();
    expect(states[0]!.listening).toBe(false);
    page.hidden = true;
    await act(async () => page.dispatchEvent(new Event("visibilitychange")));
    expect(states[1]!.listening).toBe(false);
    expect(FakeRecognition.instances[1]!.abort).toHaveBeenCalledOnce();
  });
});
