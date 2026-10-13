import type { CommandCenterArtifactKind } from "@t3tools/contracts";

// Kept apart from ArtifactsService so the CLI can read a file's kind without loading the service.

const HTML_START =
  /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html|head|body|svg|div|main|section|style|script|meta|link|title)\b/i;
const HTML_EXTENSIONS: ReadonlySet<string> = new Set(["html", "htm", "svg", "xhtml"]);
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown", "mdx", "txt"]);

const plainTitle = (text: string | undefined) =>
  text
    ?.replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) =>
      entity === "amp"
        ? "&"
        : entity === "lt"
          ? "<"
          : entity === "gt"
            ? ">"
            : entity === "quot"
              ? '"'
              : "'",
    )
    .replace(/\s+/g, " ")
    .trim();

/**
 * Kind and title for an imported page. Kind follows the file extension, else whether the text
 * starts like an HTML document. Title: the given one, the page's `<title>` / first `<h1>` or the
 * first Markdown heading, the file name, then "Imported artifact".
 */
export function detectArtifactImport(input: {
  readonly content: string;
  readonly fileName?: string | undefined;
  readonly title?: string | undefined;
}): { readonly kind: CommandCenterArtifactKind; readonly title: string } {
  const extension = /\.([a-z0-9]+)$/i.exec(input.fileName ?? "")?.[1]?.toLowerCase();
  const kind: CommandCenterArtifactKind =
    extension !== undefined && HTML_EXTENSIONS.has(extension)
      ? "html"
      : extension !== undefined && MARKDOWN_EXTENSIONS.has(extension)
        ? "markdown"
        : HTML_START.test(input.content)
          ? "html"
          : "markdown";
  const found =
    kind === "html"
      ? (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(input.content)?.[1] ??
        /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(input.content)?.[1])
      : /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(input.content)?.[1];
  const title = [
    input.title?.trim(),
    plainTitle(found),
    input.fileName?.replace(/\.[^.]+$/, "").trim(),
  ].find((candidate) => candidate !== undefined && candidate.length > 0);
  return { kind, title: (title ?? "Imported artifact").slice(0, 200) };
}
