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
  intakeDraftAfterFailure,
  intakeAutosaveDraft,
  intakeDraftAfterSave,
  moveIntakeRule,
  newIntakeRule,
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
  models: {
    available: ["claude-haiku-4-5", "claude-sonnet-5-5"],
    triage: "claude-haiku-4-5",
    triage_available: true,
    preprocessing: "claude-sonnet-5-5",
    preprocessing_available: true,
  },
  rules: [
    {
      condition: "NDAs",
      assignee_id: "a",
      preprocess: false,
      preprocess_with: null,
    },
  ],
  recent: [],
};

describe("moveIntakeRule", () => {
  const [a, b, c] = ["A", "B", "C"].map((condition) =>
    newIntakeRule({ condition }),
  );
  const names = (rules: { condition: string }[]) =>
    rules.map((rule) => rule.condition).join("");
  it("drops a rule before or after another", () => {
    expect(names(moveIntakeRule([a, b, c], c.key, a.key, "before"))).toBe(
      "CAB",
    );
    expect(names(moveIntakeRule([a, b, c], a.key, c.key, "after"))).toBe("BCA");
    expect(names(moveIntakeRule([a, b, c], a.key, c.key, "before"))).toBe(
      "BAC",
    );
  });
  it("leaves the rules as they are when nothing moves", () => {
    const rules = [a, b, c];
    expect(moveIntakeRule(rules, a.key, a.key, "after")).toBe(rules);
    expect(moveIntakeRule(rules, a.key, b.key, "before")).toBe(rules);
    expect(moveIntakeRule(rules, "missing", b.key, "after")).toBe(rules);
  });
});

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
      botToken: "  xoxb-1 ",
    };
    expect(intakeAutomationChanges(saved, draft)).toEqual({
      email_enabled: false,
      slack_enabled: true,
      slack_bot_token: "xoxb-1",
    });
  });

  it("sends every complete rule, in order, when one changes", () => {
    const draft = {
      ...intakeAutomationDraft(saved),
      rules: [
        newIntakeRule({ condition: " Employment", assigneeId: "c" }),
        newIntakeRule({ condition: "NDAs ", assigneeId: "a" }),
        // Not yet complete, so not sent.
        newIntakeRule({ condition: "Leases" }),
        newIntakeRule({ condition: "  ", assigneeId: "b" }),
      ],
    };
    expect(intakeAutomationChanges(saved, draft)).toEqual({
      rules: [
        {
          condition: "Employment",
          assignee_id: "c",
          preprocess: false,
          preprocess_with: null,
        },
        {
          condition: "NDAs",
          assignee_id: "a",
          preprocess: false,
          preprocess_with: null,
        },
      ],
    });
    // Whitespace, or a rule still being written, is not a change.
    expect(
      intakeAutomationChanges(saved, {
        ...intakeAutomationDraft(saved),
        rules: [
          newIntakeRule({ condition: " NDAs ", assigneeId: "a" }),
          newIntakeRule(),
        ],
      }),
    ).toEqual({});
  });

  it("leaves a typed domain to its field", () => {
    const typed = { ...intakeAutomationDraft(saved), domainInput: "Acme.test" };
    expect(intakeAutomationChanges(saved, typed)).toEqual({});
    const invalid = { ...typed, domainInput: "acme" };
    expect(intakeDomainInputError(invalid)).toBe(
      "Enter a domain like example.com.",
    );
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
  });
});

describe("intakeDraftAfterSave", () => {
  it("shows what the server kept and clears a sent secret", () => {
    const draft = {
      ...intakeAutomationDraft(saved),
      domains: ["b.test", "a.test"],
      signingSecret: " s3cret ",
      slackEnabled: true,
    };
    const sent = intakeAutomationChanges(saved, draft);
    const kept: IntakeAutomationSettings = {
      ...saved,
      email: { ...saved.email, allowed_domains: ["a.test", "b.test"] },
      slack: { ...saved.slack, enabled: true },
    };
    const next = intakeDraftAfterSave(draft, sent, kept);
    // Rules weren't sent, so they stay the same rules.
    expect(next.rules).toBe(draft.rules);
    expect({ ...next, rules: [] }).toEqual({
      ...intakeAutomationDraft(kept),
      rules: [],
    });
    expect(intakeAutomationChanges(kept, next)).toEqual({});
  });

  it("shows the conditions the server kept, leaving rules being written alone", () => {
    const typing = newIntakeRule({ condition: "Disputes ", assigneeId: "a" });
    const cleaned = newIntakeRule({
      condition: "Leases\u0000",
      assigneeId: "b",
    });
    const unfinished = newIntakeRule({ condition: "Hiring" });
    const draft = {
      ...intakeAutomationDraft(saved),
      rules: [typing, unfinished, cleaned],
    };
    const sent = intakeAutomationChanges(saved, draft);
    const kept: IntakeAutomationSettings = {
      ...saved,
      rules: [
        {
          condition: "Disputes",
          assignee_id: "a",
          preprocess: false,
          preprocess_with: null,
        },
        {
          condition: "Leases",
          assignee_id: "b",
          preprocess: false,
          preprocess_with: null,
        },
      ],
    };
    const next = intakeDraftAfterSave(draft, sent, kept);
    // A pause after a space keeps the space; the same rules keep their keys.
    expect(next.rules).toEqual([
      typing,
      unfinished,
      { ...cleaned, condition: "Leases" },
    ]);
    expect(intakeAutomationChanges(kept, next)).toEqual({});
  });

  it("keeps what was edited while the save was out", () => {
    const sentDraft = {
      ...intakeAutomationDraft(saved),
      domains: ["example.com", "a.test"],
      botToken: "xoxb-1",
    };
    const sent = intakeAutomationChanges(saved, sentDraft);
    const later = {
      ...sentDraft,
      domains: ["example.com", "a.test", "b.test"],
      botToken: "xoxb-2",
      domainInput: "acme.test",
    };
    const kept = {
      ...saved,
      email: { ...saved.email, allowed_domains: ["example.com", "a.test"] },
    };
    const next = intakeDraftAfterSave(later, sent, kept);
    expect(next.domains).toEqual(["example.com", "a.test", "b.test"]);
    expect(next.botToken).toBe("xoxb-2");
    expect(next.domainInput).toBe("acme.test");
  });
});

