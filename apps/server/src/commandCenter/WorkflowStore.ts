import {
  CommandCenterError,
  CommandCenterSnippetName,
  CommandCenterWorkflow,
  CommandCenterWorkflowSlug,
  parseCommandCenterWorkflow,
  validateCommandCenterWorkflow,
  type CommandCenterSnippet,
  type CommandCenterSnippetListInput,
  type CommandCenterSnippetListResult,
  type CommandCenterSnippetRef,
  type CommandCenterSnippetSaveInput,
  type CommandCenterSnippetSummary,
  type CommandCenterWorkflowDetail,
  type CommandCenterWorkflowListInput,
  type CommandCenterWorkflowListResult,
  type CommandCenterWorkflowRef,
  type CommandCenterWorkflowSaveInput,
  type CommandCenterWorkflowStarters,
  type CommandCenterWorkflowSummary,
  type ProjectId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { failWith, requireCommandCenterEnabled } from "./CommandCenterService.ts";
import { WORKFLOW_STARTERS } from "./workflowStarters.ts";

/**
 * Wave 5: the project's workflow files (`.t3/workflows/<slug>.json`) and prompt snippets
 * (`.t3/workflows/snippets/<name>.md`), read and written on the machine that owns the project.
 * Deleting moves a workflow (or snippet) to `.t3/workflows/.trash`, where restore finds it.
 * Nothing watches the disk unless a client subscribes. Writes and the stream need Command Center on.
 */
export class WorkflowStore extends Context.Service<
  WorkflowStore,
  {
    readonly list: (
      input: CommandCenterWorkflowListInput,
    ) => Effect.Effect<CommandCenterWorkflowListResult, CommandCenterError>;
    /**
     * The list, then again after every change to the folder (saves here and edits on disk).
     * Fails while Command Center is off.
     */
    readonly subscribe: (
      input: CommandCenterWorkflowListInput,
    ) => Stream.Stream<CommandCenterWorkflowListResult, CommandCenterError>;
    /** The file decoded and checked; a broken file comes back with its errors and text. */
    readonly get: (
      input: CommandCenterWorkflowRef,
    ) => Effect.Effect<CommandCenterWorkflowDetail, CommandCenterError>;
    /** Validates, then writes the file atomically (replacing it); stale layout entries go. */
    readonly save: (
      input: CommandCenterWorkflowSaveInput,
    ) => Effect.Effect<CommandCenterWorkflowDetail, CommandCenterError>;
    /** Moves the file to the trash, replacing an older deleted copy of the same slug. */
    readonly remove: (input: CommandCenterWorkflowRef) => Effect.Effect<void, CommandCenterError>;
    /** Brings a deleted workflow back; refuses while a workflow with that slug exists. */
    readonly restore: (
      input: CommandCenterWorkflowRef,
    ) => Effect.Effect<CommandCenterWorkflowSummary, CommandCenterError>;
    /** The built-in workflows a user can copy into a project. */
    readonly starters: () => Effect.Effect<CommandCenterWorkflowStarters, CommandCenterError>;
    readonly listSnippets: (
      input: CommandCenterSnippetListInput,
    ) => Effect.Effect<CommandCenterSnippetListResult, CommandCenterError>;
    readonly getSnippet: (
      input: CommandCenterSnippetRef,
    ) => Effect.Effect<CommandCenterSnippet, CommandCenterError>;
    readonly saveSnippet: (
      input: CommandCenterSnippetSaveInput,
    ) => Effect.Effect<CommandCenterSnippetSummary, CommandCenterError>;
    /** Moves the snippet to `.t3/workflows/.trash/snippets`, replacing an older deleted copy. */
    readonly deleteSnippet: (
      input: CommandCenterSnippetRef,
    ) => Effect.Effect<void, CommandCenterError>;
    /** Brings a deleted snippet back; refuses while a snippet with that name exists. */
    readonly restoreSnippet: (
      input: CommandCenterSnippetRef,
    ) => Effect.Effect<CommandCenterSnippetSummary, CommandCenterError>;
  }
>()("t3/commandCenter/WorkflowStore") {}

// Files bigger than this are someone else's; the schema keeps real workflows far smaller.
const MAX_WORKFLOW_BYTES = 512 * 1024;
const MAX_SNIPPET_BYTES = 128 * 1024;
const LIST_LIMIT = 200;
const WATCH_DEBOUNCE = Duration.millis(150);

const isSlug = Schema.is(CommandCenterWorkflowSlug);
const isSnippetName = Schema.is(CommandCenterSnippetName);
// Indented, so a workflow file reads well in review and diffs line by line.
const encodeWorkflowFile = Schema.encodeSync(
  Schema.fromJsonString(CommandCenterWorkflow, { space: 2 }),
);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const EPOCH = "1970-01-01T00:00:00.000Z";

const fail = (message: string) => Effect.fail(new CommandCenterError({ message }));
const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";
const modifiedAt = (info: FileSystem.File.Info) =>
  Option.match(info.mtime, { onNone: () => EPOCH, onSome: (date) => date.toISOString() });

/** What a list shows for one file. */
export const summarize = (detail: CommandCenterWorkflowDetail): CommandCenterWorkflowSummary =>
  detail.workflow === null
    ? {
        slug: detail.slug,
        title: detail.slug,
        description: "",
        inputs: [],
        nodeCount: 0,
        updatedAt: detail.updatedAt,
        error: detail.errors.join(" "),
      }
    : {
        slug: detail.slug,
        title: detail.workflow.title,
        description: detail.workflow.description,
        inputs: detail.workflow.inputs,
        nodeCount: detail.workflow.nodes.length,
        updatedAt: detail.updatedAt,
        error: null,
      };

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const fileContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  // Which project's workflows changed here; subscribers re-list, so a dropped signal costs nothing.
  const changes = yield* PubSub.sliding<ProjectId>(64);
  const requireEnabled = requireCommandCenterEnabled(serverSettings);

  const folders = Effect.fn("WorkflowStore.folders")(function* (projectId: ProjectId) {
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError(failWith("Could not read the project.")));
    if (Option.isNone(project)) {
      return yield* fail("That project is not on this machine; ask the machine that has it.");
    }
    const workflows = path.join(project.value.workspaceRoot, ".t3", "workflows");
    return {
      workflows,
      trash: path.join(workflows, ".trash"),
      snippets: path.join(workflows, "snippets"),
    };
  });

  const writeAtomically = (filePath: string, contents: string, message: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provide(fileContext),
      Effect.mapError(failWith(message)),
    );

  const exists = (filePath: string) =>
    fileSystem.exists(filePath).pipe(Effect.mapError(failWith("Could not read the workflows.")));

  /** File names in `directory`; none when it does not exist yet. */
  const entries = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(
      Effect.catchIf(isNotFound, () => Effect.succeed<ReadonlyArray<string>>([])),
      Effect.mapError(failWith("Could not read the workflows.")),
    );

  /** Reads one workflow file; a missing file fails, a broken one returns its errors. */
  const readWorkflow = Effect.fn("WorkflowStore.readWorkflow")(function* (
    file: string,
    slug: CommandCenterWorkflowSlug,
  ) {
    const info = yield* fileSystem
      .stat(file)
      .pipe(
        Effect.mapError((error) =>
          isNotFound(error)
            ? new CommandCenterError({ message: `No workflow named "${slug}".` })
            : failWith("Could not read the workflow.")(error),
        ),
      );
    const updatedAt = modifiedAt(info);
    const broken = (errors: ReadonlyArray<string>, raw: string | null) =>
      ({ slug, workflow: null, errors, raw, updatedAt }) satisfies CommandCenterWorkflowDetail;
    if (info.type !== "File") return broken(["Not a file."], null);
    if (info.size > BigInt(MAX_WORKFLOW_BYTES)) {
      return broken([`The file is larger than ${MAX_WORKFLOW_BYTES / 1024} KiB.`], null);
    }
    const text = yield* fileSystem
      .readFileString(file)
      .pipe(Effect.mapError(failWith("Could not read the workflow.")));
    const json = yield* Effect.result(decodeJson(text));
    if (Result.isFailure(json)) {
      return broken([`Invalid JSON: ${json.failure.message.replace(/\s*\n\s*/g, " ")}`], text);
    }
    const parsed = parseCommandCenterWorkflow(json.success);
    // The file name is the slug, whatever the file says.
    return parsed.workflow === null
      ? broken(parsed.errors, text)
      : ({
          slug,
          workflow: { ...parsed.workflow, slug },
          errors: [],
          raw: null,
          updatedAt,
        } satisfies CommandCenterWorkflowDetail);
  });

  const list = Effect.fn("WorkflowStore.list")(function* (input: CommandCenterWorkflowListInput) {
    const dirs = yield* folders(input.projectId);
    const directory = input.trashed === true ? dirs.trash : dirs.workflows;
    const slugs = (yield* entries(directory))
      .flatMap((entry) => {
        const slug = entry.endsWith(".json") ? entry.slice(0, -".json".length) : "";
        return isSlug(slug) ? [slug] : [];
      })
      .sort()
      .slice(0, LIST_LIMIT);
    const summaries = yield* Effect.forEach(
      slugs,
      (slug) =>
        readWorkflow(path.join(directory, `${slug}.json`), slug).pipe(
          Effect.map((detail): CommandCenterWorkflowSummary | null => summarize(detail)),
          // Deleted while listing: leave it out. Unreadable: show why.
          Effect.catch((error) =>
            Effect.succeed(
              error.message.startsWith("No workflow named")
                ? null
                : summarize({
                    slug,
                    workflow: null,
                    errors: [error.message],
                    raw: null,
                    updatedAt: EPOCH,
                  }),
            ),
          ),
        ),
      { concurrency: 8 },
    );
    return { workflows: summaries.filter((summary) => summary !== null) };
  });

  const subscribe = (input: CommandCenterWorkflowListInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* requireEnabled;
        const dirs = yield* folders(input.projectId);
        const directory = input.trashed === true ? dirs.trash : dirs.workflows;
        // Subscribe before the first read so a save landing between the two is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        const local = Stream.fromSubscription(subscription).pipe(
          Stream.filter((projectId) => projectId === input.projectId),
        );
        // ponytail: a folder created after subscribing is only seen through this server's own
        // saves (or the next subscribe); watch the project root too if editing by hand first matters.
        const onDisk = (yield* exists(directory))
          ? fileSystem.watch(directory).pipe(Stream.ignore({ log: true }))
          : Stream.empty;
        return Stream.concat(
          Stream.fromEffect(list(input)),
          Stream.merge(local, onDisk).pipe(
            Stream.debounce(WATCH_DEBOUNCE),
            Stream.mapEffect(() => list(input)),
          ),
        );
      }),
    );

  const workflowFile = Effect.fn("WorkflowStore.workflowFile")(function* (
    input: CommandCenterWorkflowRef,
  ) {
    const dirs = yield* folders(input.projectId);
    return {
      file: path.join(dirs.workflows, `${input.slug}.json`),
      trashed: path.join(dirs.trash, `${input.slug}.json`),
      trash: dirs.trash,
    };
  });

  const get = Effect.fn("WorkflowStore.get")(function* (input: CommandCenterWorkflowRef) {
    const { file } = yield* workflowFile(input);
    return yield* readWorkflow(file, input.slug);
  });

  const save = Effect.fn("WorkflowStore.save")(function* (input: CommandCenterWorkflowSaveInput) {
    yield* requireEnabled;
    const errors = validateCommandCenterWorkflow(input.workflow);
    if (errors.length > 0) return yield* fail(`The workflow is not valid: ${errors.join(" ")}`);
    const ids = new Set<string>(input.workflow.nodes.map((node) => node.id));
    const workflow = {
      ...input.workflow,
      layout: Object.fromEntries(
        Object.entries(input.workflow.layout).filter(([id]) => ids.has(id)),
      ),
    };
    const { file } = yield* workflowFile({ projectId: input.projectId, slug: workflow.slug });
    const text = `${encodeWorkflowFile(workflow)}\n`;
    yield* writeAtomically(file, text, "Could not save the workflow.");
    yield* PubSub.publish(changes, input.projectId);
    return yield* readWorkflow(file, workflow.slug);
  });

  const remove = Effect.fn("WorkflowStore.remove")(function* (input: CommandCenterWorkflowRef) {
    yield* requireEnabled;
    const { file, trashed, trash } = yield* workflowFile(input);
    if (!(yield* exists(file))) return yield* fail(`No workflow named "${input.slug}".`);
    yield* fileSystem
      .makeDirectory(trash, { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.rename(file, trashed)),
        Effect.mapError(failWith("Could not delete the workflow.")),
      );
    yield* PubSub.publish(changes, input.projectId);
  });

  const restore = Effect.fn("WorkflowStore.restore")(function* (input: CommandCenterWorkflowRef) {
    yield* requireEnabled;
    const { file, trashed } = yield* workflowFile(input);
    if (yield* exists(file)) {
      return yield* fail(
        `A workflow named "${input.slug}" already exists; rename or delete it first.`,
      );
    }
    if (!(yield* exists(trashed))) return yield* fail(`No deleted workflow named "${input.slug}".`);
    yield* fileSystem
      .rename(trashed, file)
      .pipe(Effect.mapError(failWith("Could not restore the workflow.")));
    yield* PubSub.publish(changes, input.projectId);
    return summarize(yield* readWorkflow(file, input.slug));
  });

  const starters = () => Effect.succeed({ starters: WORKFLOW_STARTERS });

  const snippetFile = Effect.fn("WorkflowStore.snippetFile")(function* (
    projectId: ProjectId,
    name: string,
  ) {
    const dirs = yield* folders(projectId);
    return path.join(dirs.snippets, `${name}.md`);
  });

  const trashedSnippetFile = Effect.fn("WorkflowStore.trashedSnippetFile")(function* (
    projectId: ProjectId,
    name: string,
  ) {
    const dirs = yield* folders(projectId);
    return path.join(dirs.trash, "snippets", `${name}.md`);
  });

  const readSnippet = Effect.fn("WorkflowStore.readSnippet")(function* (
    file: string,
    name: CommandCenterSnippetName,
  ) {
    const info = yield* fileSystem
      .stat(file)
      .pipe(
        Effect.mapError((error) =>
          isNotFound(error)
            ? new CommandCenterError({ message: `No snippet named "${name}".` })
            : failWith("Could not read the snippet.")(error),
        ),
      );
    if (info.type !== "File" || info.size > BigInt(MAX_SNIPPET_BYTES)) {
      return yield* fail(`The snippet "${name}" is not a small text file.`);
    }
    const content = yield* fileSystem
      .readFileString(file)
      .pipe(Effect.mapError(failWith("Could not read the snippet.")));
    return { name, content, updatedAt: modifiedAt(info) };
  });

  const listSnippets = Effect.fn("WorkflowStore.listSnippets")(function* (
    input: CommandCenterSnippetListInput,
  ) {
    const dirs = yield* folders(input.projectId);
    const names = (yield* entries(dirs.snippets))
      .flatMap((entry) => {
        const name = entry.endsWith(".md") ? entry.slice(0, -".md".length) : "";
        return isSnippetName(name) ? [name] : [];
      })
      .sort()
      .slice(0, LIST_LIMIT);
    const snippets = yield* Effect.forEach(
      names,
      (name) =>
        readSnippet(path.join(dirs.snippets, `${name}.md`), name).pipe(
          Effect.map((snippet): CommandCenterSnippetSummary | null => ({
            name,
            chars: snippet.content.length,
            updatedAt: snippet.updatedAt,
          })),
          Effect.orElseSucceed(() => null),
        ),
      { concurrency: 8 },
    );
    return { snippets: snippets.filter((snippet) => snippet !== null) };
  });

  const getSnippet = Effect.fn("WorkflowStore.getSnippet")(function* (
    input: CommandCenterSnippetRef,
  ) {
    return yield* readSnippet(yield* snippetFile(input.projectId, input.name), input.name);
  });

  const saveSnippet = Effect.fn("WorkflowStore.saveSnippet")(function* (
    input: CommandCenterSnippetSaveInput,
  ) {
    yield* requireEnabled;
    const file = yield* snippetFile(input.projectId, input.name);
    yield* writeAtomically(file, input.content, "Could not save the snippet.");
    const saved = yield* readSnippet(file, input.name);
    return { name: input.name, chars: saved.content.length, updatedAt: saved.updatedAt };
  });

  const deleteSnippet = Effect.fn("WorkflowStore.deleteSnippet")(function* (
    input: CommandCenterSnippetRef,
  ) {
    yield* requireEnabled;
    const file = yield* snippetFile(input.projectId, input.name);
    const trashed = yield* trashedSnippetFile(input.projectId, input.name);
    if (!(yield* exists(file))) return yield* fail(`No snippet named "${input.name}".`);
    yield* fileSystem
      .makeDirectory(path.dirname(trashed), { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.rename(file, trashed)),
        Effect.mapError(failWith("Could not delete the snippet.")),
      );
  });

  const restoreSnippet = Effect.fn("WorkflowStore.restoreSnippet")(function* (
    input: CommandCenterSnippetRef,
  ) {
    yield* requireEnabled;
    const file = yield* snippetFile(input.projectId, input.name);
    const trashed = yield* trashedSnippetFile(input.projectId, input.name);
    if (yield* exists(file)) {
      return yield* fail(`A snippet named "${input.name}" already exists; delete it first.`);
    }
    if (!(yield* exists(trashed))) return yield* fail(`No deleted snippet named "${input.name}".`);
    yield* fileSystem
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.rename(trashed, file)),
        Effect.mapError(failWith("Could not restore the snippet.")),
      );
    const restored = yield* readSnippet(file, input.name);
    return { name: input.name, chars: restored.content.length, updatedAt: restored.updatedAt };
  });

  return WorkflowStore.of({
    list,
    subscribe,
    get,
    save,
    remove,
    restore,
    starters,
    listSnippets,
    getSnippet,
    saveSnippet,
    deleteSnippet,
    restoreSnippet,
  });
});

export const layer = Layer.effect(WorkflowStore, make);
