import { randomUUID } from "node:crypto";
import type { Db } from "../../../lib/supabase";

/**
 * An in-memory stand-in for the PostgREST query builder: enough of select,
 * insert, upsert, update, delete and their filters for the automated intake
 * services, holding real rows so a test can follow a message from webhook to
 * request. Unique keys are enforced as Postgres would (23505). RPCs go to the
 * handlers a test supplies.
 */
type Row = Record<string, unknown>;
type Result = { data: unknown; error: unknown };
type RpcHandler = (args: Record<string, unknown>, db: MemoryDb) => Result | Promise<Result>;

export type MemoryDb = {
  db: Db;
  tables: Record<string, Row[]>;
  rows: (table: string) => Row[];
  rpcCalls: { name: string; args: Record<string, unknown> }[];
  /** Return an error to fail a write, as a database outage would. */
  intercept?: (write: { table: string; op: string; values: unknown }) => unknown;
};

const UNIQUE: Record<string, string[][]> = {
  intake_inbound: [["id"], ["org_id", "source", "external_id"]],
  intake_automation: [["org_id"], ["slack_webhook_id"], ["email_token_hash"]],
  intake_assignment_rules: [["id"]],
  documents: [["id"]],
  intake_requests: [["id"]],
};

const DEFAULTS: Record<string, () => Row> = {
  intake_inbound: () => ({
    id: randomUUID(),
    status: "pending",
    payload: null,
    request_id: null,
    error: null,
    created_at: new Date().toISOString(),
  }),
  intake_automation: () => ({
    email_enabled: false,
    email_token_hash: null,
    email_token_hint: null,
    email_allowed_domains: [],
    slack_enabled: false,
    slack_webhook_id: randomUUID(),
    slack_team_id: null,
    slack_team_name: null,
    slack_bot_user_id: null,
    slack_signing_secret_encrypted: null,
    slack_signing_secret_iv: null,
    slack_signing_secret_tag: null,
    slack_bot_token_encrypted: null,
    slack_bot_token_iv: null,
    slack_bot_token_tag: null,
    triage_model: null,
    preprocessing_model: null,
    configured_by: null,
  }),
  documents: () => ({ id: randomUUID() }),
};

const copy = <T,>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));

export function memoryDb(
  seed: Record<string, Row[]> = {},
  rpc: Record<string, RpcHandler> = {},
): MemoryDb {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed))
    tables[name] = rows.map((r) => ({ ...(DEFAULTS[name]?.() ?? {}), ...copy(r) }));
  const table = (name: string) => (tables[name] ??= []);
  const conflict = (name: string, row: Row, except?: Row) =>
    (UNIQUE[name] ?? []).some((cols) =>
      table(name).some(
        (other) =>
          other !== except &&
          cols.every((c) => row[c] !== null && row[c] !== undefined && other[c] === row[c]),
      ),
    );
  const memory: MemoryDb = {
    db: undefined as unknown as Db,
    tables,
    rows: (name) => table(name),
    rpcCalls: [],
  };

  const from = (name: string) => {
    let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let values: unknown;
    let options: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let returning = false;
    const filters: ((row: Row) => boolean)[] = [];
    let order: [string, boolean] | null = null;
    let limit: number | null = null;
    let columns: string[] | null = null;
    // Only the selected columns come back, as from PostgREST; embedded
    // resources such as organizations!inner(id) are not modelled.
    const project = (rows: Row[]) =>
      columns
        ? rows.map((r) => Object.fromEntries(columns!.map((c) => [c, r[c] ?? null])))
        : rows;

    const run = (): Result => {
      if (op !== "select") {
        const error = memory.intercept?.({ table: name, op, values: copy(values) });
        if (error) return { data: null, error };
      }
      const matches = () => table(name).filter((r) => filters.every((f) => f(r)));
      if (op === "select") {
        let rows = matches();
        if (order) {
          const [col, asc] = order;
          rows = [...rows].sort((a, b) =>
            String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : String(a[col]) > String(b[col]) ? (asc ? 1 : -1) : 0,
          );
        }
        if (limit !== null) rows = rows.slice(0, limit);
        return { data: copy(project(rows)), error: null };
      }
      if (op === "insert" || op === "upsert") {
        const input = (Array.isArray(values) ? values : [values]) as Row[];
        const written: Row[] = [];
        for (const raw of input) {
          const row = { ...(DEFAULTS[name]?.() ?? {}), ...copy(raw) };
          if (op === "upsert") {
            const keys = (options.onConflict ?? "id").split(",");
            const existing = table(name).find((r) => keys.every((k) => r[k] === raw[k]));
            if (existing) {
              if (!options.ignoreDuplicates) {
                Object.assign(existing, copy(raw));
                written.push(existing);
              }
              continue;
            }
          }
          if (conflict(name, row))
            return { data: null, error: { code: "23505", message: "duplicate key" } };
          table(name).push(row);
          written.push(row);
        }
        return { data: returning ? copy(project(written)) : null, error: null };
      }
      if (op === "update") {
        const rows = matches();
        for (const row of rows) Object.assign(row, copy(values as Row));
        return { data: returning ? copy(project(rows)) : null, error: null };
      }
      const doomed = new Set(matches());
      tables[name] = table(name).filter((r) => !doomed.has(r));
      return { data: returning ? copy([...doomed]) : null, error: null };
    };

    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      select: (list?: string) => {
        if (op !== "select") returning = true;
        if (list && list.trim() !== "*")
          columns = list
            .split(",")
            .map((c) => c.trim())
            .filter((c) => c && !/[(!]/.test(c));
        return builder;
      },
      insert: (v: unknown) => ((op = "insert"), (values = v), builder),
      upsert: (v: unknown, o: typeof options = {}) => (
        (op = "upsert"), (values = v), (options = o), builder
      ),
      update: (v: unknown) => ((op = "update"), (values = v), builder),
      delete: () => ((op = "delete"), builder),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), builder),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), builder),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), builder),
      not: (c: string, operator: string, v: unknown) => {
        if (operator === "is") filters.push((r) => (r[c] ?? null) !== v);
        if (operator === "in") {
          const list = String(v).replace(/^\(|\)$/g, "").split(",").filter(Boolean);
          filters.push((r) => !list.includes(String(r[c])));
        }
        return builder;
      },
      order: (c: string, o?: { ascending?: boolean }) => (
        (order = [c, o?.ascending !== false]), builder
      ),
      limit: (n: number) => ((limit = n), builder),
      single: async () => {
        const result = run();
        if (result.error) return result;
        const rows = (Array.isArray(result.data) ? result.data : []) as Row[];
        return rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: { code: "PGRST116", message: "not one row" } };
      },
      maybeSingle: async () => {
        const result = run();
        if (result.error) return result;
        const rows = (Array.isArray(result.data) ? result.data : []) as Row[];
        return { data: rows[0] ?? null, error: null };
      },
      then: (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve().then(run).then(resolve, reject),
    });
    return builder;
  };

  memory.db = {
    from,
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      memory.rpcCalls.push({ name, args: copy(args) });
      const handler = rpc[name];
      if (!handler) return { data: null, error: { code: "42883", message: "missing" } };
      return handler(args, memory);
    },
  } as unknown as Db;
  return memory;
}

