import { createFileRoute } from "@tanstack/react-router";
import { CommandCenterSettingsPanel } from "../components/settings/CommandCenterSettings";

export const Route = createFileRoute("/settings/command-center")({
  component: CommandCenterSettingsPanel,
});
