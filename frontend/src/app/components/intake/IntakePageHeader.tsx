"use client";

import { useRouter } from "next/navigation";
import { Settings } from "lucide-react";
import {
  PageHeader,
  type PageHeaderAction,
} from "@/app/components/shared/PageHeader";
import {
  PERSONAL_WORKSPACE,
  useWorkspace,
} from "@/app/contexts/WorkspaceContext";
import { isOrgAdmin } from "@/app/lib/permissions";
import {
  INTAKE_DASHBOARD_PATH,
  INTAKE_REQUESTS_PATH,
  intakeSettingsHref,
} from "./intakeQuery";

export type IntakePage = "requests" | "dashboard";

const PAGES: { page: IntakePage; label: string; href: string }[] = [
  { page: "requests", label: "Requests", href: INTAKE_REQUESTS_PATH },
  { page: "dashboard", label: "Dashboard", href: INTAKE_DASHBOARD_PATH },
];

/**
 * Whether the viewer may change automated intake: an organization's owners
 * and admins, and in Personal its owner, who is the only member.
 */
export function useCanManageIntake() {
  const { workspaceId, activeOrganization } = useWorkspace();
  return (
    workspaceId === PERSONAL_WORKSPACE || isOrgAdmin(activeOrganization?.role)
  );
}

/**
 * The Intake pages' header: Intake › the page as breadcrumbs, buttons that
 * switch between the requests list and the dashboard, then the page's own
 * actions, for those who may change it a way to automated intake's settings
 * (in the workspace's settings), and on the requests list, New request.
 */
export function IntakePageHeader({
  page,
  actions = [],
}: {
  page: IntakePage;
  /** Shown before New request, such as the list's search. */
  actions?: PageHeaderAction[];
}) {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const canManage = useCanManageIntake();
  const current = PAGES.find((item) => item.page === page)!;
  return (
    <>
      {/* Breadcrumbs are not a heading; this names the page for assistive technology. */}
      <h1 className="sr-only">{`Intake: ${current.label}`}</h1>
      <PageHeader
        breadcrumbs={[
          {
            label: "Intake",
            title: "Intake",
            // Intake opens on its requests, so from there it would only reset the list.
            onClick:
              page === "requests"
                ? undefined
                : () => router.push(INTAKE_REQUESTS_PATH),
          },
          { label: current.label, title: current.label },
        ]}
        actionGroups={[
          PAGES.map((item) => ({
            title: item.label,
            label: item.label,
            pressed: page === item.page,
            onClick: () => {
              if (page !== item.page) router.push(item.href);
            },
          })),
          [
            ...actions,
            canManage &&
              !!workspaceId && {
                icon: <Settings aria-hidden="true" className="h-4 w-4" />,
                iconOnly: true,
                title: "Intake settings",
                onClick: () => router.push(intakeSettingsHref(workspaceId)),
              },
            // New request belongs to the list; the dashboard only reports.
            page === "requests" && {
              type: "new",
              onClick: () => router.push("/intake/new"),
              title: "New request",
            },
          ],
        ]}
      />
    </>
  );
}
