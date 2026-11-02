import { describe, expect, it, vi } from "vitest";
import type { IntakeAutomationSettings } from "@mike/contracts";

vi.mock("@/app/contexts/WorkspaceContext", () => ({
  PERSONAL_WORKSPACE: "personal",
}));

import {
  MAX_INTAKE_DOMAINS,
  intakeAutomationChanges,
  intakeAutomationDraft,
  intakeDomainInputError,
  intakeDraftDomains,
  intakeTimezoneError,
  normalizeIntakeDomain,
} from "./intakeAutomation";

const saved: IntakeAutomationSettings = {
  email: {
    enabled: true,
    configured: true,
    token_hint: "9f3c",
    allowed_domains: ["example.com"],
  },
  slack: {
    enabled: false,
    events_url: "https://api.example.test/webhooks/intake/slack/1",
    configured: true,
    team_id: "T1",
    team_name: "Acme",
    bot_user_id: "U1",
  },
  triage: {
    enabled: true,
    default_timezone: "Europe/London",
    model_available: true,
  },
  focus: [{ user_id: "a", focus: "NDAs" }],
  recent: [],
};

describe("normalizeIntakeDomain", () => {
  it("keeps a domain as the API does, lowercase", () => {
    expect(normalizeIntakeDomain(" Example.COM ")).toBe("example.com");
    expect(normalizeIntakeDomain("@example.com")).toBe("example.com");
    expect(normalizeIntakeDomain("jane@legal.example.co.uk")).toBe(
      "legal.example.co.uk",
    );
    expect(normalizeIntakeDomain("*.example.com")).toBe("example.com");
    expect(normalizeIntakeDomain("xn--80ak6aa92e.com")).toBe(
      "xn--80ak6aa92e.com",
    );
  });

  it("refuses what is not a domain", () => {
    for (const text of [
      "",
      "example",
      "exa mple.com",
      "-a.com",
      "a.c",
      "http://a.com",
    ])
      expect(normalizeIntakeDomain(text)).toBeNull();
  });
});

describe("intakeAutomationChanges", () => {
  it("sends nothing for an untouched draft", () => {
    expect(
      intakeAutomationChanges(saved, intakeAutomationDraft(saved)),
    ).toEqual({});
  });

  it("sends each changed field and only those", () => {
    const draft = {
      ...intakeAutomationDraft(saved),
      emailEnabled: false,
      slackEnabled: true,
      triageEnabled: false,
      timezone: "  ",
      botToken: "  xoxb-1 ",
    };
    expect(intakeAutomationChanges(saved, draft)).toEqual({
      email_enabled: false,
      slack_enabled: true,
      triage_enabled: false,
      default_timezone: null,
      slack_bot_token: "xoxb-1",
    });
  });

  it("replaces every member's note when one changes, leaving out blank ones", () => {
    const draft = {
      ...intakeAutomationDraft(saved),
      focus: { a: "NDAs ", b: "  ", c: " Employment" },
    };
    expect(intakeAutomationChanges(saved, draft)).toEqual({
      focus: [
        { user_id: "a", focus: "NDAs" },
        { user_id: "c", focus: "Employment" },
      ],
    });
    // Whitespace alone is not a change.
    expect(
      intakeAutomationChanges(saved, {
        ...intakeAutomationDraft(saved),
        focus: { a: " NDAs", b: "" },
      }),
    ).toEqual({});
  });

  it("adds a valid typed domain, and leaves an invalid one to its error", () => {
    const typed = { ...intakeAutomationDraft(saved), domainInput: "Acme.test" };
    expect(intakeDraftDomains(typed)).toEqual(["example.com", "acme.test"]);
    expect(intakeAutomationChanges(saved, typed)).toEqual({
      email_allowed_domains: ["example.com", "acme.test"],
    });
    const repeated = { ...typed, domainInput: "EXAMPLE.com" };
    expect(intakeAutomationChanges(saved, repeated)).toEqual({});
    const invalid = { ...typed, domainInput: "acme" };
    expect(intakeDomainInputError(invalid)).toBe(
      "Enter a domain like example.com.",
    );
    expect(intakeAutomationChanges(saved, invalid)).toEqual({});
  });

  it("allows at most the domains the API keeps", () => {
    const full = {
      ...intakeAutomationDraft(saved),
      domains: Array.from(
        { length: MAX_INTAKE_DOMAINS },
        (_, i) => `d${i}.test`,
      ),
      domainInput: "one-more.test",
    };
    expect(intakeDomainInputError(full)).toBe(
      "Up to 50 domains can be listed.",
    );
    expect(intakeDraftDomains(full)).toHaveLength(MAX_INTAKE_DOMAINS);
  });
});

describe("intakeTimezoneError", () => {
  it("accepts an empty or known timezone", () => {
    const draft = intakeAutomationDraft(saved);
    expect(intakeTimezoneError({ ...draft, timezone: "" })).toBeNull();
    expect(
      intakeTimezoneError({ ...draft, timezone: "America/New_York" }),
    ).toBeNull();
    expect(intakeTimezoneError({ ...draft, timezone: "Mars/Base" })).toMatch(
      /Choose a timezone/,
    );
  });
});
