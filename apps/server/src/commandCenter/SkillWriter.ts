import {
  CommandCenterError,
  CommandCenterSkillName,
  type CommandCenterSkillListInput,
  type CommandCenterSkillRef,
  type CommandCenterSkillListResult,
  type CommandCenterSkillSummary,
  type CommandCenterSkillWriteInput,
  type CommandCenterSkillWriteResult,
  type ProjectId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { failWith, requireCommandCenterEnabled } from "./CommandCenterService.ts";

/**
 * Wave 5: the project's own skills. Codex and Antigravity read `.agents/skills/<name>/SKILL.md`
 * and Claude reads `.claude/skills/<name>/SKILL.md`, so every write lands in both and every
 * provider sees the same skill. Written on the machine that owns the project, while Command
 * Center is on. Delete moves both copies to `.t3/workflows/.trash/skills`, where restore finds them.
 */
export class SkillWriter extends Context.Service<
  SkillWriter,
  {
    readonly list: (
      input: CommandCenterSkillListInput,
    ) => Effect.Effect<CommandCenterSkillListResult, CommandCenterError>;
    /** Refuses a name either folder already has. */
    readonly create: (
      input: CommandCenterSkillWriteInput,
    ) => Effect.Effect<CommandCenterSkillWriteResult, CommandCenterError>;
    /**
     * Replaces both copies, keeping frontmatter keys other than `name` and `description`; refuses
     * a name neither folder has, and copies that differ (so neither is silently overwritten).
     */
    readonly update: (
      input: CommandCenterSkillWriteInput,
    ) => Effect.Effect<CommandCenterSkillWriteResult, CommandCenterError>;
    readonly remove: (input: CommandCenterSkillRef) => Effect.Effect<void, CommandCenterError>;
    /** Brings a deleted skill back; refuses while a skill with that name exists. */
    readonly restore: (
      input: CommandCenterSkillRef,
    ) => Effect.Effect<CommandCenterSkillWriteResult, CommandCenterError>;
  }
>()("t3/commandCenter/SkillWriter") {}

const MAX_SKILL_BYTES = 256 * 1024;
const LIST_LIMIT = 200;
const isSkillName = Schema.is(CommandCenterSkillName);
const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

/**
 * `SKILL.md`: YAML frontmatter with `name` and `description` (then any other keys the file
 * already had, such as `allowed-tools`), then the instructions.
 */
export const renderSkill = (
  input: Pick<CommandCenterSkillWriteInput, "name" | "description" | "content">,
  kept: Readonly<Record<string, unknown>> = {},
) => {
  const { name: _name, description: _description, ...rest } = kept;
  const frontmatter = { name: input.name, description: input.description, ...rest };
  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 })}---\n\n${input.content}\n`;
};

/** The YAML frontmatter of a `SKILL.md` as an object, or null when it has none. */
export const readSkillFrontmatter = (text: string): Record<string, unknown> | null => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match?.[1] === undefined) return null;
  try {
    const frontmatter: unknown = parseYaml(match[1]);
    return typeof frontmatter === "object" && frontmatter !== null && !Array.isArray(frontmatter)
      ? (frontmatter as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** The frontmatter `description` of a `SKILL.md`, or null. */
export const readSkillDescription = (text: string): string | null => {
  const description = readSkillFrontmatter(text)?.description;
  return typeof description === "string" && description.trim() !== "" ? description.trim() : null;
};

const sameText = (left: string, right: string) =>
  left.replace(/\r\n/g, "\n").trim() === right.replace(/\r\n/g, "\n").trim();

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const requireEnabled = requireCommandCenterEnabled(yield* ServerSettings.ServerSettingsService);
  const fileContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const roots = Effect.fn("SkillWriter.roots")(function* (projectId: ProjectId) {
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError(failWith("Could not read the project.")));
    if (Option.isNone(project)) {
      return yield* new CommandCenterError({
        message: "That project is not on this machine; ask the machine that has it.",
      });
    }
    const root = project.value.workspaceRoot;
    const trash = path.join(root, ".t3", "workflows", ".trash", "skills");
    return {
      agents: path.join(root, ".agents", "skills"),
      claude: path.join(root, ".claude", "skills"),
      trashAgents: path.join(trash, "agents"),
      trashClaude: path.join(trash, "claude"),
    };
  });

  /** The skill's `SKILL.md` text in one folder, or null when it has none. */
  const readSkill = (directory: string, name: string) => {
    const file = path.join(directory, name, "SKILL.md");
    return fileSystem.stat(file).pipe(
      Effect.flatMap((info) =>
        info.type === "File" && info.size <= BigInt(MAX_SKILL_BYTES)
          ? fileSystem.readFileString(file)
          : Effect.succeed(""),
      ),
      Effect.map((text): string | null => text),
      Effect.catchIf(isNotFound, () => Effect.succeed(null)),
      Effect.mapError(failWith("Could not read the skills.")),
    );
  };

  const names = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(
      Effect.map((entries) => entries.filter(isSkillName)),
      Effect.catchIf(isNotFound, () => Effect.succeed<ReadonlyArray<string>>([])),
      Effect.mapError(failWith("Could not read the skills.")),
    );

  const summary = Effect.fn("SkillWriter.summary")(function* (
    dirs: { readonly agents: string; readonly claude: string },
    name: CommandCenterSkillName,
  ) {
    const [agents, claude] = yield* Effect.all([
      readSkill(dirs.agents, name),
      readSkill(dirs.claude, name),
    ]);
    return {
      name,
      description: readSkillDescription(agents ?? claude ?? ""),
      inAgents: agents !== null,
      inClaude: claude !== null,
    } satisfies CommandCenterSkillSummary;
  });

  const list = Effect.fn("SkillWriter.list")(function* (input: CommandCenterSkillListInput) {
    const dirs = yield* roots(input.projectId);
    const [agents, claude] = yield* Effect.all([names(dirs.agents), names(dirs.claude)]);
    const all = [...new Set([...agents, ...claude])].sort().slice(0, LIST_LIMIT);
    const skills = yield* Effect.forEach(all.filter(isSkillName), (name) => summary(dirs, name), {
      concurrency: 8,
    });
    // A folder without SKILL.md is not a skill.
    return { skills: skills.filter((skill) => skill.inAgents || skill.inClaude) };
  });

  const write = Effect.fn("SkillWriter.write")(function* (
    input: CommandCenterSkillWriteInput,
    mode: "create" | "update",
  ) {
    yield* requireEnabled;
    const dirs = yield* roots(input.projectId);
    const [agents, claude] = yield* Effect.all([
      readSkill(dirs.agents, input.name),
      readSkill(dirs.claude, input.name),
    ]);
    const present = agents !== null || claude !== null;
    if (mode === "create" && present) {
      return yield* new CommandCenterError({
        message: `A skill named "${input.name}" already exists; update it instead.`,
      });
    }
    if (mode === "update" && !present) {
      return yield* new CommandCenterError({ message: `No skill named "${input.name}".` });
    }
    if (agents !== null && claude !== null && !sameText(agents, claude)) {
      return yield* new CommandCenterError({
        message: `The .agents and .claude copies of "${input.name}" differ; make them match (or delete one) before saving here.`,
      });
    }
    const contents = renderSkill(input, readSkillFrontmatter(agents ?? claude ?? "") ?? {});
    yield* Effect.forEach(
      [dirs.agents, dirs.claude],
      (directory) =>
        writeFileStringAtomically({
          filePath: path.join(directory, input.name, "SKILL.md"),
          contents,
        }),
      { discard: true },
    ).pipe(Effect.provide(fileContext), Effect.mapError(failWith("Could not save the skill.")));
    return { skill: yield* summary(dirs, input.name) };
  });

  /** Moves a folder, replacing what `to` held; false when `from` does not exist. */
  const move = (from: string, to: string) =>
    fileSystem
      .exists(from)
      .pipe(
        Effect.flatMap((found) =>
          found
            ? fileSystem
                .remove(to, { recursive: true, force: true })
                .pipe(
                  Effect.andThen(fileSystem.makeDirectory(path.dirname(to), { recursive: true })),
                  Effect.andThen(fileSystem.rename(from, to)),
                  Effect.as(true),
                )
            : Effect.succeed(false),
        ),
      );

  const remove = Effect.fn("SkillWriter.remove")(function* (input: CommandCenterSkillRef) {
    yield* requireEnabled;
    const dirs = yield* roots(input.projectId);
    const moved = yield* Effect.all([
      move(path.join(dirs.agents, input.name), path.join(dirs.trashAgents, input.name)),
      move(path.join(dirs.claude, input.name), path.join(dirs.trashClaude, input.name)),
    ]).pipe(Effect.mapError(failWith("Could not delete the skill.")));
    if (!moved.includes(true)) {
      return yield* new CommandCenterError({ message: `No skill named "${input.name}".` });
    }
  });

  const restore = Effect.fn("SkillWriter.restore")(function* (input: CommandCenterSkillRef) {
    yield* requireEnabled;
    const dirs = yield* roots(input.projectId);
    const existing = yield* summary(dirs, input.name);
    if (existing.inAgents || existing.inClaude) {
      return yield* new CommandCenterError({
        message: `A skill named "${input.name}" already exists; delete it first.`,
      });
    }
    const moved = yield* Effect.all([
      move(path.join(dirs.trashAgents, input.name), path.join(dirs.agents, input.name)),
      move(path.join(dirs.trashClaude, input.name), path.join(dirs.claude, input.name)),
    ]).pipe(Effect.mapError(failWith("Could not restore the skill.")));
    if (!moved.includes(true)) {
      return yield* new CommandCenterError({ message: `No deleted skill named "${input.name}".` });
    }
    return { skill: yield* summary(dirs, input.name) };
  });

  return SkillWriter.of({
    list,
    create: (input) => write(input, "create"),
    update: (input) => write(input, "update"),
    remove,
    restore,
  });
});

export const layer = Layer.effect(SkillWriter, make);
