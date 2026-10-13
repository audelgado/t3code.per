import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  CommandCenterWorkflowNodeId,
  CommandCenterWorkflowRun,
  CommandCenterWorkflowRunId,
  CommandCenterWorkflowStep,
  CommandCenterWorkflowSummary,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  TextInput as RNTextInput,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { relativeTime } from "../../lib/time";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  canResumeRun,
  canStopRun,
  mergeRunSteps,
  RUN_STATUS_LABEL,
  STEP_STATUS_LABEL,
  workflowStartInputs,
  type WorkflowStepPrompt,
  workflowStepRows,
} from "./workflowPresentation";

const RECENT_RUNS = 10;
const NO_STEPS: ReadonlyArray<CommandCenterWorkflowStep> = [];

const failure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    Alert.alert(title, String(squashAtomCommandFailure(result)));
  }
};

/**
 * Workflows of this environment's projects. Nothing is subscribed until the user opens a
 * project, and only that project's workflow files and runs are followed.
 */
export function WorkflowsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
}) {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const projects = useProjects().filter((project) => project.environmentId === props.environmentId);
  if (projects.length === 0) return null;
  return (
    <SettingsSection title={props.title}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen((value) => !value)}
        className="px-4 py-3"
      >
        <Text className="text-base text-primary-text">
          {open ? "Hide workflows" : "Show workflows"}
        </Text>
      </Pressable>
      {open
        ? projects.map((project) => (
            <View key={project.id}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setProjectId(projectId === project.id ? null : project.id)}
                className="flex-row items-center justify-between gap-3 border-t border-border-subtle px-4 py-3"
              >
                <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
                  {project.title}
                </Text>
                <Text className="text-sm text-foreground-muted">
                  {projectId === project.id ? "Hide" : "Open"}
                </Text>
              </Pressable>
              {projectId === project.id ? (
                <ProjectWorkflows environmentId={props.environmentId} projectId={project.id} />
              ) : null}
            </View>
          ))
        : null}
    </SettingsSection>
  );
}

function ProjectWorkflows(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const { environmentId, projectId } = props;
  const workflows = useEnvironmentQuery(
    serverEnvironment.commandCenterWorkflowsLive({ environmentId, input: { projectId } }),
  );
  const runs = useEnvironmentQuery(
    serverEnvironment.commandCenterWorkflowRunsLive({ environmentId, input: { projectId } }),
  );
  const [starting, setStarting] = useState<CommandCenterWorkflowSummary | null>(null);
  const [openRunId, setOpenRunId] = useState<CommandCenterWorkflowRunId | null>(null);
  const recent = (runs.data?.runs ?? []).slice(0, RECENT_RUNS);

  return (
    <View className="pl-4">
      {workflows.error ? (
        <Note text={workflows.error} />
      ) : !workflows.data ? (
        <Note text="Loading workflows…" />
      ) : workflows.data.workflows.length === 0 ? (
        <Note text="No workflows yet. Save one from desktop or ask an agent." />
      ) : (
        workflows.data.workflows.map((workflow) => (
          <Pressable
            key={workflow.slug}
            accessibilityRole="button"
            disabled={workflow.error !== null}
            onPress={() => setStarting(workflow)}
            className="gap-0.5 border-t border-border-subtle px-4 py-3"
          >
            <Text className="text-base text-foreground" numberOfLines={1}>
              {workflow.title}
            </Text>
            <Text
              className={
                workflow.error ? "text-sm text-danger-foreground" : "text-sm text-foreground-muted"
              }
              numberOfLines={2}
            >
              {workflow.error ??
                (workflow.description ||
                  `${workflow.nodeCount} step${workflow.nodeCount === 1 ? "" : "s"}`)}
            </Text>
          </Pressable>
        ))
      )}

      <Text className="border-t border-border-subtle px-4 pt-3 text-sm font-t3-medium text-foreground-muted">
        Recent runs
      </Text>
      {runs.error ? (
        <Note text={runs.error} />
      ) : !runs.data ? (
        <Note text="Loading runs…" />
      ) : recent.length === 0 ? (
        <Note text="No runs yet." />
      ) : (
        recent.map((run) => (
          <Pressable
            key={run.id}
            accessibilityRole="button"
            onPress={() => setOpenRunId(run.id)}
            className="gap-0.5 px-4 py-2"
          >
            <Text className="text-base text-foreground" numberOfLines={1}>
              {run.title}
            </Text>
            <Text className="text-sm text-foreground-muted" numberOfLines={1}>
              {RUN_STATUS_LABEL[run.status]} · {relativeTime(run.startedAt)} ago
            </Text>
          </Pressable>
        ))
      )}

      {starting ? (
        <StartWorkflowModal
          environmentId={environmentId}
          projectId={projectId}
          workflow={starting}
          onClose={() => setStarting(null)}
          onStarted={(run) => {
            setStarting(null);
            setOpenRunId(run.id);
          }}
        />
      ) : null}
      {openRunId ? (
        <RunModal
          environmentId={environmentId}
          runId={openRunId}
          liveRun={runs.data?.runs.find((run) => run.id === openRunId) ?? null}
          liveSteps={runs.data?.steps ?? NO_STEPS}
          onClose={() => setOpenRunId(null)}
        />
      ) : null}
    </View>
  );
}

