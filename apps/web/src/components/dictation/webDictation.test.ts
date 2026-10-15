import { describe, expect, it } from "vite-plus/test";
import { dictationErrorMessage, insertAtCaret, supportsWebDictation } from "./webDictation";

describe("web dictation", () => {
  it("inserts at the caret and replaces selections with word boundaries", () => {
    expect(insertAtCaret("hello", 5, 5, "world")).toEqual({ value: "hello world", caret: 11 });
    expect(insertAtCaret("world", 0, 0, "hello")).toEqual({ value: "hello world", caret: 6 });
    expect(insertAtCaret("hello old world", 6, 9, "new")).toEqual({
      value: "hello new world",
      caret: 9,
    });
    expect(insertAtCaret("hello world", 5, 5, ",")).toEqual({ value: "hello, world", caret: 6 });
    expect(insertAtCaret("", 0, 0, "  hello  ")).toEqual({ value: "hello", caret: 5 });
  });
  it("requires recognition and a browser surface", () => {
    expect(supportsWebDictation(false, true)).toBe(true);
    expect(supportsWebDictation(true, true)).toBe(false);
    expect(supportsWebDictation(false, false)).toBe(false);
  });
  it("explains recognition errors and keeps user cancellation silent", () => {
    expect(dictationErrorMessage("not-allowed")).toContain("permission denied");
    expect(dictationErrorMessage("service-not-allowed")).toContain("permission denied");
    expect(dictationErrorMessage("network")).toContain("network");
    expect(dictationErrorMessage("audio-capture")).toContain("microphone");
    expect(dictationErrorMessage("no-speech")).toContain("Try again");
    expect(dictationErrorMessage("aborted")).toBeNull();
  });
});
