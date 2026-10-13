import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  buildOnboardingPrompt,
  latestHandoffs,
  onboardingTask,
} from "@t3tools/client-runtime/command-center-delegation";
import {
  AuthAdministrativeScopes,
  type CommandCenterArtifact,
  type CommandCenterArtifactDetail,
  CommandCenterArtifactId,
  CommandCenterMemoryKind,
  CommandCenterMemoryId,
  type CommandCenterMemoryEntry,
  type CommandCenterSection,
  CommandId,
  EnvironmentHttpApi,
  type EnvironmentId,
  MessageId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  type ProjectSnapshot,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { detectArtifactImport } from "../commandCenter/artifactImport.ts";
import { ONBOARDING_LEAD_ID, ONBOARDING_TEAM_ID } from "../commandCenter/onboarding.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export class CommandCenterCliError extends Schema.TaggedError<CommandCenterCliError>()(
  "CommandCenterCliError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const fail = (message: string) => (cause?: unknown) =>
  new CommandCenterCliError({ message, ...(cause === undefined ? {} : { cause }) });

type ProjectShell = ProjectSnapshot["projects"][number];

/** Matches an active project by id, workspace root or title (any case). */
export const findProject = (
  projects: ReadonlyArray<ProjectShell>,
  identifier: string,
  resolvePath: (input: string) => string,
): ProjectShell | undefined => {
  const wanted = identifier.trim();
  const active = projects.filter((project) => project.deletedAt === null);
  const root = resolvePath(wanted);
  return (
    active.find((project) => project.id === wanted) ??
    active.find((project) => project.workspaceRoot === root) ??
    active.find((project) => project.title.toLowerCase() === wanted.toLowerCase())
  );
};

export const formatMemoryLine = (entry: CommandCenterMemoryEntry) => {
  const mark = entry.kind === "todo" ? (entry.done ? "[x] " : "[ ] ") : "";
  const firstLine = entry.text.split("\n", 1)[0] ?? "";
  return `${entry.id}  ${entry.createdAt.slice(0, 10)}  ${entry.kind.padEnd(8)} ${mark}${firstLine}`;
};

export const formatSectionLine = (section: CommandCenterSection) => {
  const due = section.dueDate === null ? "" : `  due ${section.dueDate}`;
  const blocker = section.blocker === null ? "" : `  blocked: ${section.blocker}`;
  return `${section.id}  ${section.name}  ${section.status}  ${section.tasksDone}/${section.tasksTotal}${due}${blocker}`;
};

export const formatArtifactLine = (artifact: CommandCenterArtifact) => {
  const archived = artifact.archivedAt === null ? "" : "  archived";
  return `${artifact.id}  ${artifact.updatedAt.slice(0, 10)}  ${artifact.kind.padEnd(8)} v${artifact.currentVersion}  ${artifact.title}${archived}`;
};

/** Version history of one artifact, newest first, marking the one shown. */
export const formatArtifactVersions = (detail: CommandCenterArtifactDetail) =>
  detail.versions.map((version) => {
    const mark = version.version === detail.version.version ? "*" : " ";
    const author = version.authorLabel ?? version.author;
    return `${mark} v${version.version}  ${version.createdAt.slice(0, 16).replace("T", " ")}  ${author}  ${version.sizeBytes} B`;
  });

const makeWsClient = RpcClient.make(WsRpcGroup);
type CommandCenterCliClient = Effect.Success<typeof makeWsClient>;

export interface CommandCenterCliContext {
  readonly rpc: CommandCenterCliClient;
  readonly projects: ReadonlyArray<ProjectShell>;
  readonly resolveProject: (
    identifier: string,
  ) => Effect.Effect<ProjectShell, CommandCenterCliError>;
  readonly environmentId: Effect.Effect<EnvironmentId, CommandCenterCliError>;
}

/**
 * Connects to the running server the way a client does: a short-lived admin session, a
 * WebSocket ticket over HTTP, then the same WS RPCs the web app calls. Command Center has
 * no offline mode because its change stream and daily tick live in the server process.
 */
export const withCommandCenter = <A, E>(
  flags: CliAuthLocationFlags,
  run: (context: CommandCenterCliContext) => Effect.Effect<A, E, Crypto.Crypto>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const path = yield* Path.Path;

    return yield* Effect.gen(function* () {
      const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isNone(runtimeState)) {
        return yield* fail("No running T3 server found. Start one with `t3` first.")();
      }
      const origin = runtimeState.value.origin;
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* Effect.acquireRelease(
        environmentAuth.issueSession({ scopes: AuthAdministrativeScopes, label: "t3 cc cli" }),
        (session) =>
          environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
      );
      const headers = { authorization: `Bearer ${issued.token}` };
      const http = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
      const { ticket } = yield* http.auth
        .webSocketTicket({ headers })
        .pipe(Effect.mapError(fail(`Could not reach the T3 server at ${origin}.`)));
      const { projects } = yield* http.projects
        .snapshot({ headers })
        .pipe(Effect.mapError(fail("Could not read projects.")));

      const socketUrl = new URL("/ws", origin);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      socketUrl.searchParams.set("wsTicket", ticket);
      socketUrl.searchParams.set(
        ORCHESTRATION_PROTOCOL_QUERY_PARAM,
        String(ORCHESTRATION_PROTOCOL_VERSION),
      );
      const rpc = yield* makeWsClient.pipe(
        Effect.provide(
          RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
            Layer.provide(
              Socket.layerWebSocket(socketUrl.toString()).pipe(
                Layer.provide(NodeSocket.layerWebSocketConstructor),
              ),
            ),
            Layer.provide(RpcSerialization.layerJson),
          ),
        ),
      );

      const resolveProject = (identifier: string) => {
        const project = findProject(projects, identifier, (input) => path.resolve(input));
        return project
          ? Effect.succeed(project)
          : Effect.fail(fail(`No active project found for '${identifier}'.`)());
      };
      const environmentId = http.metadata.descriptor().pipe(
        Effect.map((descriptor) => descriptor.environmentId),
        Effect.mapError(fail("Could not read the server environment.")),
      );

      return yield* run({ rpc, projects, resolveProject, environmentId });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        EnvironmentAuth.layerRuntime.pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  });