function Note(props: { readonly text: string }) {
  return (
    <Text className="border-t border-border-subtle px-4 py-3 text-sm text-foreground-muted">
      {props.text}
    </Text>
  );
}

function ModalFrame(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={props.onClose}
    >
      <View
        className="flex-1 bg-sheet"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="flex-row items-center justify-between gap-3 px-5 py-3">
          <View className="min-w-0 flex-1">
            <Text className="text-lg font-t3-semibold text-foreground" numberOfLines={1}>
              {props.title}
            </Text>
            <Text className="text-sm text-foreground-muted" numberOfLines={1}>
              {props.subtitle}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={props.onClose}
            className="min-h-11 justify-center px-3"
          >
            <Text className="text-base text-primary-text">{props.closeLabel}</Text>
          </Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-3 px-5 pb-6">
          {props.children}
        </ScrollView>
      </View>
    </Modal>
  );
}

function ActionButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-11 justify-center"
    >
      <Text
        className={
          props.disabled ? "text-base text-foreground-muted" : "text-base text-primary-text"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** Fills the workflow's inputs and starts a run on the project's environment. */
function StartWorkflowModal(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workflow: CommandCenterWorkflowSummary;
  readonly onClose: () => void;
  readonly onStarted: (run: CommandCenterWorkflowRun) => void;
}) {
  const { environmentId, projectId, workflow } = props;
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const canOperate = useAtomValue(
    serverEnvironment.startCommandCenterWorkflowRun.permissionAtom(environmentId),
  );
  const start = useAtomCommand(serverEnvironment.startCommandCenterWorkflowRun, {
    label: "workflow run start",
    reportFailure: false,
  });

  const submit = async () => {
    const { inputs, missing } = workflowStartInputs(workflow.inputs, values);
    if (missing.length > 0) {
      Alert.alert("Missing inputs", `Fill in ${missing.join(", ")}.`);
      return;
    }
    setBusy(true);
    const result = await start({
      environmentId,
      input: { projectId, slug: workflow.slug, inputs },
    });
    setBusy(false);
    if (result._tag === "Success") props.onStarted(result.value);
    else failure("Could not start the workflow", result);
  };

  return (
    <ModalFrame
      title={workflow.title}
      subtitle={`${workflow.nodeCount} step${workflow.nodeCount === 1 ? "" : "s"}`}
      closeLabel="Cancel"
      onClose={props.onClose}
    >
      {workflow.description ? (
        <Text className="text-base text-foreground-muted">{workflow.description}</Text>
      ) : null}
      {workflow.inputs.map((input) => (
        <View key={input.name} className="gap-1">
          <Text className="text-sm text-foreground-muted">{input.label}</Text>
          <RNTextInput
            accessibilityLabel={input.label}
            value={values[input.name] ?? ""}
            onChangeText={(value) => setValues((current) => ({ ...current, [input.name]: value }))}
            multiline
            placeholder={input.default ?? "Required"}
            placeholderTextColorClassName="accent-foreground-muted"
            className="min-h-11 rounded-lg border border-border-subtle px-3 py-2 font-sans text-base text-foreground"
          />
        </View>
      ))}
      {canOperate ? null : (
        <Text className="text-sm text-foreground-muted">
          This device cannot start runs on this environment.
        </Text>
      )}
      <ActionButton
        label={busy ? "Starting…" : "Start run"}
        disabled={!canOperate || busy}
        onPress={() => void submit()}
      />
    </ModalFrame>
  );
}

