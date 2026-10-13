import type { CommandCenterArtifact, EnvironmentId } from "@t3tools/contracts";
import { FileCodeIcon, FileTextIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

/**
 * A card's preview image. It asks for the thumbnail only once the card scrolls near view, since
 * the server captures one per version on first request; with no preview browser it stays an icon.
 */
export function ArtifactThumbnail({
  environmentId,
  artifact,
}: {
  readonly environmentId: EnvironmentId;
  readonly artifact: CommandCenterArtifact;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (seen || element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  const thumbnail = useEnvironmentQuery(
    seen
      ? serverEnvironment.commandCenterArtifactThumbnail({
          environmentId,
          input: { id: artifact.id, version: artifact.currentVersion },
        })
      : null,
  );
  const attachmentId = thumbnail.data?.attachmentId ?? null;
  const resource = useMemo(
    () =>
      attachmentId === null
        ? null
        : {
            _tag: "attachment" as const,
            attachmentId,
            mimeType: "image/webp",
            disposition: "inline" as const,
          },
    [attachmentId],
  );
  const url = useAssetUrlState(resource === null ? null : environmentId, resource);
  const Icon = artifact.kind === "html" ? FileCodeIcon : FileTextIcon;
  return (
    <div
      ref={ref}
      className="flex aspect-[16/10] items-center justify-center overflow-hidden border-b bg-muted/40"
    >
      {url._tag === "Success" ? (
        <img src={url.url} alt="" loading="lazy" className="size-full object-cover object-top" />
      ) : (
        <Icon aria-hidden className="size-6 text-muted-foreground" />
      )}
    </div>
  );
}
