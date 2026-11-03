"use client";

import { IntakeRulesPage } from "@/app/components/intake/IntakeRules";
import { PERSONAL_WORKSPACE } from "@/app/contexts/WorkspaceContext";

/** Personal's intake rules: a table page outside the Settings frame. */
export default function PersonalIntakeRulesPage() {
    return <IntakeRulesPage orgId={PERSONAL_WORKSPACE} />;
}
