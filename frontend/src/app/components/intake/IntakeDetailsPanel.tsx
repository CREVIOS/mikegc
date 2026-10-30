"use client";
import { useId, useMemo, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type {
  IntakeCategory,
  IntakeDetails,
  IntakeMember,
  IntakeRequest,
} from "@mike/contracts";
import { SETTINGS_CONTROL_CLASS } from "@/app/components/settings/SettingsTextInput";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownSeparator,
  DropdownTrigger,
} from "@/shared/ui/dropdown";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import {
  INTAKE_CATEGORY_LABELS,
  INTAKE_STATE_LABELS,
  formatIntakeDate,
  formatIntakeDateTime,
  intakeMemberName,
  intakeTimezones,
  isIntakeOverdue,
  isKnownTimezone,
} from "./intakeLabels";

/**
 * Grey and flat like the playbook fields. A fixed starting height with no
 * resize handle; it grows with its text where supported.
 */
export const INTAKE_TEXTAREA_CLASS = `${SETTINGS_CONTROL_CLASS} block max-h-[28rem] min-h-32 resize-none py-2.5 leading-relaxed [field-sizing:content]`;
const FIELD_CLASS = `${SETTINGS_CONTROL_CLASS} h-9`;
/** A grey field that opens a menu; long names wrap instead of truncating. */
const MENU_FIELD_CLASS = `${SETTINGS_CONTROL_CLASS} flex min-h-9 items-center justify-between gap-2 py-1.5 text-left [overflow-wrap:anywhere]`;
const LABEL_CLASS = "mb-1.5 block text-xs font-medium text-gray-500";
const EMAIL = /^[^@\s]+@[^@\s]+$/;

/**
 * Keeps a field's unsaved text until the saved value changes, so a save from
 * another field or a refresh never replaces what is being typed here.
 */
function useFieldDraft(value: string) {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(value);
  if (saved !== value) {
    setSaved(value);
    setDraft(value);
  }
  return [draft, setDraft] as const;
}

/**
 * The request's details as a sidebar. Each field saves when it is left or
 * Enter is pressed; Escape puts the saved value back.
 */
