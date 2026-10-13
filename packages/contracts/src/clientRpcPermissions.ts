import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput } from "./git.ts";
import {
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  // Endpoint checks exist to configure exports, so they need the same grant as saving them.
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterSetMemoryDone]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterBuildRepoDigest]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterEnsureOnboardingTeam]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterSetSectionPullRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterSaveArtifact]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterImportArtifact]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterRestoreArtifactVersion]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterSetArtifactArchived]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterUpsertCanvasItems]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterUpsertCanvasEdges]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterDeleteCanvasEntries]: AuthOrchestrationOperateScope,
  // Workflows, snippets and skills are files in the project, written like any project file.
  [WS_METHODS.commandCenterSaveWorkflow]: AuthFilesystemWriteScope,
  [WS_METHODS.commandCenterDeleteWorkflow]: AuthFilesystemWriteScope,
  [WS_METHODS.commandCenterRestoreWorkflow]: AuthFilesystemWriteScope,
  [WS_METHODS.commandCenterSaveSnippet]: AuthFilesystemWriteScope,
  [WS_METHODS.commandCenterDeleteSnippet]: AuthFilesystemWriteScope,
  [WS_METHODS.commandCenterRestoreSnippet]: AuthFilesystemWriteScope,
  [WS_METHODS.commandCenterCreateSkill]: AuthFilesystemWriteScope,
  [WS_METHODS.commandCenterUpdateSkill]: AuthFilesystemWriteScope,
  [WS_METHODS.commandCenterDeleteSkill]: AuthFilesystemWriteScope,
  [WS_METHODS.commandCenterRestoreSkill]: AuthFilesystemWriteScope,
  // Spends model tokens, like starting a turn.
  [WS_METHODS.commandCenterRewriteText]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterStartWorkflowRun]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterStopWorkflowRun]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterRetryWorkflowStep]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterResumeWorkflowRun]: AuthOrchestrationOperateScope,
  [WS_METHODS.commandCenterAnswerWorkflowStep]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
