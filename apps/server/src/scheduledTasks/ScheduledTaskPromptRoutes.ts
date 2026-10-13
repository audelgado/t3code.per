import type { ProjectId, ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/** A scheduled task's run, before it starts a thread. */
export interface ScheduledPrompt {
  readonly projectId: ProjectId;
  readonly prompt: string;
  /** The task's modes: anything a route starts runs no broader than these. */
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** Runs a prompt it recognizes and returns true, or returns false to let the task start a thread. */
export type ScheduledPromptRoute = (
  prompt: ScheduledPrompt,
) => Effect.Effect<boolean, { readonly message: string }>;

/**
 * Lets a service built above the scheduled tasks (Command Center's workflow runner, for
 * `/wf <slug>` prompts) take a task's run without the task service depending on it. Routes
 * register when their service is built; the task service asks them when a task fires.
 */
export class ScheduledTaskPromptRoutes extends Context.Service<
  ScheduledTaskPromptRoutes,
  {
    readonly register: (route: ScheduledPromptRoute) => Effect.Effect<void>;
    /** True when a route ran the prompt. */
    readonly route: (
      prompt: ScheduledPrompt,
    ) => Effect.Effect<boolean, { readonly message: string }>;
  }
>()("t3/scheduledTasks/ScheduledTaskPromptRoutes") {}

export const layer = Layer.effect(
  ScheduledTaskPromptRoutes,
  Effect.gen(function* () {
    const routes = yield* Ref.make<ReadonlyArray<ScheduledPromptRoute>>([]);
    return ScheduledTaskPromptRoutes.of({
      register: (route) => Ref.update(routes, (current) => [...current, route]),
      route: (prompt) =>
        Effect.gen(function* () {
          for (const route of yield* Ref.get(routes)) {
            if (yield* route(prompt)) return true;
          }
          return false;
        }),
    });
  }),
);