export const projectFlag = Flag.String("project").pipe(
  Flag.withDescription("Project id, workspace root or title."),
  Flag.optional,
);

const projectIdOf = (context: CommandCenterCliContext, project: Option.Option<string>) =>
  Option.isNone(project)
    ? Effect.succeed(undefined)
    : context.resolveProject(project.value).pipe(Effect.map((shell) => shell.id));

export const printLines = (lines: ReadonlyArray<string>, empty: string) =>
  Console.log(lines.length === 0 ? empty : lines.join("\n"));

const memoryListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: projectFlag,
  kind: Flag.Literals("kind", CommandCenterMemoryKind.literals).pipe(Flag.optional),
  limit: Flag.Int("limit").pipe(Flag.withDefault(50)),
  before: Flag.String("before").pipe(
    Flag.withDescription("Only entries older than this memory id."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("List memory entries, newest first."),
  Command.withHandler((flags) =>
    withCommandCenter(flags, (context) =>
      Effect.gen(function* () {
        const projectId = yield* projectIdOf(context, flags.project);
        const page = yield* context.rpc[WS_METHODS.commandCenterListMemory]({
          limit: flags.limit,
          ...(projectId === undefined ? {} : { projectId }),
          ...(Option.isSome(flags.kind) ? { kind: flags.kind.value } : {}),
          ...(Option.isSome(flags.before)
            ? { before: CommandCenterMemoryId.make(flags.before.value) }
            : {}),
        });
        yield* printLines(page.entries.map(formatMemoryLine), "No memory entries.");
        if (page.hasMore) {
          const last = page.entries.at(-1);
          if (last) yield* Console.log(`More: --before ${last.id}`);
        }
      }),
    ),
  ),
);

const memoryAddCommand = Command.make("add", {
  ...projectLocationFlags,
  project: projectFlag,
  kind: Flag.Literals("kind", CommandCenterMemoryKind.literals).pipe(Flag.withDefault("note")),
  text: Argument.String("text").pipe(Argument.withDescription("What to remember.")),
}).pipe(
  Command.withDescription("Save a memory entry."),
  Command.withHandler((flags) =>
    withCommandCenter(flags, (context) =>
      Effect.gen(function* () {
        const projectId = yield* projectIdOf(context, flags.project);
        const record = yield* context.rpc[WS_METHODS.commandCenterUpsert]({
          entity: "memory",
          value: {
            projectId: projectId ?? null,
            sectionId: null,
            threadId: null,
            kind: flags.kind,
            text: flags.text.trim(),
            done: false,
            source: "user",
          },
        });
        yield* Console.log(`Saved ${flags.kind} ${record.value.id}.`);
      }),
    ),
  ),
);

const memoryDoneCommand = Command.make("done", {
  ...projectLocationFlags,
  id: Argument.String("id").pipe(Argument.withDescription("Memory todo id.")),
  undo: Flag.Boolean("undo").pipe(
    Flag.withDescription("Reopen the todo."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Close (or reopen with --undo) a memory todo."),
  Command.withHandler((flags) =>
    withCommandCenter(flags, (context) =>
      context.rpc[WS_METHODS.commandCenterSetMemoryDone]({
        id: CommandCenterMemoryId.make(flags.id),
        done: !flags.undo,
      }).pipe(Effect.flatMap((entry) => Console.log(formatMemoryLine(entry)))),
    ),
  ),
);

const memoryRecallCommand = Command.make("recall", {
  ...projectLocationFlags,
  project: projectFlag,
}).pipe(
  Command.withDescription("Where we left off: latest progress, open todos, decisions, handoffs."),
  Command.withHandler((flags) =>
    withCommandCenter(flags, (context) =>
      Effect.gen(function* () {
        const projectId = yield* projectIdOf(context, flags.project);
        const recall = yield* context.rpc[WS_METHODS.commandCenterRecallMemory](
          projectId === undefined ? {} : { projectId },
        );
        const sections: ReadonlyArray<readonly [string, ReadonlyArray<CommandCenterMemoryEntry>]> =
          [
            ["Progress", recall.progress],
            ["Open todos", recall.openTodos],
            ["Decisions", recall.decisions],
            ["Handoffs", recall.handoffs],
          ];
        yield* Console.log(
          sections
            .map(([title, entries]) =>
              [
                `${title}:`,
                ...(entries.length === 0
                  ? ["  none"]
                  : entries.map((e) => `  ${formatMemoryLine(e)}`)),
              ].join("\n"),
            )
            .join("\n\n"),
        );
      }),
    ),
  ),
);

export const memoryCommand = Command.make("memory").pipe(
  Command.withDescription("Read and write Command Center memory on the running server."),
  Command.withSubcommands([
    memoryListCommand,
    memoryAddCommand,
    memoryDoneCommand,
    memoryRecallCommand,
  ]),
);

const ccSectionsCommand = Command.make("sections", {
  ...projectLocationFlags,
  project: projectFlag,
}).pipe(
  Command.withDescription("List Command Center sections."),
  Command.withHandler((flags) =>
    withCommandCenter(flags, (context) =>
      Effect.gen(function* () {
        const projectId = yield* projectIdOf(context, flags.project);
        const { sections } = yield* context.rpc[WS_METHODS.commandCenterListSections](
          projectId === undefined ? {} : { projectId },
        );
        const lines = context.projects
          .filter((project) => projectId === undefined || project.id === projectId)
          .flatMap((project) => {
            const own = sections.filter((section) => section.projectId === project.id);
            return own.length === 0
              ? []
              : [project.title, ...own.map((section) => `  ${formatSectionLine(section)}`)];
          });
        yield* printLines(lines, "No sections.");
      }),
    ),
  ),
);

const ccOnboardCommand = Command.make("onboard", {
  ...projectLocationFlags,
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id, workspace root or title to onboard."),
  ),
}).pipe(
  Command.withDescription("Start the Onboarding team's Lead on a project."),
  Command.withHandler((flags) =>
    withCommandCenter(flags, (context) =>
      Effect.gen(function* () {
        const project = yield* context.resolveProject(flags.project);
        const team = yield* context.rpc[WS_METHODS.commandCenterEnsureOnboardingTeam]({});
        const lead = team.agents.find((agent) => agent.id === ONBOARDING_LEAD_ID);
        if (!lead) return yield* fail("The Onboarding team has no Lead.")();
        yield* context.rpc[WS_METHODS.commandCenterBuildRepoDigest]({ projectId: project.id });
        const recall = yield* context.rpc[WS_METHODS.commandCenterRecallMemory]({
          projectId: project.id,
        });

        const crypto = yield* Crypto.Crypto;
        const uuid = crypto.randomUUIDv4.pipe(Effect.mapError(fail("Could not generate an id.")));
        // Same task and first message as the web's Onboard button. Onboarding only writes memory
        // and sections, so it runs in the project checkout, not a worktree.
        const task = onboardingTask(project.title);
        const launched = yield* context.rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
          commandId: CommandId.make(yield* uuid),
          creationSource: "server",
          projectId: project.id,
          title: task,
          modelSelection: lead.modelSelection,
          runtimeMode: lead.runtimeMode,
          interactionMode: lead.interactionMode,
          workspaceStrategy: { type: "root" },
          initialMessage: {
            messageId: MessageId.make(yield* uuid),
            text: buildOnboardingPrompt({
              rolePrompt: lead.rolePrompt,
              projectTitle: project.title,
              handoffs: latestHandoffs(recall.handoffs, project.id),
            }),
            attachments: [],
          },
        });
        const environmentId = yield* context.environmentId;
        yield* context.rpc[WS_METHODS.commandCenterUpsert]({
          entity: "assignment",
          value: {
            agentId: lead.id,
            environmentId,
            threadId: launched.threadId,
            projectId: project.id,
            sectionId: null,
            task,
            finishedAt: null,
          },
        });
        yield* Console.log(
          `Onboarding ${project.title}: thread ${launched.threadId} started by ${lead.name} (${ONBOARDING_TEAM_ID}).`,
        );
      }),
    ),
  ),
);

const artifactsListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: projectFlag,
  archived: Flag.Boolean("archived").pipe(
    Flag.withDescription("List archived artifacts instead."),
    Flag.withDefault(false),
  ),
  query: Flag.String("query").pipe(Flag.withDescription("Match on the title."), Flag.optional),
  limit: Flag.Int("limit").pipe(Flag.withDefault(50)),
  before: Flag.String("before").pipe(
    Flag.withDescription("Only artifacts updated before this artifact id."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("List library artifacts, most recently updated first."),
  Command.withHandler((flags) =>
    withCommandCenter(flags, (context) =>
      Effect.gen(function* () {
        const projectId = yield* projectIdOf(context, flags.project);
        const page = yield* context.rpc[WS_METHODS.commandCenterListArtifacts]({
          limit: flags.limit,
          archived: flags.archived,
          ...(projectId === undefined ? {} : { projectId }),
          ...(Option.isSome(flags.query) ? { query: flags.query.value } : {}),
          ...(Option.isSome(flags.before)
            ? { before: CommandCenterArtifactId.make(flags.before.value) }
            : {}),
        });
        yield* printLines(page.artifacts.map(formatArtifactLine), "No artifacts.");
        const last = page.artifacts.at(-1);
        if (page.hasMore && last) yield* Console.log(`More: --before ${last.id}`);
      }),
    ),
  ),
);

const artifactsGetCommand = Command.make("get", {
  ...projectLocationFlags,
  id: Argument.String("id").pipe(Argument.withDescription("Artifact id.")),
  version: Flag.Int("version").pipe(
    Flag.withDescription("Version to read; the current one when omitted."),
    Flag.optional,
  ),
  out: Flag.String("out").pipe(
    Flag.withDescription("Write the content to this file instead of printing it."),
    Flag.optional,
  ),
  history: Flag.Boolean("history").pipe(
    Flag.withDescription("Print the version history instead of the content."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Print (or save with --out) one artifact version."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const detail = yield* withCommandCenter(flags, (context) =>
        context.rpc[WS_METHODS.commandCenterGetArtifact]({
          id: CommandCenterArtifactId.make(flags.id),
          ...(Option.isSome(flags.version) ? { version: flags.version.value } : {}),
          includeContent: !flags.history,
        }),
      );
      if (flags.history) {
        return yield* Console.log(
          [formatArtifactLine(detail.artifact), ...formatArtifactVersions(detail)].join("\n"),
        );
      }
      const content = detail.content ?? "";
      if (Option.isNone(flags.out)) return yield* Console.log(content);
      const target = path.resolve(flags.out.value);
      yield* fs
        .writeFileString(target, content)
        .pipe(Effect.mapError(fail(`Could not write ${target}.`)));
      yield* Console.log(`Wrote ${detail.artifact.title} v${detail.version.version} to ${target}.`);
    }),
  ),
);

const artifactsSaveCommand = Command.make("save", {
  ...projectLocationFlags,
  file: Argument.String("file").pipe(
    Argument.withDescription("HTML or Markdown file (.md / .markdown save as Markdown)."),
  ),
  id: Flag.String("id").pipe(
    Flag.withDescription("Save as a new version of this artifact instead of a new one."),
    Flag.optional,
  ),
  title: Flag.String("title").pipe(
    Flag.withDescription("Title; a new artifact otherwise takes the page's own title."),
    Flag.optional,
  ),
  project: projectFlag,
}).pipe(
  Command.withDescription("Save a file to the artifacts library, or as a new version with --id."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = path.resolve(flags.file);
      const content = yield* fs
        .readFileString(source)
        .pipe(Effect.mapError(fail(`Could not read ${source}.`)));
      if (content.trim().length === 0) return yield* fail(`${source} is empty.`)();
      const saved = yield* withCommandCenter(flags, (context) =>
        Effect.gen(function* () {
          const projectId = yield* projectIdOf(context, flags.project);
          const title = Option.getOrUndefined(flags.title)?.trim() || undefined;
          // A new artifact goes through import, which reads the kind from the file name and the
          // title from the page, the same path as dropping a file in the Artifacts tab.
          // A new version names the file's kind too, so the server refuses a .md saved onto an
          // HTML artifact instead of storing it as HTML.
          return yield* Option.isSome(flags.id)
            ? context.rpc[WS_METHODS.commandCenterSaveArtifact]({
                id: CommandCenterArtifactId.make(flags.id.value),
                kind: detectArtifactImport({ content, fileName: path.basename(source) }).kind,
                content,
                ...(title === undefined ? {} : { title }),
                ...(projectId === undefined ? {} : { projectId }),
              })
            : context.rpc[WS_METHODS.commandCenterImportArtifact]({
                content,
                fileName: path.basename(source),
                ...(title === undefined ? {} : { title }),
                ...(projectId === undefined ? {} : { projectId }),
              });
        }),
      );
      yield* Console.log(
        `Saved ${saved.artifact.title} v${saved.version.version} (${saved.artifact.id}).`,
      );
    }),
  ),
);

const ccArtifactsCommand = Command.make("artifacts").pipe(
  Command.withDescription("List, read and save artifacts in the Command Center library."),
  Command.withSubcommands([artifactsListCommand, artifactsGetCommand, artifactsSaveCommand]),
);

export const commandCenterCommand = Command.make("cc").pipe(
  Command.withDescription("Command Center on the running server."),
  Command.withSubcommands([ccSectionsCommand, ccOnboardCommand, ccArtifactsCommand]),
);
