// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's FileSystem has no statfs.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import type { HostDiskVolume, HostResourcesSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

export class HostResources extends Context.Service<
  HostResources,
  { readonly read: Effect.Effect<HostResourcesSnapshot> }
>()("t3/resourceTelemetry/HostResources") {}

function readCpu() {
  const cpus = NodeOS.cpus();
  const cpu = cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );
  return { ...cpu, count: cpus.length };
}

function darwinAvailableMemory(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1];
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1];
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1];
  if (!pageSize || !free || !inactive || !speculative) return null;
  // vm_stat subtracts speculative pages from its printed "Pages free" count.
  // Adding them here counts each reclaimable page once; purgeable pages overlap.
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize);
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null;
}

/**
 * Capacity of each volume under `paths` (home first): one `stat` per path to group by device,
 * one `statfs` per device. Missing, unreadable or stalled (network mount) paths are skipped.
 */
const PATH_TIMEOUT = "1 second";

export const sampleDisks = Effect.fn("HostResources.sampleDisks")(function* (
  home: string,
  projectRoots: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = [
    { path: home, home: true },
    ...projectRoots.map((path) => ({ path, home: false })),
  ];
  const devices = yield* Effect.forEach(
    paths,
    ({ path }) =>
      fs.stat(path).pipe(
        Effect.map((info) => info.dev),
        Effect.timeout(PATH_TIMEOUT),
        Effect.orElseSucceed(() => null),
      ),
    { concurrency: 8 },
  );
  const volumes = new Map<number, { path: string; home: boolean; projectCount: number }>();
  paths.forEach((entry, index) => {
    const device = devices[index];
    if (device == null) return;
    const volume = volumes.get(device);
    if (volume === undefined) {
      volumes.set(device, { path: entry.path, home: entry.home, projectCount: entry.home ? 0 : 1 });
    } else if (!entry.home) {
      volume.projectCount += 1;
    }
  });
  const sampled = yield* Effect.forEach(
    [...volumes.values()],
    (volume) =>
      Effect.tryPromise(() => NodeFSP.statfs(volume.path)).pipe(
        Effect.map((stats): HostDiskVolume => ({
          ...volume,
          availableBytes: stats.bavail * stats.bsize,
          totalBytes: stats.blocks * stats.bsize,
        })),
        Effect.timeout(PATH_TIMEOUT),
        Effect.orElseSucceed(() => null),
      ),
    { concurrency: 8 },
  );
  return sampled.flatMap((volume) => (volume !== null && volume.totalBytes > 0 ? [volume] : []));
});

const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectStore.ProjectStoreV2;

  // Disk capacity moves slowly, so it is sampled once a minute rather than with every CPU read.
  const diskCache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "disks") =>
      projects.list().pipe(
        Effect.map((rows) => rows.map((row) => row.workspaceRoot)),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
        Effect.flatMap((roots) => sampleDisks(config.baseDir, roots)),
        Effect.provideService(FileSystem.FileSystem, fs),
        // A stalled network mount must not hold up CPU and memory.
        Effect.timeout("2 seconds"),
        Effect.orElseSucceed((): ReadonlyArray<HostDiskVolume> => []),
      ),
    timeToLive: "60 seconds",
  });
  // Runs alongside the CPU window, so a cached read adds no latency to a sample.
  const disks = Cache.get(diskCache, "disks");

  const sample = Effect.fn("HostResources.sample")(function* () {
    const previousCpu = readCpu();
    // CPU counters need two readings; idle servers do no polling or process scans.
    const [, diskVolumes] = yield* Effect.all([Effect.sleep("200 millis"), disks], {
      concurrency: 2,
    });
    const cpu = readCpu();
    const totalDelta = cpu.total - previousCpu.total;
    const idleDelta = cpu.idle - previousCpu.idle;
    const cpuUtilization =
      previousCpu.count === cpu.count && totalDelta > 0 && idleDelta >= 0
        ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
        : null;
    const totalMemoryBytes = NodeOS.totalmem();
    // On Windows libuv returns GlobalMemoryStatusEx.ullAvailPhys, including standby memory.
    let availableMemoryBytes = NodeOS.freemem();
    if (platform === "linux") {
      const meminfo = yield* fs
        .readFileString("/proc/meminfo")
        .pipe(Effect.orElseSucceed(() => ""));
      const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
      if (available) availableMemoryBytes = Number(available) * 1024;
    } else if (platform === "darwin") {
      const output = yield* spawner
        .string(ChildProcess.make("/usr/bin/vm_stat", [], { stdin: "ignore", stderr: "ignore" }))
        .pipe(
          Effect.timeout("1 second"),
          Effect.orElseSucceed(() => ""),
        );
      availableMemoryBytes = darwinAvailableMemory(output) ?? availableMemoryBytes;
    }
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCount: cpu.count,
      availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, availableMemoryBytes)),
      totalMemoryBytes,
      disks: diskVolumes,
    };
  });

  // One server-lifetime cache deduplicates simultaneous requests from all sockets.
  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => sample(),
    timeToLive: "5 seconds",
  });
  return HostResources.of({ read: Cache.get(cache, "host") });
});

// The project store is a stateless SQL reader; the shared memo map reuses the server's instances.
export const layer = Layer.effect(HostResources, make()).pipe(
  Layer.provide(ProjectStore.layer),
  Layer.provide(SqlitePersistence.layerConfig),
);
