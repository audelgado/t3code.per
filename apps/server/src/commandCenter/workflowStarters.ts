import { parseCommandCenterWorkflow, type CommandCenterWorkflow } from "@t3tools/contracts";

import bugfix from "./workflowStarters/bugfix.json" with { type: "json" };
import feature from "./workflowStarters/feature.json" with { type: "json" };
import onboarding from "./workflowStarters/onboarding.json" with { type: "json" };
import releaseNotes from "./workflowStarters/release-notes.json" with { type: "json" };
import weeklyDigest from "./workflowStarters/weekly-digest.json" with { type: "json" };

/** Raw starter files, in the order the library shows them. Tests check each one parses. */
export const WORKFLOW_STARTER_FILES: ReadonlyArray<unknown> = [
  onboarding,
  feature,
  bugfix,
  releaseNotes,
  weeklyDigest,
];

/** The built-in workflows a user can copy into a project. */
export const WORKFLOW_STARTERS: ReadonlyArray<CommandCenterWorkflow> =
  WORKFLOW_STARTER_FILES.flatMap((file) => {
    const { workflow } = parseCommandCenterWorkflow(file);
    return workflow === null ? [] : [workflow];
  });
