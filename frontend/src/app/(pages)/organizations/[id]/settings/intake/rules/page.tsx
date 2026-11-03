"use client";

import { IntakeRulesPage } from "@/app/components/intake/IntakeRules";
import { useOrganizationSettings } from "@/app/components/organizations/OrganizationSettingsShell";
import { isOrgAdmin } from "@/app/lib/permissions";

/**
 * Who intake requests go to and how MikeGC preprocesses them: a table page
 * of its own, outside the sectioned frame, for owners and admins alone.
 */
export default function OrganizationIntakeRulesPage() {
  const { orgId, org } = useOrganizationSettings();
  return (
    <IntakeRulesPage orgId={orgId} allowed={!org || isOrgAdmin(org.role)} />
  );
}
