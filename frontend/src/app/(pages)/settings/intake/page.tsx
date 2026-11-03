"use client";

import { IntakeSettings } from "@/app/components/intake/IntakeSettings";
import {
    PERSONAL_WORKSPACE,
    useWorkspace,
} from "@/app/contexts/WorkspaceContext";

/** Automated intake for Personal, whose owner is its only member. */
export default function PersonalIntakeSettingsPage() {
    const { accountId } = useWorkspace();
    if (!accountId) return null;
    return <IntakeSettings key={accountId} orgId={PERSONAL_WORKSPACE} />;
}
