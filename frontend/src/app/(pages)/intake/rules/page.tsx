import { IntakeSettingsRedirect } from "@/app/components/intake/IntakeSettingsRedirect";
/** Intake's rules are in the workspace's settings now. */
export default function Page() {
  return <IntakeSettingsRedirect to="rules" />;
}
