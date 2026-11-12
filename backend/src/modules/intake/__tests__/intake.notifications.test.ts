import { describe, expect, it } from "vitest";
import {
  groupIntakeNotifications,
  type ClaimedIntakeNotification,
} from "../intake.notifications";

const at = (second: number) => `2026-11-04T10:00:${String(second).padStart(2, "0")}Z`;
const row = (
  id: number,
  extra: Partial<ClaimedIntakeNotification> = {},
): ClaimedIntakeNotification => ({
  id,
  workspace: "org-1",
  workspace_name: "Test legal",
  request_id: "request-1",
  subject: "Supplier NDA",
  kind: "update",
  change: "note",
  actor_name: "Sam Colleague",
  automated: false,
  channel: null,
  created_at: at(id),
  ...extra,
});

describe("groupIntakeNotifications", () => {
  it("gives each request one notification, newest last", () => {
    const grouped = groupIntakeNotifications([
      row(1, { request_id: "a" }),
      row(2, { request_id: "b" }),
      row(3, { request_id: "a", change: "resolve" }),
    ]);
    expect(grouped.map((n) => [n.request_id, n.change, n.more])).toEqual([
      ["b", "note", 0],
      ["a", "resolve", 1],
    ]);
  });
  it("keeps a request that became the member's new, whatever happened after", () => {
    const [only] = groupIntakeNotifications([
      row(1, { kind: "new_request", change: "assign", actor_name: "Alex Lawyer" }),
      row(2, { change: "reply", actor_name: "Jane Business", channel: "slack" }),
    ]);
    expect(only).toMatchObject({
      kind: "new_request",
      change: "assign",
      actor_name: "Alex Lawyer",
      more: 1,
      created_at: at(2),
    });
  });
  it("describes a change by what it was for, and counts it once", () => {
    // A reply puts the request back to work in the same transaction.
    const [reply] = groupIntakeNotifications([
      row(1, { change: "reply", actor_name: "Jane Business", channel: "slack", created_at: at(5) }),
      row(2, { change: "resume", actor_name: null, automated: true, created_at: at(5) }),
    ]);
    expect(reply).toMatchObject({ change: "reply", actor_name: "Jane Business", channel: "slack", more: 0 });
    // An edit that stopped Spectre asking.
    const [edit] = groupIntakeNotifications([
      row(1),
      row(2, { change: "edited", created_at: at(9) }),
      row(3, { change: "stop_asking", created_at: at(9) }),
    ]);
    expect(edit).toMatchObject({ change: "edited", more: 1 });
  });
  it("keeps requests with the same ID in different workspaces apart", () => {
    expect(
      groupIntakeNotifications([row(1), row(2, { workspace: "personal" })]),
    ).toHaveLength(2);
  });
  it("hands back nothing for nothing", () => {
    expect(groupIntakeNotifications([])).toEqual([]);
  });
});
