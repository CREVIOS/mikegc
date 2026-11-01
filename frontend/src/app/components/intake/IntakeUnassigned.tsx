"use client";
import { UserRound } from "lucide-react";
import { cn } from "@/app/lib/utils";

/**
 * "Unassigned" where a reviewer would be: a grey person mark in an avatar's
 * place, so the label lines up with the named reviewers around it.
 */
export function IntakeUnassigned({ className }: { className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <span
        aria-hidden="true"
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gray-200 text-gray-500"
      >
        <UserRound className="h-2.5 w-2.5" />
      </span>
      Unassigned
    </span>
  );
}