/** A waiting ask (its choices, or a typed answer) or manual gate (approve or reject, with a note). */
function StepAnswer(props: {
  readonly prompt: WorkflowStepPrompt;
  readonly nodeId: CommandCenterWorkflowNodeId;
  readonly disabled: boolean;
  readonly onAnswer: (reply: {
    readonly nodeId: CommandCenterWorkflowNodeId;
    readonly input: { readonly answer?: string; readonly approved?: boolean };
  }) => Promise<void>;
}) {
  const { prompt, nodeId } = props;
  const [text, setText] = useState("");
  const send = (input: { readonly answer?: string; readonly approved?: boolean }) =>
    void props.onAnswer({ nodeId, input });
  const note = text.trim();
  return (
    <View className="gap-1">
      <Text className="text-sm text-warning-foreground">
        {prompt.kind === "ask" ? prompt.question : "Approve this step to continue the run."}
      </Text>
      {prompt.kind === "ask" && prompt.choices.length > 0 ? (
        prompt.choices.map((choice) => (
          <ActionButton
            key={choice}
            label={choice}
            disabled={props.disabled}
            onPress={() => send({ answer: choice })}
          />
        ))
      ) : (
        <>
          <RNTextInput
            accessibilityLabel={prompt.kind === "ask" ? "Your answer" : "Note (optional)"}
            value={text}
            onChangeText={setText}
            multiline
            placeholder={prompt.kind === "ask" ? "Your answer" : "Note (optional)"}
            placeholderTextColorClassName="accent-foreground-muted"
            className="min-h-11 rounded-lg border border-border-subtle px-3 py-2 font-sans text-base text-foreground"
          />
          {prompt.kind === "ask" ? (
            <ActionButton
              label="Answer"
              disabled={props.disabled || note === ""}
              onPress={() => send({ answer: note })}
            />
          ) : (
            <View className="flex-row gap-6">
              <ActionButton
                label="Approve"
                disabled={props.disabled}
                onPress={() => send({ approved: true, ...(note === "" ? {} : { answer: note }) })}
              />
              <ActionButton
                label="Reject"
                disabled={props.disabled}
                onPress={() => send({ approved: false, ...(note === "" ? {} : { answer: note }) })}
              />
            </View>
          )}
        </>
      )}
    </View>
  );
}

/**
 * One run's steps. The run query gives the workflow and every step; the live feed keeps steps
 * current while the run moves, so the query is only refetched when the run's status changes.
 */
