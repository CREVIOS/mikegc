"use client";
import { Settings } from "lucide-react";
import { UserAvatar } from "@/app/components/ui/user-avatar";

/**
 * Who made a timeline entry, on the timeline's line: the person's avatar, or
 * a neutral mark for an automatic change, which has no person. The entry's
 * sentence names them, so the mark is hidden from assistive technology.
 */
export function IntakeActorAvatar({ name }: { name: string | null }) {
  return (
    <span
      aria-hidden="true"
      data-actor={name ? "person" : "automatic"}
      className="flex h-6 w-6 shrink-0 items-center justify-center"
    >
      {name ? (
        <UserAvatar size="sm" name={name} />
      ) : (
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-gray-200 text-gray-500">
          <Settings className="h-2.5 w-2.5" />
        </span>
      )}
    </span>
  );
}
