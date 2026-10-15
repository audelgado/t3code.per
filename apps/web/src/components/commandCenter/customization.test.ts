import { describe, expect, it } from "vite-plus/test";
import { isHttpUrl, quickActionError, resolveCommandCenterSections } from "./customization";

describe("Command Center navigation customization", () => {
  it("preserves a custom order and slots missing tabs after their canonical predecessor", () => {
    const sections = resolveCommandCenterSections([
      { id: "finance", label: " Costs ", visible: true },
      { id: "team", label: "", visible: false },
      { id: "finance", label: "Duplicate", visible: false },
    ]);
    expect(sections.map((section) => section.id)).toEqual([
      "home",
      "work",
      "finance",
      "artifacts",
      "canvas",
      "workflows",
      "team",
      "projects",
      "infra",
    ]);
    expect(sections[2]?.label).toBe("Costs");
    expect(sections[6]).toEqual({ id: "team", label: "Team", visible: false });
  });

  it("shows Home first for a layout saved before Home existed", () => {
    const ids = [
      "workflows",
      "projects",
      "team",
      "infra",
      "finance",
      "artifacts",
      "canvas",
    ] as const;
    const saved = ids.map((id) => ({ id, label: "", visible: id !== "team" }));
    const sections = resolveCommandCenterSections(saved);
    expect(sections[0]).toEqual({ id: "home", label: "Home", visible: true });
    expect(sections[1]).toEqual({ id: "work", label: "Work", visible: true });
    expect(sections.slice(2).map((section) => section.id)).toEqual(saved.map((item) => item.id));
  });

  it("keeps navigation accessible when every stored section is hidden", () => {
    const defaults = resolveCommandCenterSections([]);
    expect(defaults.map((section) => section.id)[0]).toBe("home");
    const hidden = defaults.map((section) => ({ ...section, visible: false }));
    expect(
      resolveCommandCenterSections(hidden)
        .filter((section) => section.visible)
        .map((section) => section.id),
    ).toEqual(["home"]);
    expect(hidden.every((section) => !section.visible)).toBe(true);
  });

  it("rejects malformed or executable links and unknown sections", () => {
    for (const target of ["javascript:alert(1)", "file:///C:/secret", "https://", "not a url"]) {
      expect(quickActionError({ label: "Open", kind: "link", target })).not.toBeNull();
    }
    expect(
      quickActionError({ label: "Open", kind: "link", target: "https://example.com/path" }),
    ).toBeNull();
    expect(quickActionError({ label: "Open", kind: "section", target: "unknown" })).not.toBeNull();
    expect(quickActionError({ label: "Open", kind: "section", target: "workflows" })).toBeNull();
    expect(
      quickActionError({ label: "Plan", kind: "prompt", target: "Review my project" }),
    ).toBeNull();
    expect(quickActionError({ label: " ", kind: "prompt", target: "Review" })).not.toBeNull();
  });

  it("accepts app paths for link actions but never one that leaves the app", () => {
    for (const target of ["/usage", " /command?tab=finance ", "/"]) {
      expect(quickActionError({ label: "Open", kind: "link", target })).toBeNull();
    }
    for (const target of ["//evil.com", "/\\evil.com", "javascript:alert(1)", "usage"]) {
      expect(quickActionError({ label: "Open", kind: "link", target })).not.toBeNull();
    }
  });

  it("accepts only links the settings schema accepts", () => {
    for (const target of [
      "//evil.example",
      "http:example.com",
      "https://a b.com",
      "javascript:x",
    ]) {
      expect(isHttpUrl(target)).toBe(false);
    }
    expect(isHttpUrl(" http://localhost:3000/admin ")).toBe(true);
  });
});
