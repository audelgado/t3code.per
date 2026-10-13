import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Duration from "effect/Duration";

import * as ProcessRunner from "../processRunner.ts";

// Zero-token repository pre-scan for onboarding (docs/command-center/SPEC.md "Onboarding
// team"). Every probe is bounded and optional: a missing tool or a slow command drops its
// section instead of failing the digest.

/** Text that marks a memory note as a repo digest. */
export const REPO_DIGEST_PREFIX = "Repo digest";
const MAX_DIGEST_CHARS = 8_000;
const MAX_WALK_FILES = 3_000;
const MAX_TODO_LINES = 30;
/** Few enough files that onboarding should interview first and skip the Scout. */
const NEW_REPO_MAX_FILES = 10;

const SKIPPED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  "__pycache__",
  "venv",
]);

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rs: "Rust",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  cpp: "C++",
  cc: "C++",
  c: "C",
  h: "C",
  dart: "Dart",
  vue: "Vue",
  svelte: "Svelte",
  css: "CSS",
  scss: "CSS",
  html: "HTML",
  sql: "SQL",
  sh: "Shell",
  ps1: "PowerShell",
  md: "Markdown",
};

const MANIFESTS = [
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "Dockerfile",
  "docker-compose.yml",
  "t3.json",
];

const decodePackageJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      packageManager: Schema.optional(Schema.String),
      scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
);
const decodeIssues = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ number: Schema.Number, title: Schema.String })),
  ),
);

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Directory tree two levels deep with file counts, largest first. */
export function summarizeTree(files: ReadonlyArray<string>): string {
  const topFiles: Array<string> = [];
  const dirs = new Map<string, { count: number; children: Map<string, number> }>();
  for (const file of files) {
    const [top, second, ...rest] = file.split("/");
    if (top === undefined) continue;
    if (second === undefined) {
      topFiles.push(top);
      continue;
    }
    const dir = dirs.get(top) ?? { count: 0, children: new Map() };
    dir.count += 1;
    if (rest.length > 0) dir.children.set(second, (dir.children.get(second) ?? 0) + 1);
    dirs.set(top, dir);
  }
  const lines = [...dirs.entries()]
    .toSorted(([, a], [, b]) => b.count - a.count)
    .slice(0, 20)
    .flatMap(([name, dir]) => [
      `${name}/ (${dir.count})`,
      ...[...dir.children.entries()]
        .toSorted(([, a], [, b]) => b - a)
        .slice(0, 6)
        .map(([child, count]) => `  ${child}/ (${count})`),
    ]);
  if (topFiles.length > 0) lines.push(`files: ${topFiles.slice(0, 25).join(", ")}`);
  return lines.join("\n");
}

export function summarizeLanguages(files: ReadonlyArray<string>): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const extension = /\.([^./]+)$/.exec(file)?.[1]?.toLowerCase();
    const language = extension === undefined ? undefined : LANGUAGES[extension];
    if (language !== undefined) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()]
    .toSorted(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([language, count]) => `${language} ${count}`)
    .join(", ");
}

/** Breadth-first listing for folders git does not manage, skipping dependency and build dirs. */
const walk = Effect.fn("CommandCenter.walkRepo")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
) {
  const files: Array<string> = [];
  const queue = [""];
  while (queue.length > 0 && files.length < MAX_WALK_FILES) {
    const relative = queue.shift() ?? "";
    const names = yield* fs
      .readDirectory(path.join(root, relative))
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const name of names) {
      if (name.startsWith(".") || SKIPPED_DIRS.has(name)) continue;
      const child = relative === "" ? name : `${relative}/${name}`;
      const info = yield* fs.stat(path.join(root, child)).pipe(Effect.option);
      if (info._tag === "None") continue;
      if (info.value.type === "Directory") queue.push(child);
      else if (info.value.type === "File") files.push(child);
    }
  }
  return files;
});

