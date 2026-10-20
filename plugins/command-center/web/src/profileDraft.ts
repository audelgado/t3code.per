import type { ProfileInput } from "../../server/profiles.ts";
import { RUNTIME_MODES } from "./look.ts";

/** Los campos opcionales del perfil pueden pasar de definidos a nulos al editar. */
export function isProfileDraft(value: unknown): value is ProfileInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  const model = profile.model;
  return typeof profile.name === "string"
    && (profile.avatar === undefined || typeof profile.avatar === "string")
    && (profile.rolePrompt === undefined || typeof profile.rolePrompt === "string")
    && (model == null || typeof model === "object" && !Array.isArray(model)
      && "instanceId" in model && typeof model.instanceId === "string"
      && "model" in model && typeof model.model === "string")
    && (profile.runtimeMode == null || RUNTIME_MODES.some(([mode]) => mode === profile.runtimeMode))
    && (profile.interactionMode == null || profile.interactionMode === "default" || profile.interactionMode === "plan");
}