/** intake_replace_rules as the migration defines it: the rules become those given, in order. */
export const intakeRulesRpc: Record<string, RpcHandler> = {
  intake_replace_rules: (args, memory) => {
    if (!memory.rows("intake_automation").some((r) => r.org_id === args.p_org))
      return { data: null, error: { code: "P0002" } };
    const rules = args.p_rules as Row[];
    memory.tables.intake_assignment_rules = [
      ...memory.rows("intake_assignment_rules").filter((r) => r.org_id !== args.p_org),
      ...rules.map((r, position) => ({ id: `rule-${position}`, org_id: args.p_org, position, ...r })),
    ];
    return { data: null, error: null };
  },
};

/**
 * The automated-intake SQL functions as the migration defines them, enough
 * for unit tests: one request per message, documents linked once.
 */
export const automatedIntakeRpc: Record<string, RpcHandler> = {
  intake_submit_automated: (args, memory) => {
    const inbound = memory
      .rows("intake_inbound")
      .find((r) => r.id === args.p_inbound && r.org_id === args.p_org);
    if (!inbound) return { data: null, error: { code: "P0002" } };
    if (inbound.request_id) return { data: inbound.request_id, error: null };
    if (inbound.status !== "pending") return { data: null, error: { code: "P0001" } };
    const member = memory
      .rows("org_members")
      .some((m) => m.org_id === args.p_org && m.user_id === args.p_assignee);
    const assignee = member ? args.p_assignee : null;
    memory.rows("intake_requests").push({
      id: args.p_request,
      org_id: args.p_org,
      created_by: null,
      source: inbound.source,
      subject: args.p_subject,
      description: args.p_description,
      requester_name: args.p_requester_name,
      requester_email: args.p_requester_email ?? null,
      requested_by_date: args.p_date ?? null,
      assignee_id: assignee,
      state: assignee ? "in_review" : "submitted",
    });
    inbound.request_id = args.p_request;
    return { data: args.p_request, error: null };
  },
  intake_attach_automated: (args, memory) => {
    const document = memory
      .rows("documents")
      .find((d) => d.id === args.p_document && d.org_id === args.p_org && d.user_id === null);
    const request = memory.rows("intake_requests").find((r) => r.id === args.p_request);
    if (!document || !request) return { data: null, error: { code: "P0002" } };
    const links = memory.rows("intake_request_documents");
    if (!links.some((l) => l.document_id === args.p_document))
      links.push({
        org_id: args.p_org,
        request_id: args.p_request,
        document_id: args.p_document,
        added_by: null,
        automated: true,
      });
    return { data: null, error: null };
  },
  intake_note_automated: (args, memory) => {
    const request = memory
      .rows("intake_requests")
      .find((r) => r.id === args.p_request && r.org_id === args.p_org);
    if (!request) return { data: null, error: { code: "P0002" } };
    const notes = memory.rows("intake_messages");
    if (notes.some((n) => n.id === args.p_note)) return { data: false, error: null };
    notes.push({
      id: args.p_note,
      org_id: args.p_org,
      request_id: args.p_request,
      author_id: null,
      kind: "note",
      body: args.p_body,
      automated: true,
    });
    return { data: true, error: null };
  },
};