export function IntakeDetailsPanel({
  request,
  members,
  accountId,
  locked,
  onSave,
  onAssign,
}: {
  request: IntakeRequest;
  members: IntakeMember[];
  accountId: string;
  /** Another change is being saved; menus wait for it. */
  locked: boolean;
  onSave: (patch: Partial<IntakeDetails>) => void;
  onAssign: (assigneeId: string | null) => void;
}) {
  const caps = request.capabilities;
  const editable = caps.edit;
  const others = members.filter(
    (m) => m.user_id !== accountId && m.user_id !== request.assignee_id,
  );
  const overdue = isIntakeOverdue(request);
  return (
    <aside aria-labelledby="intake-details" className="space-y-4 p-5">
      <h2 id="intake-details" className="text-sm font-medium text-gray-900">
        Details
      </h2>
      <Fact label="Status">{INTAKE_STATE_LABELS[request.state]}</Fact>
      {caps.assign ? (
        <div>
          <p className={LABEL_CLASS}>Assigned lawyer</p>
          <Dropdown>
            <DropdownTrigger asChild>
              <button
                type="button"
                disabled={locked}
                aria-label={`Assigned lawyer: ${request.assignee_name ?? "Unassigned"}`}
                className={MENU_FIELD_CLASS}
              >
                <span
                  className={
                    request.assignee_name ? undefined : "text-gray-400"
                  }
                >
                  {request.assignee_name ?? "Unassigned"}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-gray-400"
                />
              </button>
            </DropdownTrigger>
            <DropdownContent
              align="start"
              className="w-[var(--radix-dropdown-menu-trigger-width)]"
            >
              {request.assignee_id !== accountId && (
                <DropdownItem onSelect={() => onAssign(accountId)}>
                  Assign to me
                </DropdownItem>
              )}
              {request.assignee_id && (
                <DropdownItem onSelect={() => onAssign(null)}>
                  Unassign
                </DropdownItem>
              )}
              {others.length > 0 && <DropdownSeparator />}
              {others.map((m) => (
                <DropdownItem
                  key={m.user_id}
                  onSelect={() => onAssign(m.user_id)}
                >
                  {intakeMemberName(m)}
                </DropdownItem>
              ))}
            </DropdownContent>
          </Dropdown>
        </div>
      ) : (
        <Fact label="Assigned lawyer">
          {request.assignee_name ?? (
            <span className="text-gray-400">Unassigned</span>
          )}
        </Fact>
      )}
      {editable ? (
        <div>
          <p className={LABEL_CLASS}>Type</p>
          <Dropdown>
            <DropdownTrigger asChild>
              <button
                type="button"
                aria-label={`Type: ${INTAKE_CATEGORY_LABELS[request.category]}`}
                className={MENU_FIELD_CLASS}
              >
                {INTAKE_CATEGORY_LABELS[request.category]}
                <ChevronDown
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-gray-400"
                />
              </button>
            </DropdownTrigger>
            <DropdownContent
              align="start"
              className="w-[var(--radix-dropdown-menu-trigger-width)]"
            >
              <DropdownRadioGroup
                value={request.category}
                onValueChange={(category) => {
                  if (category !== request.category)
                    onSave({ category: category as IntakeCategory });
                }}
              >
                {(["general", "nda"] as const).map((category) => (
                  <DropdownRadioItem key={category} value={category}>
                    {INTAKE_CATEGORY_LABELS[category]}
                  </DropdownRadioItem>
                ))}
              </DropdownRadioGroup>
            </DropdownContent>
          </Dropdown>
        </div>
      ) : (
        <Fact label="Type">{INTAKE_CATEGORY_LABELS[request.category]}</Fact>
      )}
      {editable ? (
        <>
          <DetailField
            label="Requester"
            value={request.requester_name}
            maxLength={200}
            check={(name) => (name ? null : "Enter who asked for this.")}
            onSave={(name) => onSave({ requester_name: name })}
          />
          <DetailField
            label="Requester email"
            type="email"
            value={request.requester_email ?? ""}
            maxLength={320}
            check={(email) =>
              !email || EMAIL.test(email)
                ? null
                : "Enter an email address like name@company.com."
            }
            onSave={(email) => onSave({ requester_email: email || null })}
          />
          <DetailField
            label="Team"
            value={request.requester_team ?? ""}
            maxLength={200}
            placeholder="e.g. Procurement"
            onSave={(team) => onSave({ requester_team: team || null })}
          />
          <DetailField
            label="Target date"
            type="date"
            value={request.requested_by_date ?? ""}
            help={
              request.requested_by_date ? (
                <>
                  {overdue && <span className="text-red-600">Overdue · </span>}
                  Not a legal deadline.
                </>
              ) : undefined
            }
            onSave={(date) =>
              onSave(
                date
                  ? {
                      requested_by_date: date,
                      timezone:
                        request.timezone ??
                        Intl.DateTimeFormat().resolvedOptions().timeZone,
                    }
                  : { requested_by_date: null, timezone: null },
              )
            }
          />
          {request.requested_by_date && (
            <TimezoneField
              value={request.timezone ?? ""}
              onSave={(timezone) => onSave({ timezone })}
            />
          )}
        </>
      ) : (
        <>
          <Fact label="Requester">
            <span className="block">{request.requester_name}</span>
            {request.requester_team && (
              <span className="block text-xs text-gray-500">
                {request.requester_team}
              </span>
            )}
            {request.requester_email && (
              <span className="block text-xs text-gray-500">
                {request.requester_email}
              </span>
            )}
          </Fact>
          <Fact label="Target date">
            {request.requested_by_date ? (
              <>
                <span className={`block ${overdue ? "text-red-600" : ""}`}>
                  {formatIntakeDate(request.requested_by_date)}
                  {overdue && " · overdue"}
                </span>
                <span className="block text-xs text-gray-500">
                  {request.timezone ? `${request.timezone} · ` : ""}
                  not a legal deadline
                </span>
              </>
            ) : (
              <span className="text-gray-400">None</span>
            )}
          </Fact>
        </>
      )}
      <Fact label="Recorded">
        <span className="block">{request.created_by_name}</span>
        <span className="block text-xs text-gray-500">
          {formatIntakeDateTime(request.created_at)}
        </span>
      </Fact>
    </aside>
  );
}

