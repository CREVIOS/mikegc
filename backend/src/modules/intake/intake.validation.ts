import { z } from "zod";
export const intakeId = z.uuid();
/** A team organization's id, or "personal" for the caller's own workspace. */
export const intakeWorkspace = z.union([z.literal("personal"), intakeId]);
/** One of a fixed set of whole-number periods, from the query string. */
const period = <T extends number>(choices: readonly T[], fallback: T) =>
  z.coerce
    .number()
    .refine((v): v is T => choices.includes(v as T))
    .default(fallback);
/**
 * The viewer's timezone, which the dashboard counts its weeks in, and the
 * periods its figures cover.
 */
export const intakeDashboardQuery = z
  .object({
    timezone: z.string().min(1).max(64).default("UTC"),
    weeks: period([4, 8, 12, 26] as const, 8),
    created_days: period([7, 30, 90, 365] as const, 30),
    resolved_days: period([7, 30, 90, 365] as const, 30),
    median_days: period([30, 90, 365] as const, 30),
  })
  .strict();
/** Bound submitted text without changing the exact content later shown for review. */
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v.trim().length > 0);
const states = z.enum([
  "submitted",
  "in_review",
  "needs_information",
  "resolved",
  "cancelled",
]);
export const intakePage = z.object({
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const intakeList = z.object({
  state: states.optional(),
  assignee: z.union([z.enum(["unassigned", "me"]), intakeId]).optional(),
  search: z.string().max(200).default(""),
  sort: z.enum(["updated", "updated_asc", "target"]).default("updated"),
  /** What a dashboard figure counted, so it can open those requests. */
  scope: z
    .enum(["open", "unassigned", "overdue", "recorded_30d", "resolved_30d"])
    .optional(),
  /** One requester's name, matched without case. */
  requester: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
/** A business target date needs an IANA timezone so it means one calendar day. */
const datedTogether = (v: {
  requested_by_date: string | null;
  timezone: string | null;
}) => (v.requested_by_date === null) === (v.timezone === null);
const knownTimezone = (v: { timezone: string | null }) => {
  if (v.timezone === null) return true;
  try {
    new Intl.DateTimeFormat("en", { timeZone: v.timezone });
    return true;
  } catch {
    return false;
  }
};
const details = {
  subject: text(200),
  description: text(20000),
  requester_name: text(200),
  // Same rule as the intake_requests check constraint and the form, so an
  // address the database accepted (including a backfilled one) stays valid.
  requester_email: z
    .string()
    .min(3)
    .max(320)
    .regex(/^[^@\s]+@[^@\s]+$/)
    .nullable()
    .default(null),
  requester_team: text(200).nullable().default(null),
  requested_by_date: z.iso.date().nullable().default(null),
  timezone: z.string().min(1).max(100).nullable().default(null),
};
export const intakeSubmit = z
  .object({
    ...details,
    id: intakeId,
    command_id: intakeId,
    assignee_id: intakeId.nullable().default(null),
  })
  .strict()
  .refine(datedTogether)
  .refine(knownTimezone);
export const intakeEdit = z
  .object({
    ...details,
    command_id: intakeId,
    expected_version: z.number().int().positive(),
  })
  .strict()
  .refine(datedTogether)
  .refine(knownTimezone);
const versioned = {
  command_id: intakeId,
  expected_version: z.number().int().positive(),
};
/** Each command's body, keyed by its URL action. */
/** Documents the actor can read, copied onto a request or their note. */
export const intakeDocumentCopy = z
  .object({
    document_ids: z.array(intakeId).min(1).max(20),
    message_id: intakeId.nullable().default(null),
  })
  .strict();
export const intakeCommands = {
  assignment: z
    .object({ ...versioned, assignee_id: intakeId.nullable() })
    .strict(),
  notes: z.object({ command_id: intakeId, body: text(20000) }).strict(),
  wait: z.object({ ...versioned, body: text(20000).optional() }).strict(),
  resume: z.object({ ...versioned, body: text(20000).optional() }).strict(),
  resolve: z.object({ ...versioned, body: text(20000).optional() }).strict(),
  cancel: z.object({ ...versioned, body: text(20000) }).strict(),
  reopen: z.object(versioned).strict(),
  delete: z.object(versioned).strict(),
} as const;
export type IntakeCommandAction = keyof typeof intakeCommands;
export type IntakeCommandInput = {
  command_id: string;
  expected_version?: number;
  body?: string;
  assignee_id?: string | null;
};