export const collectRepoDigest = Effect.fn("CommandCenter.collectRepoDigest")(function* (
  root: string,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** Stdout of a successful, timely run; null for anything else. */
  const run = (
    command: string,
    args: ReadonlyArray<string>,
    timeout: Duration.Input = "5 seconds",
  ) =>
    runner
      .run({
        command,
        args,
        cwd: root,
        timeout,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 256 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((output) => (output.code === 0 && !output.timedOut ? output.stdout : null)),
        Effect.orElseSucceed(() => null),
      );
  const read = (file: string) =>
    fs.readFileString(path.join(root, file)).pipe(Effect.orElseSucceed(() => null));
  const lines = (text: string | null) =>
    text === null ? [] : text.split(/\r?\n/).filter((line) => line.trim() !== "");

  // Git knows what is ignored; a folder that is not a repo yet gets a bounded walk.
  const tracked = yield* run("git", ["ls-files", "--cached", "--others", "--exclude-standard"]);
  const isGit = tracked !== null;
  const files = isGit ? lines(tracked) : yield* walk(fs, path, root);

  const sections: Array<string> = [];
  const add = (title: string, body: string, max = 1_500) => {
    if (body.trim() !== "") sections.push(`## ${title}\n${clip(body, max)}`);
  };

  add("Tree", summarizeTree(files), 2_000);
  add("Languages", summarizeLanguages(files));

  const manifests: Array<string> = [];
  const packageJson = yield* read("package.json");
  if (packageJson !== null) {
    const parsed = decodePackageJson(packageJson);
    if (parsed._tag === "None") manifests.push("package.json (unreadable)");
    else {
      const { name, packageManager, scripts = {} } = parsed.value;
      manifests.push(
        ["package.json", name && `(${name})`, packageManager].filter(Boolean).join(" "),
        ...Object.entries(scripts)
          .slice(0, 15)
          .map(([script, command]) => `  ${script}: ${clip(command, 80)}`),
      );
    }
  }
  const rootFiles = new Set(files.filter((file) => !file.includes("/")));
  manifests.push(...MANIFESTS.filter((file) => rootFiles.has(file)));
  if (rootFiles.has("Makefile")) {
    const targets = [...((yield* read("Makefile")) ?? "").matchAll(/^([A-Za-z0-9_.-]+):/gm)]
      .map((match) => match[1])
      .slice(0, 12);
    manifests.push(`Makefile: ${targets.join(", ")}`);
  }
  add("Manifests and scripts", manifests.join("\n"));

  const readmeName = [...rootFiles].find((file) => /^readme(\.md)?$/i.test(file));
  if (readmeName !== undefined) {
    const headings = lines(yield* read(readmeName))
      .filter((line) => /^#{1,3} /.test(line))
      .slice(0, 20);
    add("README headings", headings.join("\n"));
  }

  if (isGit) {
    const [count, first, recent, branches] = yield* Effect.all(
      [
        run("git", ["rev-list", "--count", "HEAD"]),
        run("git", ["log", "--max-parents=0", "--format=%cs", "HEAD"]),
        run("git", ["log", "-8", "--format=%cs %h %s"]),
        run("git", [
          "for-each-ref",
          "--sort=-committerdate",
          "--count=6",
          "--format=%(refname:short) %(committerdate:short)",
          "refs/heads",
        ]),
      ],
      { concurrency: "unbounded" },
    );
    add(
      "Git",
      [
        `commits: ${count?.trim() ?? "none"}, first: ${lines(first).at(-1) ?? "none"}`,
        `recent:\n${lines(recent)
          .map((line) => `  ${clip(line, 120)}`)
          .join("\n")}`,
        `branches: ${lines(branches).join(", ")}`,
      ].join("\n"),
    );

    const todos = lines(yield* run("git", ["grep", "-n", "-I", "-w", "-E", "TODO|FIXME|HACK"]))
      .slice(0, MAX_TODO_LINES)
      .map((line) => clip(line.trim(), 160));
    add("TODO / FIXME / HACK", todos.join("\n"), 2_000);

    // Only when gh is installed, signed in and answers quickly.
    const issues = yield* run(
      "gh",
      ["issue", "list", "--state", "open", "--limit", "15", "--json", "number,title"],
      "4 seconds",
    );
    const parsed = issues === null ? null : decodeIssues(issues);
    if (parsed?._tag === "Some") {
      add(
        "Open GitHub issues",
        parsed.value.map((issue) => `#${issue.number} ${clip(issue.title, 100)}`).join("\n"),
      );
    }
  }
  const header = [
    `${REPO_DIGEST_PREFIX} for ${root}`,
    `files: ${files.length}${files.length >= MAX_WALK_FILES && !isGit ? "+" : ""}, git: ${isGit ? "yes" : "no"}, new repo: ${files.length <= NEW_REPO_MAX_FILES ? "yes" : "no"}`,
  ].join("\n");
  return clip([header, ...sections].join("\n\n"), MAX_DIGEST_CHARS);
});