/** A labelled value that cannot be edited here. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className={LABEL_CLASS}>{label}</p>
      <div className="text-sm text-gray-900 [overflow-wrap:anywhere]">
        {children}
      </div>
    </div>
  );
}

/** A grey input that saves its trimmed value when left or on Enter. */
function DetailField({
  label,
  value,
  onSave,
  check,
  help,
  type = "text",
  maxLength,
  placeholder,
  list,
}: {
  label: string;
  value: string;
  onSave: (value: string) => void;
  /** Says what is wrong with a value that cannot be saved. */
  check?: (value: string) => string | null;
  help?: ReactNode;
  type?: "text" | "email" | "date";
  maxLength?: number;
  placeholder?: string;
  list?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useFieldDraft(value);
  const [tried, setTried] = useState(false);
  const problem = tried ? (check?.(draft.trim()) ?? null) : null;
  const described = [problem && `${id}-error`, help && `${id}-help`]
    .filter(Boolean)
    .join(" ");

  function commit() {
    const next = draft.trim();
    if (next === value) {
      setDraft(value);
      setTried(false);
      return;
    }
    setTried(true);
    if (check?.(next)) return;
    setTried(false);
    onSave(next);
  }

  return (
    <div className="min-w-0">
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        list={list}
        value={draft}
        maxLength={maxLength}
        placeholder={placeholder}
        autoComplete="off"
        aria-invalid={!!problem}
        aria-describedby={described || undefined}
        className={FIELD_CLASS}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            setDraft(value);
            setTried(false);
          }
        }}
      />
      {problem && (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-red-600">
          {problem}
        </p>
      )}
      {help && (
        <p id={`${id}-help`} className="mt-1.5 text-xs text-gray-500">
          {help}
        </p>
      )}
    </div>
  );
}

function TimezoneField({
  value,
  onSave,
}: {
  value: string;
  onSave: (value: string) => void;
}) {
  const listId = useId();
  const timezones = useMemo(() => intakeTimezones(), []);
  return (
    <>
      <DetailField
        label="Timezone"
        value={value}
        list={listId}
        check={(zone) =>
          isKnownTimezone(zone)
            ? null
            : "Choose a timezone from the list, such as Europe/London."
        }
        onSave={onSave}
      />
      <datalist id={listId}>
        {timezones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
    </>
  );
}

/**
 * The request's subject as the page title. Where it can be edited it is an
 * input that looks like the title until hovered or focused.
 */
export function IntakeSubjectInput({
  value,
  onSave,
}: {
  value: string;
  onSave: (subject: string) => void;
}) {
  const [draft, setDraft] = useFieldDraft(value);
  function commit() {
    const next = draft.trim();
    // A request always has a subject; clearing it puts the saved one back.
    if (!next || next === value) setDraft(value);
    else onSave(next);
  }
  return (
    <input
      aria-label="Subject"
      value={draft}
      maxLength={200}
      autoComplete="off"
      title={value}
      className="-mx-1.5 w-full min-w-0 truncate rounded-md bg-transparent px-1.5 text-gray-900 outline-none transition-colors hover:bg-gray-100 focus:bg-gray-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setDraft(value);
        }
      }}
    />
  );
}

/**
 * The request's description, with Edit to change it in place. The editor
 * stays open with its text until the saved description matches it.
 */
export function IntakeDescription({
  value,
  editable,
  locked,
  onSave,
}: {
  value: string;
  editable: boolean;
  locked: boolean;
  onSave: (description: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(value);
  if (saved !== value) {
    setSaved(value);
    if (draft !== null && draft.trim() === value) setDraft(null);
  }
  const editing = draft !== null;
  return (
    <section aria-labelledby="intake-request" className="space-y-2 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="intake-request" className="text-sm font-medium text-gray-900">
          Request
        </h2>
        {editable && !editing && (
          <button
            type="button"
            aria-label="Edit request"
            onClick={() => setDraft(value)}
            className="rounded-md text-xs text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <>
          <textarea
            aria-labelledby="intake-request"
            rows={5}
            maxLength={20000}
            autoFocus
            value={draft}
            className={`${INTAKE_TEXTAREA_CLASS} min-h-48`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDraft(null);
            }}
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="rounded-md px-2 py-1.5 text-sm text-gray-500 transition-colors hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              Cancel
            </button>
            <PillButtonUI
              tone="black"
              size="sm"
              disabled={!draft.trim() || draft.trim() === value || locked}
              onClick={() => onSave(draft.trim())}
            >
              Save
            </PillButtonUI>
          </div>
        </>
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
          {value}
        </p>
      )}
    </section>
  );
}
