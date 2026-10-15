import { WorkTab } from "./WorkTab";
/** Phone work uses the same capped status and reversible actions as desktop. */
export function WorkQuickSwitch() {
  return <WorkTab quickSwitch />;
}
