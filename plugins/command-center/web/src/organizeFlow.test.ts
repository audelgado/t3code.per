import assert from "node:assert/strict";
import test from "node:test";
import type { Coordinator, OrganizeJob } from "../../server/organize.ts";
import { draftSteps, pickCoordinator, pollJob } from "./organizeFlow.ts";

const coord = (id: Coordinator["id"], available: boolean): Coordinator => ({ id, label: id, available, reason: available ? null : "no" });
const job = (status: OrganizeJob["status"]): OrganizeJob => ({ id: "j", coordinator: "claude", status, draft: null, error: null, createdAt: "" });
const instant = { sleep: async () => {}, intervalMs: 1 };

test("pickCoordinator keeps the remembered choice only while it is available", () => {
  const list = [coord("claude", true), coord("codex", false), coord("hermes", true)];
  assert.equal(pickCoordinator(list, "hermes"), "hermes");
  assert.equal(pickCoordinator(list, "codex"), "claude");
  assert.equal(pickCoordinator(list, null), "claude");
  assert.equal(pickCoordinator([coord("claude", false)], "claude"), null);
});

test("draftSteps only offers a split of two or more steps", () => {
  const d = { title: "t", prompt: "p", projectKey: null, priority: 0, profileId: null, questions: [] };
  assert.deepEqual(draftSteps({ ...d, steps: [{ title: "a", prompt: "A" }] }), []);
  assert.deepEqual(draftSteps({ ...d, steps: [{ title: "a", prompt: "A" }, { title: "b", prompt: "B" }] }), ["A", "B"]);
});

test("pollJob returns the settled job", async () => {
  const seq = [job("running"), job("done")];
  const out = await pollJob(job("running"), async () => seq.shift()!, { signal: new AbortController().signal, ...instant });
  assert.equal(out.status, "done");
});

test("pollJob tolerates two failed reads but not three", async () => {
  let n = 0;
  const flaky = async () => (++n < 3 ? Promise.reject(new Error("red")) : job("done"));
  assert.equal((await pollJob(job("running"), flaky, { signal: new AbortController().signal, ...instant })).status, "done");
  await assert.rejects(pollJob(job("running"), () => Promise.reject(new Error("red")), { signal: new AbortController().signal, ...instant }), /red/);
});

test("pollJob gives up after the deadline and stops on abort", async () => {
  let t = 0;
  await assert.rejects(
    pollJob(job("running"), async () => job("running"), { signal: new AbortController().signal, sleep: async () => void (t += 1000), now: () => t, giveUpMs: 3000 }),
    /tardó demasiado/,
  );
  const c = new AbortController();
  await assert.rejects(pollJob(job("running"), async () => job("running"), { signal: c.signal, sleep: async () => c.abort() }), { name: "AbortError" });
});
