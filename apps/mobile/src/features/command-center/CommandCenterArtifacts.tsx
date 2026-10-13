import type {
  CommandCenterArtifact,
  CommandCenterArtifactId,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { htmlRenderFileName } from "@t3tools/shared/htmlRender";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useAssetUrlState } from "../../state/assets";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { FileMarkdownPreview } from "../files/FileMarkdownPreview";
import { SettingsSection } from "../settings/components/SettingsSection";
import { HtmlRenderWebView } from "../threads/HtmlRenderWebView";
import { artifactDetail } from "./commandCenterSummary";

const ARTIFACT_PAGE = 20;

/**
 * The environment's artifacts library, read-only. Nothing is fetched until the user opens the
 * list, and closing it ends the subscription.
 */
export function ArtifactsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly projectTitle: (id: ProjectId) => string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsSection title={props.title}>
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen((value) => !value)}
        className="px-4 py-3"
      >
        <Text className="text-base text-primary-text">
          {open ? "Hide artifacts" : "Show artifacts"}
        </Text>
      </Pressable>
      {open ? <ArtifactList {...props} /> : null}
    </SettingsSection>
  );
}

function ArtifactList(props: {
  readonly environmentId: EnvironmentId;
  readonly projectTitle: (id: ProjectId) => string;
}) {
  const live = useEnvironmentQuery(
    serverEnvironment.commandCenterArtifactsLive({
      environmentId: props.environmentId,
      input: { limit: ARTIFACT_PAGE },
    }),
  );
  const [openId, setOpenId] = useState<CommandCenterArtifactId | null>(null);
  const artifacts = live.data?.artifacts ?? [];
  const opened = artifacts.find((artifact) => artifact.id === openId) ?? null;

  if (live.error) return <Note text="Artifacts are unavailable on this machine." />;
  if (!live.data) return <Note text="Loading artifacts…" />;
  if (artifacts.length === 0) return <Note text="No artifacts yet. Ask an agent to save one." />;
  return (
    <>
      {artifacts.map((artifact) => (
        <Pressable
          key={artifact.id}
          accessibilityRole="button"
          onPress={() => setOpenId(artifact.id)}
          className="gap-0.5 border-t border-border-subtle px-4 py-3"
        >
          <Text className="text-base text-foreground" numberOfLines={1}>
            {artifact.title}
          </Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {artifactDetail(
              artifact,
              artifact.projectId === null ? null : props.projectTitle(artifact.projectId),
            )}
          </Text>
        </Pressable>
      ))}
      {live.data.hasMore ? (
        <Note text={`The ${ARTIFACT_PAGE} most recent. The desktop app lists them all.`} />
      ) : null}
      {opened ? (
        <ArtifactViewer
          environmentId={props.environmentId}
          artifact={opened}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </>
  );
}

function Note(props: { readonly text: string }) {
  return (
    <Text className="border-t border-border-subtle px-4 py-3 text-sm text-foreground-muted">
      {props.text}
    </Text>
  );
}

/** One artifact's current version, full screen. Follows new versions while it stays open. */
function ArtifactViewer(props: {
  readonly environmentId: EnvironmentId;
  readonly artifact: CommandCenterArtifact;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { environmentId, artifact } = props;
  const detail = useEnvironmentQuery(
    serverEnvironment.commandCenterArtifact({ environmentId, input: { id: artifact.id } }),
  );
  // The live list carries everyone's saves; a newer version there means the query is stale.
  const shownVersion = detail.data?.artifact.currentVersion ?? null;
  const { refresh } = detail;
  useEffect(() => {
    if (shownVersion !== null && shownVersion !== artifact.currentVersion) refresh();
  }, [artifact.currentVersion, refresh, shownVersion]);

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
              {artifact.title}
            </Text>
            <Text className="text-sm text-foreground-muted">
              Version {detail.data?.version.version ?? artifact.currentVersion}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={props.onClose}
            className="min-h-11 justify-center px-3"
          >
            <Text className="text-base text-primary-text">Done</Text>
          </Pressable>
        </View>
        {detail.error ? (
          <Text className="p-5 text-base text-foreground-muted">{detail.error}</Text>
        ) : !detail.data ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator />
          </View>
        ) : detail.data.artifact.kind === "markdown" ? (
          <FileMarkdownPreview
            cwd=""
            relativePath=""
            environmentId={environmentId}
            threadId={null}
            markdown={detail.data.content ?? ""}
            captured
          />
        ) : (
          <HtmlArtifact
            key={detail.data.version.attachmentId}
            environmentId={environmentId}
            attachmentId={detail.data.version.attachmentId}
            title={artifact.title}
          />
        )}
      </View>
    </Modal>
  );
}

/** An HTML version is stored with the html_render theme bootstrap, so it renders like one. */
function HtmlArtifact(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly title: string;
}) {
  const { attachmentId, title } = props;
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      fileName: htmlRenderFileName(title),
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId, title],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  // Signed URLs are re-minted periodically; following them would reload the page.
  const [uri, setUri] = useState<string | null>(null);
  if (uri === null && asset._tag === "Success") setUri(asset.url);
  const [failed, setFailed] = useState(false);

  if (failed || (uri === null && asset._tag === "Failure")) {
    return (
      <Text className="p-5 text-base text-foreground-muted">
        This page could not load. Open it on desktop.
      </Text>
    );
  }
  if (uri === null) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <HtmlRenderWebView uri={uri} title={title} nested={false} onLoadError={() => setFailed(true)} />
  );
}
