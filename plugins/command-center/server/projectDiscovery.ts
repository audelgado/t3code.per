import { posix, win32 } from "node:path";
import { HttpError, type Route } from "./http.ts";
import type { FileLink } from "./t3link.ts";
import type { ProjectRow, T3Link } from "./types.ts";

export interface DiscoveryResult {
  projects: { path: string; title: string; registered: boolean; evidence: string[] }[];
  hasMore: boolean;
  errors: { path: string; message: string }[];
}
declare module "./types.ts" {
  interface Api {
    "POST /api/project-discovery": { body: { machineId: string; root: string }; res: DiscoveryResult };
  }
}
const windowsPath = (path: string) => /^[a-z]:[\\/]|^\\\\/i.test(path);
const canonical = (path: string) => windowsPath(path) ? win32.normalize(path).replace(/[\\/]$/, "").toLowerCase() : posix.normalize(path).replace(/\/$/, "");
const manifests = new Set(["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "Gemfile", "requirements.txt", "mix.exs", "pubspec.yaml"]);

/** Inventory only: one explicitly chosen parent and at most forty immediate child folders. */
export function createProjectDiscovery(deps: { projects: () => ProjectRow[]; link: (id: string) => (T3Link & Partial<FileLink>) | undefined }): { routes: Route[] } {
  const routes: Route[] = [{ method: "POST", path: "/api/project-discovery", auth: "cookie", handler: async ({ body }) => {
    const input = body as { machineId?: unknown; root?: unknown } | null;
    if (!input || typeof input.machineId !== "string" || !input.machineId.trim() || typeof input.root !== "string") throw new HttpError(400, "bad_request", "Elegí un sistema y una carpeta absoluta");
    const root = input.root.trim();
    if (!root || root.length > 500 || /[\x00-\x1f]/.test(root) || root.split(/[\\/]/).includes("..") || (!root.startsWith("/") && !windowsPath(root))) throw new HttpError(400, "bad_request", "La carpeta debe ser una ruta absoluta, sin segmentos ..");
    const link = deps.link(input.machineId);
    if (link?.state.status !== "online" || !link.listEntries) throw new HttpError(409, "conflict", "El sistema debe estar en línea y permitir lectura de carpetas");
    const list = link.listEntries.bind(link);
    const result: DiscoveryResult = { projects: [], hasMore: false, errors: [] };
    let children;
    try { children = await list(root, ""); }
    catch (e) { throw new HttpError(409, "conflict", `No se pudo leer la carpeta: ${e instanceof Error ? e.message : "revisá acceso y permiso filesystem:read"}`); }
    const names = [...new Set(children.filter((entry) => entry.kind === "directory" && !entry.path.startsWith(".") && !/[\\/\x00-\x1f]/.test(entry.path) && entry.path !== "..").map((entry) => entry.path))];
    result.hasMore = names.length > 40;
    const bounded = names.slice(0, 40);
    const paths = windowsPath(root) ? win32 : posix;
    const existing = deps.projects().filter((project) => project.machineId === input.machineId);
    for (let offset = 0; offset < bounded.length; offset += 4) {
      const batch = await Promise.all(bounded.slice(offset, offset + 4).map(async (name) => {
        const path = paths.join(root, name);
        try {
          const entries = await list(path, "");
          const markers = entries.filter((entry) => entry.path === ".git" || (entry.kind === "file" && manifests.has(entry.path)));
          if (!markers.length) return null;
          const evidence = [...new Set([...markers.map((entry) => entry.path), ...entries.filter((entry) => entry.kind === "file" && /^(?:PRD|README)\.md$/i.test(entry.path)).map((entry) => entry.path)])];
          const registered = existing.find((project) => canonical(project.workspaceRoot) === canonical(path));
          return { path, title: registered?.title ?? name, registered: Boolean(registered), evidence };
        } catch (error) {
          result.errors.push({ path, message: error instanceof Error ? error.message : "No se pudo leer la carpeta" });
          return null;
        }
      }));
      result.projects.push(...batch.filter((project) => project !== null));
    }
    return result;
  } }];
  return { routes };
}
