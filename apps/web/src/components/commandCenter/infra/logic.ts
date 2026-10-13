import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isTailnetHost,
} from "@t3tools/shared/hostClassification";
import * as Option from "effect/Option";

/** How this client reaches an environment, judged from its preferred route. */
export type InfraLinkType = "Local" | "LAN" | "Tailscale" | "T3 Connect" | "SSH" | "Internet";

function hostLinkType(url: string, tailscale: boolean): InfraLinkType {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "Internet";
  }
  if (isLocalLoopbackHost(host)) return "Local";
  if (tailscale || isTailnetHost(host)) return "Tailscale";
  return isPrivateNetworkHost(host) ? "LAN" : "Internet";
}

export function classifyLink(entry: Pick<ConnectionCatalogEntry, "target" | "profile">) {
  const profile = Option.getOrNull(entry.profile);
  switch (entry.target._tag) {
    case "RelayConnectionTarget":
      return "T3 Connect";
    case "SshConnectionTarget":
      return "SSH";
    case "PrimaryConnectionTarget":
      return hostLinkType(entry.target.httpBaseUrl, false);
    case "BearerConnectionTarget":
      return profile?._tag === "BearerConnectionProfile"
        ? hostLinkType(profile.httpBaseUrl, profile.network === "tailscale")
        : "Internet";
  }
}

/** Ring buffer append: keeps the newest `max` samples. */
export function pushSample(samples: ReadonlyArray<number>, value: number, max: number) {
  return samples.length < max ? [...samples, value] : [...samples.slice(1 - max), value];
}

/** SVG polyline points for a sparkline in a `width` x `height` box, scaled to the largest sample. */
export function sparklinePoints(samples: ReadonlyArray<number>, width: number, height: number) {
  if (samples.length < 2) return "";
  const top = Math.max(1, ...samples);
  const step = width / (samples.length - 1);
  return samples
    .map(
      (value, index) =>
        `${(index * step).toFixed(1)},${(height - (value / top) * height).toFixed(1)}`,
    )
    .join(" ");
}

/** Round-trip label: sub-millisecond loopback reads "<1 ms", not "0 ms". */
export function formatRoundTrip(ms: number) {
  return ms < 1 ? "<1 ms" : `${Math.round(ms)} ms`;
}
