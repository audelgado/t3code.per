import { describe, expect, it } from "@effect/vitest";

import { pullRequestNumberFromUrl } from "./commandCenter.ts";

describe("pullRequestNumberFromUrl", () => {
  it("reads the number from GitHub, GitLab and Bitbucket links", () => {
    expect(pullRequestNumberFromUrl("https://github.com/acme/shop/pull/42")).toBe(42);
    expect(pullRequestNumberFromUrl("https://github.com/acme/shop/pull/42/files#diff")).toBe(42);
    expect(pullRequestNumberFromUrl("https://gitlab.com/acme/shop/-/merge_requests/7?tab=x")).toBe(
      7,
    );
    expect(
      pullRequestNumberFromUrl("https://bitbucket.org/acme/shop/pull-requests/3/overview"),
    ).toBe(3);
  });

  it("returns null when the link has no pull request number", () => {
    expect(pullRequestNumberFromUrl("https://github.com/acme/shop/pulls")).toBeNull();
    expect(pullRequestNumberFromUrl("https://github.com/acme/shop/pull/12abc")).toBeNull();
    expect(pullRequestNumberFromUrl("https://github.com/acme/shop/pull/0")).toBeNull();
  });
});
