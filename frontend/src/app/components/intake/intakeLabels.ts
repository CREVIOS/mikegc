import type {
  IntakeMessage,
  IntakeState,
} from "@mike/contracts";
import { PERSONAL_WORKSPACE } from "@/app/contexts/WorkspaceContext";

/** Stored states keep their original names; these are what Legal sees. */
export const INTAKE_STATE_LABELS: Record<IntakeState, string> = {
  submitted: "New",
  in_review: "In progress",
  needs_information: "Waiting on requester",
  resolved: "Resolved",
  cancelled: "Cancelled",
};

/** A status dot beside the label, so statuses scan by colour as well as text. */
export const INTAKE_STATE_DOT_CLASS: Record<IntakeState, string> = {
  submitted: "bg-blue-500",
  in_review: "bg-amber-500",
  needs_information: "bg-violet-500",
  resolved: "bg-emerald-500",
  cancelled: "bg-gray-400",
};

/** Legacy question, reply and answer messages read as notes. */
export const INTAKE_MESSAGE_LABELS: Record<IntakeMessage["kind"], string> = {
  note: "Note",
  resolution: "Resolution",
  cancel_reason: "Cancellation reason",
  question: "Note",
  reply: "Note",
  answer: "Note",
};

export function isOpenIntakeState(state: IntakeState) {
  return state !== "resolved" && state !== "cancelled";
}

/** Show a stored calendar date as itself, whatever the viewer's timezone. */
export function formatIntakeDate(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** The calendar date it currently is in a timezone, as YYYY-MM-DD. */
function todayIn(timezone: string, now: Date) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** What deleting requests takes, and from whom: an organization's members, or only you. */
export function intakeDeleteMessage(orgId: string, many: boolean) {
  const what = `${many ? "Their" : "Its"} notes, history and documents are deleted`;
  return orgId === PERSONAL_WORKSPACE
    ? `${what}. This can't be undone.`
    : `${what} for everyone in your organization. This can't be undone.`;
}

/** An open request is overdue once its target day has passed where it was set. */
export function isIntakeOverdue(
  request: {
    state: IntakeState;
    requested_by_date: string | null;
    timezone: string | null;
  },
  now = new Date(),
) {
  return (
    !!request.requested_by_date &&
    isOpenIntakeState(request.state) &&
    todayIn(request.timezone ?? "UTC", now) > request.requested_by_date
  );
}

export function formatIntakeDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function intakeMemberName(member: {
  display_name: string | null;
  email: string | null;
}) {
  return member.display_name ?? member.email ?? "Member";
}

/** IANA zones the browser knows, for the timezone suggestions list. */
export function intakeTimezones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

export function isKnownTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
