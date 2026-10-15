import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ThreadId, type CommandCenterThreadDigestsResult } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const calls = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("~/state/server", () => ({ serverEnvironment: { commandCenterThreadDigests: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => calls.read }));
import { digestKey, useThreadDigests } from "./useThreadDigests";

describe("visible thread summaries", () => {
  let renderer: ReactTestRenderer | null = null;
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    calls.read.mockReset();
  });
  const shell = (environment: string, id: string, runId = "run") =>
    ({
      environmentId: EnvironmentId.make(environment),
      id: ThreadId.make(id),
      latestRun: { runId },
    }) as EnvironmentThreadShell;
  const summary = (threadId: string, text: string): CommandCenterThreadDigestsResult => ({
    digests: [
      {
        threadId: ThreadId.make(threadId),
        text,
        runStatus: "completed",
        completedAt: null,
        files: 1,
        additions: 2,
        deletions: 0,
      },
    ],
  });
  it("keeps an in-flight summary when Show more changes the visible rows", async () => {
    const first = shell("pc", "a"),
      second = shell("pc", "b");
    const pending: Array<
      (value: { _tag: "Success"; value: CommandCenterThreadDigestsResult }) => void
    > = [];
    calls.read.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    let state!: ReturnType<typeof useThreadDigests>;
    function Probe({ items }: { items: EnvironmentThreadShell[] }) {
      const hook = useThreadDigests(items);
      useLayoutEffect(() => {
        state = hook;
      });
      return null;
    }
    await act(async () => {
      renderer = create(<Probe items={[first]} />);
    });
    await act(async () => renderer!.update(<Probe items={[first, second]} />));
    await act(async () => {
      pending[0]!({ _tag: "Success", value: summary("a", "First result") });
      pending[1]!({ _tag: "Success", value: summary("b", "Second result") });
    });
    expect(state.digests.get(digestKey(first.environmentId, first.id))?.text).toBe("First result");
    expect(state.digests.get(digestKey(second.environmentId, second.id))?.text).toBe(
      "Second result",
    );
    expect(calls.read).toHaveBeenCalledTimes(2);
  });
  it("separates machines and marks missing summaries as unavailable", async () => {
    const pc = shell("pc", "same"),
      vps = shell("vps", "same");
    calls.read.mockImplementation(async ({ environmentId }: { environmentId: string }) => ({
      _tag: "Success",
      value: environmentId === "pc" ? summary("same", "PC result") : { digests: [] },
    }));
    let state!: ReturnType<typeof useThreadDigests>;
    function Probe() {
      const hook = useThreadDigests([pc, vps]);
      useLayoutEffect(() => {
        state = hook;
      });
      return null;
    }
    await act(async () => {
      renderer = create(<Probe />);
    });
    expect(state.digests.get(digestKey(pc.environmentId, pc.id))?.text).toBe("PC result");
    expect(state.digests.has(digestKey(vps.environmentId, vps.id))).toBe(false);
    expect(state.loadedKeys.has(digestKey(vps.environmentId, vps.id))).toBe(true);
  });
});
