"use client";
import type { ReactNode } from "react";
import { Bot, Settings } from "lucide-react";
import type { IntakeEvent, IntakeRequest } from "@mike/contracts";
import { UserAvatar } from "@/app/components/ui/user-avatar";

/** What MikeGC is called where it acted: it records requests, but is not an account. */
export const MIKEGC_NAME = "MikeGC";

/** A timeline entry MikeGC made, such as creating a request from email. */
export function isMikeGCEvent(
  event: Pick<IntakeEvent, "actor_id" | "actor_name">,
) {
  return event.actor_id === null && event.actor_name === MIKEGC_NAME;
}

/** A request MikeGC recorded from email or Slack, rather than a member. */
export function isMikeGCRequest(
  request: Pick<IntakeRequest, "created_by" | "source">,
) {
  return request.created_by === null && request.source !== "manual";
}

/** A neutral circle the size of a small avatar, holding an icon. */
function NeutralMark({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gray-200 text-gray-500">
      {children}
    </span>
  );
}

/**
 * MikeGC's own circle, the size of a small avatar: Mike azure, with its robot
 * in silver. The colour is named directly because dark mode darkens the
 * text-gray-200 class, which would sink the robot into the blue.
 */
function MikeGCCircle() {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-600 text-(--color-gray-200)">
      <Bot className="h-2.5 w-2.5" strokeWidth={2.5} />
    </span>
  );
}

/**
 * MikeGC's mark where a person's avatar would be, such as beside "Created
 * by". The name beside it says who it is, so the mark is hidden.
 */
export function IntakeMikeGCMark() {
  return (
    <span aria-hidden="true" data-actor="mikegc" className="flex shrink-0">
      <MikeGCCircle />
    </span>
  );
}

/**
 * Who made a timeline entry, on the timeline's line: the person's avatar,
 * MikeGC's mark, or a neutral mark for an automatic change, which has no
 * person. The entry's sentence names them, so the mark is hidden from
 * assistive technology.
 */
export function IntakeActorAvatar({
  name,
  photo,
  mikegc = false,
}: {
  name: string | null;
  photo?: string | null;
  /** MikeGC made the entry; it is named, but is not a person. */
  mikegc?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      data-actor={mikegc ? "mikegc" : name ? "person" : "automatic"}
      className="flex h-6 w-6 shrink-0 items-center justify-center"
    >
      {mikegc ? (
        <MikeGCCircle />
      ) : name ? (
        <UserAvatar size="sm" name={name} photo={photo} />
      ) : (
        <NeutralMark>
          <Settings className="h-2.5 w-2.5" />
        </NeutralMark>
      )}
    </span>
  );
}
