import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { classifyLink, formatRoundTrip, pushSample, sparklinePoints } from "./logic";

const environmentId = EnvironmentId.make("env");

const bearer = (httpBaseUrl: string, network?: "tailscale") => ({
  target: new BearerConnectionTarget({ environmentId, label: "Box", connectionId: "c" }),
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: "c",
      environmentId,
      label: "Box",
      httpBaseUrl,
      wsBaseUrl: httpBaseUrl.replace("http", "ws"),
      ...(network ? { network } : {}),
    }),
  ),
});

describe("classifyLink", () => {
  it("reads the route kind and host", () => {
    const primary = (url: string) => ({
      target: new PrimaryConnectionTarget({
        environmentId,
        label: "Here",
        httpBaseUrl: url,
        wsBaseUrl: url,
      }),
      profile: Option.none(),
    });
    expect(classifyLink(primary("http://localhost:3773"))).toBe("Local");
    expect(classifyLink(primary("http://192.168.1.20:3773"))).toBe("LAN");
    expect(
      classifyLink({
        target: new RelayConnectionTarget({ environmentId, label: "Relay" }),
        profile: Option.none(),
      }),
    ).toBe("T3 Connect");
    expect(classifyLink(bearer("https://box.tail1234.ts.net"))).toBe("Tailscale");
    expect(classifyLink(bearer("http://100.101.1.2:3773", "tailscale"))).toBe("Tailscale");
    expect(classifyLink(bearer("http://10.0.0.5:3773"))).toBe("LAN");
    expect(classifyLink(bearer("https://vps.example.com"))).toBe("Internet");
  });
});

describe("sparkline helpers", () => {
  it("keeps the newest samples and scales to the peak", () => {
    expect(pushSample([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
    expect(pushSample([1], 2, 3)).toEqual([1, 2]);
    expect(sparklinePoints([0, 50], 100, 10)).toBe("0.0,10.0 100.0,0.0");
    expect(sparklinePoints([5], 100, 10)).toBe("");
  });
});

describe("formatRoundTrip", () => {
  it("never shows a zero latency", () => {
    expect(formatRoundTrip(0)).toBe("<1 ms");
    expect(formatRoundTrip(42.4)).toBe("42 ms");
  });
});
