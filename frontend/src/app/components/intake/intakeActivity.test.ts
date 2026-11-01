import { describe, expect, it } from "vitest";
import type { IntakeEvent, IntakeMessage } from "@mike/contracts";
import { describeIntakeEvent, describeIntakeMessage } from "./intakeActivity";

const event = (overrides: Partial<IntakeEvent>): IntakeEvent => ({
  id: 1,
  kind: "submitted",
  from_state: null,
  to_state: "submitted",
  actor_id: "sam",
  actor_name: "Sam Colleague",
  assignee_name: null,
  created_at: "2026-10-26T10:00:00Z",
  ...overrides,
});

const message = (overrides: Partial<IntakeMessage>): IntakeMessage => ({
  id: "m1",
  kind: "note",
  body: "A note",
  author_id: "sam",
  author_name: "Sam Colleague",
  created_at: "2026-10-27T10:00:00Z",
  ...overrides,
});

describe("describeIntakeEvent", () => {
  it("reads a change as the person, then what they did", () => {
    expect(describeIntakeEvent(event({ assignee_name: "Lawyer B" }))).toEqual({
      actor: "Sam Colleague",
      action: "created this and assigned it to Lawyer B",
    });
    expect(describeIntakeEvent(event({ kind: "wait" }))).toEqual({
      actor: "Sam Colleague",
      action: "marked this waiting on the requester",
    });
    expect(describeIntakeEvent(event({ kind: "assign" })).action).toBe(
      "unassigned this",
    );
    expect(describeIntakeEvent(event({ kind: "edited" })).action).toBe(
      "edited the details",
    );
    expect(describeIntakeEvent(event({ kind: "custom_kind" })).action).toBe(
      "custom kind",
    );
  });

  it("writes a change no person made as a whole sentence", () => {
    expect(
      describeIntakeEvent(
        event({
          kind: "assignee_left",
          actor_name: null,
          assignee_name: "Lawyer B",
        }),
      ),
    ).toEqual({
      actor: null,
      action:
        "Automatically unassigned Lawyer B because they left the organization",
    });
    expect(
      describeIntakeEvent(event({ kind: "reply", actor_name: null })),
    ).toEqual({ actor: null, action: "The requester replied" });
  });
});

describe("describeIntakeMessage", () => {
  it("names what the person wrote; the text goes below", () => {
    expect(describeIntakeMessage(message({}))).toEqual({
      actor: "Sam Colleague",
      action: "commented",
    });
    expect(describeIntakeMessage(message({ kind: "resolution" })).action).toBe(
      "recorded the resolution",
    );
    expect(
      describeIntakeMessage(message({ kind: "cancel_reason" })).action,
    ).toBe("gave the reason for cancelling");
    expect(describeIntakeMessage(message({ kind: "question" })).action).toBe(
      "commented",
    );
  });
});
