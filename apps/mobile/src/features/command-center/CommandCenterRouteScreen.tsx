import {
  threadShellKey,
  type CommandCenterAgentStatus,
} from "@t3tools/client-runtime/state/commandCenterDerive";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useEnvironments } from "../../state/environments";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  useSettingsEnvironmentFilter,
  type SettingsTarget,
} from "../settings/settings-environment-filter";
import { formatDue, summarizeCommandCenter } from "./commandCenterSummary";

const STATUS_LABEL: Record<CommandCenterAgentStatus, string> = {
  working: "Working",
  waiting: "Waiting on you",
  blocked: "Blocked",
  limited: "Usage limited",
  idle: "Idle",
};

const STATUS_CLASS: Record<CommandCenterAgentStatus, string> = {
  working: "text-primary",
  waiting: "text-warning-foreground",
  blocked: "text-danger-foreground",
  limited: "text-warning-foreground",
  idle: "text-foreground-muted",
};

/** Read-only Command Center summary: team status, what is missing, upcoming deliveries. */
export function CommandCenterRouteScreen() {
  const [now, setNow] = useState(Date.now);
  useFocusEffect(
    useCallback(() => {
      const updateNow = () => setNow(Date.now());
      updateNow();
      const timer = setInterval(updateNow, 60_000);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") updateNow();
      });
      return () => {
        clearInterval(timer);
        subscription.remove();
      };
    }, []),
  );
  const insets = useSafeAreaInsets();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const targets = availableTargets.filter(
    (target) => target.serverConfig.settings.commandCenter.enabled,
  );
  const shellList = useThreadShells();
  const shells = useMemo(
    () =>
      new Map<string, EnvironmentThreadShell>(
        shellList.map((shell) => [threadShellKey(shell.environmentId, shell.id), shell]),
      ),
    [shellList],
  );

  return (
    <SettingsScreen title="Command Center">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {targets.length === 0 ? (
          <Text className="p-4 text-base text-foreground-muted">
            No connected environment has Command Center turned on.
          </Text>
        ) : (
          targets.map((target) => (
            <EnvironmentSummary
              key={target.environmentId}
              target={target}
              shells={shells}
              now={now}
              showTitle={targets.length > 1}
            />
          ))
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function EnvironmentSummary({
  target,
  shells,
  now,
  showTitle,
}: {
  readonly target: SettingsTarget;
  readonly shells: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly now: number;
  readonly showTitle: boolean;
}) {
  const environmentId = target.environmentId;
  const navigation = useNavigation();
  // Summary scope: no memory or finance rows, and it never makes this server the home.
  const live = useEnvironmentQuery(
    serverEnvironment.commandCenterLive({ environmentId, input: { scope: "summary" } }),
  );
  const { environments } = useEnvironments();
  const projects = useProjects();
  const summary = useMemo(
    () => (live.data ? summarizeCommandCenter(live.data, shells, environmentId, now) : null),
    [environmentId, live.data, now, shells],
  );
  const machineLabel = (id: string) =>
    environments.find((environment) => environment.environmentId === id)?.label ??
    "Unknown machine";
  // Sections can belong to a project checked out on any machine.
  const projectTitle = (id: string) =>
    projects.find((project) => project.id === id)?.title ?? "Unknown project";

  // A machine that is not a Command Center home (or cannot be read) has nothing to show.
  if (live.error) return null;
  if (!summary || !live.data) {
    return (
      <SettingsSection title={target.label}>
        <Text className="p-4 text-base text-foreground-muted">Loading Command Center…</Text>
      </SettingsSection>
    );
  }
  if (summary.machines.length === 0 && live.data.sections.length === 0) return null;

  const missing: ReadonlyArray<{
    readonly key: string;
    readonly text: string;
    readonly detail: string | null;
    readonly onPress?: () => void;
  }> = [
    ...summary.waiting.map(({ agent, task, thread }) => ({
      key: `waiting:${agent.id}`,
      text: `${agent.name} is waiting on you`,
      detail: task,
      ...(thread
        ? {
            onPress: () =>
              navigation.navigate("Thread", {
                environmentId: String(thread.environmentId),
                threadId: String(thread.threadId),
              }),
          }
        : {}),
    })),
    ...summary.blocked.map((section) => ({
      key: `blocked:${section.id}`,
      text: `${section.name} is blocked`,
      detail: [projectTitle(section.projectId), section.blocker].filter(Boolean).join(" · "),
    })),
    ...summary.dueSoon.map(({ section, days }) => ({
      key: `due:${section.id}`,
      text: `${section.name} is ${formatDue(days)}`,
      detail: `${projectTitle(section.projectId)} · ${section.tasksDone}/${section.tasksTotal} tasks`,
    })),
  ];
  const prefix = showTitle ? `${target.label} · ` : "";

  return (
    <>
      <SettingsSection title={`${prefix}Team status`}>
        {summary.machines.length === 0 ? (
          <Row text="No agents yet." muted />
        ) : (
          summary.machines.map(({ environmentId: machine, agents }, machineIndex) => (
            <View
              key={machine}
              className={machineIndex === 0 ? "" : "border-t border-border-subtle"}
            >
              <Text className="px-4 pt-3 text-sm font-t3-medium text-foreground-muted">
                {machineLabel(machine)}
              </Text>
              {agents.map(({ agent, status, task }) => (
                <View key={agent.id} className="gap-0.5 px-4 py-2">
                  <View className="flex-row items-center justify-between gap-3">
                    <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
                      {agent.name}
                      <Text className="text-sm text-foreground-muted"> · {agent.role}</Text>
                    </Text>
                    <Text className={`text-sm ${STATUS_CLASS[status]}`}>
                      {STATUS_LABEL[status]}
                    </Text>
                  </View>
                  {task ? (
                    <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                      {task}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          ))
        )}
      </SettingsSection>

      <SettingsSection title={`${prefix}What's missing`}>
        {missing.length === 0 ? (
          <Row text="Nothing is waiting on you." muted />
        ) : (
          missing.map((item, index) => (
            <Row
              key={item.key}
              text={item.text}
              detail={item.detail}
              divided={index > 0}
              {...(item.onPress ? { onPress: item.onPress } : {})}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection title={`${prefix}Upcoming deliveries`}>
        {summary.upcoming.length === 0 ? (
          <Row text="No deliveries after this week." muted />
        ) : (
          summary.upcoming.map(({ section, days }, index) => (
            <Row
              key={section.id}
              text={`${section.name} · ${formatDue(days)}`}
              detail={`${projectTitle(section.projectId)} · ${section.dueDate} · ${section.tasksDone}/${section.tasksTotal} tasks`}
              divided={index > 0}
            />
          ))
        )}
      </SettingsSection>
    </>
  );
}

function Row(props: {
  readonly text: string;
  readonly detail?: string | null;
  readonly muted?: boolean;
  readonly divided?: boolean;
  /** Makes the row a button, such as opening the thread that waits on the user. */
  readonly onPress?: () => void;
}) {
  return (
    <Pressable
      disabled={!props.onPress}
      {...(props.onPress ? { onPress: props.onPress, accessibilityRole: "button" as const } : {})}
      className={
        props.divided ? "gap-0.5 border-t border-border-subtle px-4 py-3" : "gap-0.5 px-4 py-3"
      }
    >
      <Text
        className={props.muted ? "text-base text-foreground-muted" : "text-base text-foreground"}
      >
        {props.text}
      </Text>
      {props.detail ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={2}>
          {props.detail}
        </Text>
      ) : null}
    </Pressable>
  );
}
