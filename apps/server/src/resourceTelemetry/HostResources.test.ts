import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { sampleDisks } from "./HostResources.ts";

describe("sampleDisks", () => {
  it.effect("groups the home and project roots by volume and skips missing paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-disk-home-" });
      const projectA = path.join(home, "a");
      const projectB = path.join(home, "b");
      yield* fs.makeDirectory(projectA);
      yield* fs.makeDirectory(projectB);

      const disks = yield* sampleDisks(home, [projectA, projectB, path.join(home, "missing")]);

      expect(disks).toHaveLength(1);
      const [volume] = disks;
      expect(volume).toMatchObject({ path: home, home: true, projectCount: 2 });
      expect(volume!.totalBytes).toBeGreaterThan(0);
      expect(volume!.availableBytes).toBeGreaterThanOrEqual(0);
      expect(volume!.availableBytes).toBeLessThanOrEqual(volume!.totalBytes);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns nothing when no path exists", () =>
    Effect.gen(function* () {
      expect(yield* sampleDisks("/definitely/not/a/t3/home", [])).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
