import { IntakeSettingsRedirect } from "@/app/components/intake/IntakeSettingsRedirect";
/** Intake's settings are in the workspace's settings now. */
export default function Page() {
  return <IntakeSettingsRedirect to="settings" />;
}