function RunModal(props: {
  readonly environmentId: EnvironmentId;
  readonly runId: CommandCenterWorkflowRunId;
  readonly liveRun: CommandCenterWorkflowRun | null;
  readonly liveSteps: ReadonlyArray<CommandCenterWorkflowStep>;
  readonly onClose: () => void;
}) {
  const { environmentId, runId, liveRun } = props;
  const navigation = useNavigation();
  const detail = useEnvironmentQuery(
    serverEnvironment.commandCenterWorkflowRun({ environmentId, input: { runId } }),
  );
  const run = liveRun ?? detail.data?.run ?? null;
  const fetchedStatus = detail.data?.run.status ?? null;
  const { refresh } = detail;
  useEffect(() => {
    if (fetchedStatus !== null && liveRun !== null && fetchedStatus !== liveRun.status) refresh();
  }, [fetchedStatus, liveRun, refresh]);

  const steps = useMemo(
    () => mergeRunSteps(runId, detail.data?.steps ?? NO_STEPS, props.liveSteps),
    [detail.data?.steps, props.liveSteps, runId],
  );
  const rows = useMemo(
    () => (detail.data ? workflowStepRows(detail.data.workflow, steps) : []),
    [detail.data, steps],
  );

  const canOperate = useAtomValue(
    serverEnvironment.stopCommandCenterWorkflowRun.permissionAtom(environmentId),
  );
  const options = { reportFailure: false } as const;
  const stop = useAtomCommand(serverEnvironment.stopCommandCenterWorkflowRun, options);
  const resume = useAtomCommand(serverEnvironment.resumeCommandCenterWorkflowRun, options);
  const retry = useAtomCommand(serverEnvironment.retryCommandCenterWorkflowStep, options);
  const answer = useAtomCommand(serverEnvironment.answerCommandCenterWorkflowStep, options);
  const [busy, setBusy] = useState(false);
  const act = async (title: string, send: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setBusy(true);
    const result = await send();
    setBusy(false);
    failure(title, result);
  };

  return (
    <ModalFrame
      title={run?.title ?? "Workflow run"}
      subtitle={
        run ? `${RUN_STATUS_LABEL[run.status]} · started ${relativeTime(run.startedAt)} ago` : ""
      }
      closeLabel="Done"
      onClose={props.onClose}
    >
      {run?.error ? <Text className="text-sm text-danger-foreground">{run.error}</Text> : null}
      {run && (canStopRun(run) || canResumeRun(run)) ? (
        <ActionButton
          label={canStopRun(run) ? "Stop run" : "Resume run"}
          disabled={!canOperate || busy}
          onPress={() =>
            void (canStopRun(run)
              ? act("Could not stop the run", () => stop({ environmentId, input: { runId } }))
              : act("Could not resume the run", () => resume({ environmentId, input: { runId } })))
          }
        />
      ) : null}
      {detail.error ? (
        <Text className="text-base text-foreground-muted">{detail.error}</Text>
      ) : !detail.data ? (
        <ActivityIndicator />
      ) : (
        rows.map((row) => {
          const threadId = row.step?.threadId ?? null;
          const retryInput = row.retry;
          return (
            <View
              key={row.key}
              className={
                row.depth === 1
                  ? "gap-1 border-t border-border-subtle py-2 pl-4"
                  : "gap-1 border-t border-border-subtle py-2"
              }
            >
              <Pressable
                {...(threadId ? { accessibilityRole: "button" as const } : {})}
                disabled={!threadId}
                onPress={() => {
                  if (!threadId) return;
                  props.onClose();
                  navigation.navigate("Thread", {
                    environmentId: String(environmentId),
                    threadId: String(threadId),
                  });
                }}
                className="gap-0.5"
              >
                <View className="flex-row items-center justify-between gap-3">
                  <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
                    {row.title}
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    {row.step ? STEP_STATUS_LABEL[row.step.status] : "Not started"}
                  </Text>
                </View>

                {row.step?.error ? (
                  <Text className="text-sm text-danger-foreground" numberOfLines={3}>
                    {row.step.error}
                  </Text>
                ) : row.step?.output ? (
                  <Text className="text-sm text-foreground-muted" numberOfLines={3}>
                    {row.step.output}
                  </Text>
                ) : null}
                {threadId ? <Text className="text-sm text-primary-text">Open thread</Text> : null}
              </Pressable>
              {row.waiting && row.step ? (
                <StepAnswer
                  prompt={row.waiting}
                  disabled={!canOperate || busy}
                  onAnswer={(reply) =>
                    act("Could not answer the step", () =>
                      answer({
                        environmentId,
                        input: { runId, nodeId: reply.nodeId, ...reply.input },
                      }),
                    )
                  }
                  nodeId={row.step.nodeId}
                />
              ) : null}
              {retryInput ? (
                <ActionButton
                  label="Retry step"
                  disabled={!canOperate || busy}
                  onPress={() =>
                    void act("Could not retry the step", () =>
                      retry({ environmentId, input: retryInput }),
                    )
                  }
                />
              ) : null}
            </View>
          );
        })
      )}
    </ModalFrame>
  );
}