describe("rule preprocessing", () => {
  it("sends preprocessing with each rule, its workflow or playbook by kind and id", () => {
    const draft = {
      ...intakeAutomationDraft(saved),
      rules: [
        newIntakeRule({
          condition: "NDAs",
          assigneeId: "a",
          preprocess: true,
          preprocessWith: {
            kind: "playbook",
            id: "pb-1",
            name: "NDA playbook",
          },
        }),
      ],
    };
    expect(intakeAutomationChanges(saved, draft)).toEqual({
      rules: [
        {
          condition: "NDAs",
          assignee_id: "a",
          preprocess: true,
          preprocess_with: { kind: "playbook", id: "pb-1" },
        },
      ],
    });
  });

  it("treats a rule as unchanged when only its workflow's name differs", () => {
    const named = {
      ...saved,
      rules: [
        {
          condition: "NDAs",
          assignee_id: "a",
          preprocess: true,
          preprocess_with: {
            kind: "workflow" as const,
            id: "wf-1",
            name: "NDA first pass",
          },
        },
      ],
    };
    const draft = intakeAutomationDraft(named);
    draft.rules[0] = {
      ...draft.rules[0],
      preprocessWith: { kind: "workflow", id: "wf-1", name: null },
    };
    expect(intakeAutomationChanges(named, draft)).toEqual({});
    // Once saved, the rule shows the name the server gives it.
    const sent = {
      rules: [
        {
          condition: "NDAs",
          assignee_id: "a",
          preprocess: true,
          preprocess_with: { kind: "workflow" as const, id: "wf-1" },
        },
      ],
    };
    expect(
      intakeDraftAfterSave(draft, sent, named).rules[0]?.preprocessWith,
    ).toEqual({ kind: "workflow", id: "wf-1", name: "NDA first pass" });
  });
});

describe("intakeDraftAfterFailure", () => {
  it("turns a sent switch back and keeps typed text", () => {
    const draft = {
      ...intakeAutomationDraft(saved),
      slackEnabled: true,
      domainInput: "acme.test",
    };
    const sent = intakeAutomationChanges(saved, draft);
    expect(intakeDraftAfterFailure(draft, sent, saved)).toEqual({
      ...draft,
      slackEnabled: false,
    });
  });
});
describe("intakeAutosaveDraft", () => {
  const none = { signingSecret: false, botToken: false };
  const unset: IntakeAutomationSettings = {
    ...saved,
    email: { ...saved.email, enabled: false, configured: false },
    slack: { ...saved.slack, enabled: false, configured: false },
  };

  it("holds a channel turned on until it can run", () => {
    const draft = {
      ...intakeAutomationDraft(unset),
      emailEnabled: true,
      slackEnabled: true,
    };
    expect(
      intakeAutomationChanges(unset, intakeAutosaveDraft(unset, draft, none)),
    ).toEqual({});
  });

  it("turns Slack on with both its secrets, once each is complete", () => {
    const draft = {
      ...intakeAutomationDraft(unset),
      slackEnabled: true,
      signingSecret: "s3cret",
      botToken: "xoxb-1",
    };
    expect(
      intakeAutomationChanges(
        unset,
        intakeAutosaveDraft(unset, draft, {
          signingSecret: true,
          botToken: false,
        }),
      ),
    ).toEqual({ slack_signing_secret: "s3cret" });
    expect(
      intakeAutomationChanges(
        unset,
        intakeAutosaveDraft(unset, draft, {
          signingSecret: true,
          botToken: true,
        }),
      ),
    ).toEqual({
      slack_enabled: true,
      slack_signing_secret: "s3cret",
      slack_bot_token: "xoxb-1",
    });
  });

  it("sends a channel turned on or off once it is set up", () => {
    const draft = {
      ...intakeAutomationDraft(saved),
      emailEnabled: false,
      slackEnabled: true,
    };
    expect(
      intakeAutomationChanges(saved, intakeAutosaveDraft(saved, draft, none)),
    ).toEqual({ email_enabled: false, slack_enabled: true });
  });
});
