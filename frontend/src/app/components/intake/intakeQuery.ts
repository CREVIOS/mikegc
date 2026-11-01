import type { IntakeState } from "@mike/contracts";
import type { IntakeListScope } from "@/app/lib/mikeApi";

/** The Intake pages, which the header switches between. */
export const INTAKE_REQUESTS_PATH = "/intake/requests";
export const INTAKE_DASHBOARD_PATH = "/intake/dashboard";

/** The list's tabs. Outstanding, the default, holds the open requests. */
export type IntakeTab = "outstanding" | "resolved" | "cancelled";
export type IntakeSort = "updated" | "updated_asc" | "target";

/**
 * What the requests list shows, as its URL says it, so a link, a reload or
 * Back from a request opens the same list. Defaults are left out of the URL.
 *
 *   tab       resolved or cancelled (Outstanding when absent)
 *   scope     what a dashboard figure counted, e.g. overdue
 *   status    one open status, e.g. in_review
 *   assignee  a member's user ID
 *   requester one requester's name
 *   sort      updated_asc or target (most recently updated first when absent)
 *   q         the search text
 */
export type IntakeFilters = {
  tab: IntakeTab;
  scope: IntakeListScope | null;
  status: IntakeState | null;
  assignee: string | null;
  requester: string | null;
  sort: IntakeSort;
  q: string;
};

export const DEFAULT_INTAKE_FILTERS: IntakeFilters = {
  tab: "outstanding",
  scope: null,
  status: null,
  assignee: null,
  requester: null,
  sort: "updated",
  q: "",
};

const TABS: readonly IntakeTab[] = ["outstanding", "resolved", "cancelled"];
const SORTS: readonly IntakeSort[] = ["updated", "updated_asc", "target"];
const SCOPES: readonly IntakeListScope[] = [
  "open",
  "unassigned",
  "overdue",
  "recorded_30d",
  "resolved_30d",
];
/** The status filter narrows open requests; closed ones have their own tabs. */
const STATES: readonly IntakeState[] = [
  "submitted",
  "in_review",
  "needs_information",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pick<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | null {
  return allowed.includes(value as T) ? (value as T) : null;
}

/** Read the page's filters from its URL; anything unrecognised is ignored. */
export function parseIntakeFilters(params: {
  get(name: string): string | null;
}): IntakeFilters {
  const assignee = params.get("assignee");
  return {
    tab: pick(params.get("tab"), TABS) ?? DEFAULT_INTAKE_FILTERS.tab,
    scope: pick(params.get("scope"), SCOPES),
    status: pick(params.get("status"), STATES),
    assignee: assignee && UUID.test(assignee) ? assignee : null,
    requester: params.get("requester")?.trim().slice(0, 200) || null,
    sort: pick(params.get("sort"), SORTS) ?? DEFAULT_INTAKE_FILTERS.sort,
    q: (params.get("q") ?? "").slice(0, 200),
  };
}

/** The query string for `filters`, empty when everything is a default. */
export function intakeFiltersQuery(filters: IntakeFilters): string {
  const params = new URLSearchParams();
  if (filters.tab !== "outstanding") params.set("tab", filters.tab);
  if (filters.scope) params.set("scope", filters.scope);
  if (filters.status) params.set("status", filters.status);
  if (filters.assignee) params.set("assignee", filters.assignee);
  if (filters.requester) params.set("requester", filters.requester);
  if (filters.sort !== "updated") params.set("sort", filters.sort);
  if (filters.q) params.set("q", filters.q);
  return params.toString();
}

/** The requests list showing `filters`; the rest are defaults. */
export function intakeRequestsHref(filters: Partial<IntakeFilters> = {}) {
  const query = intakeFiltersQuery({ ...DEFAULT_INTAKE_FILTERS, ...filters });
  return query ? `${INTAKE_REQUESTS_PATH}?${query}` : INTAKE_REQUESTS_PATH;
}
