"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/app/contexts/WorkspaceContext";
import { intakeRulesHref, intakeSettingsHref } from "./intakeQuery";

/**
 * Intake's settings and rules moved into the workspace's settings; an old
 * link to /intake/settings or /intake/rules opens them there.
 */
export function IntakeSettingsRedirect({ to }: { to: "settings" | "rules" }) {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  useEffect(() => {
    if (!workspaceId) return;
    router.replace(
      to === "rules"
        ? intakeRulesHref(workspaceId)
        : intakeSettingsHref(workspaceId),
    );
  }, [router, to, workspaceId]);
  return null;
}
