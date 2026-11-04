import { describe, expect, it, vi } from "vitest";
import type { IntakeAutomationSettings } from "@mike/contracts";

vi.mock("@/app/contexts/WorkspaceContext", () => ({
  PERSONAL_WORKSPACE: "personal",
}));

import { intakeAutomationDraft } from "./intakeAutomation";
import {
  intakeChannelSummary,
  intakeDraftWithChannels,
  intakeMailboxConnection,
  intakeMailboxForm,
  intakeMailboxFormProblem,
} from "./intakeChannels";
import { intakeChannelChanges } from "./IntakeChannelSettings";

const saved = (): IntakeAutomationSettings => ({
  clarify_enabled: true,
  email: {
    enabled: true,
    provider: "gmail",
    mailbox: "intake@firm.test",
    allowed_domains: ["firm.test"],
    from_name: "Legal",
    graph: { tenant_id: null, client_id: null, secret_set: false },
    notification_url: "https://api.example.test/webhooks/intake/graph/1",
    gmail_client_id: "1122",
    status: { subscription_expires_at: null, last_read_at: null, error: null },
    needs_reconnect: false,
  },
  slack: {
    enabled: false,
    events_url: "https://api.example.test/webhooks/intake/slack/1",
    configured: true,
    team_id: "T1",
    team_name: null,
    bot_user_id: "U1",
    missing_scopes: [],
    message_events_seen: false,
  },
  teams: {
    enabled: true,
    events_url: "https://api.example.test/webhooks/intake/teams/1",
    configured: true,
    app_id: "app",
    tenant_id: "tenant",
    files_access: true,
  },
  models: {
    available: [],
    triage: null,
    triage_available: false,
    preprocessing: null,
    preprocessing_available: false,
  },
  rules: [],
  recent: [],
});

describe("intakeChannelSummary", () => {
  it("says how each channel stands in one line, and what needs attention", () => {
    const settings = saved();
    expect(intakeChannelSummary(settings, "email")).toEqual({
      configured: true,
      status: "On · intake@firm.test · Gmail",
      warning: null,
    });
    expect(intakeChannelSummary(settings, "slack")).toEqual({
      configured: true,
      status: "Off · T1",
      warning: "No thread messages yet: check the app's message events.",
    });
    expect(intakeChannelSummary(settings, "teams")).toEqual({
      configured: true,
      status: "On · Documents can be sent",
      warning: null,
    });
  });

  it("reads Not set up before a channel is, with Postmark's reconnect warning", () => {
    const settings = saved();
    settings.email = {
      ...settings.email,
      provider: null,
      mailbox: null,
      needs_reconnect: true,
    };
    settings.slack = { ...settings.slack, configured: false };
    settings.teams = { ...settings.teams, configured: false };
    expect(intakeChannelSummary(settings, "email")).toEqual({
      configured: false,
      status: "Not set up",
      warning: "Connect your intake mailbox to keep recording email.",
    });
    for (const channel of ["slack", "teams"] as const)
      expect(intakeChannelSummary(settings, channel)).toEqual({
        configured: false,
        status: "Not set up",
        warning: null,
      });
  });

  it("puts a missing Slack scope before missing message events", () => {
    const settings = saved();
    settings.slack = { ...settings.slack, missing_scopes: ["files:write"] };
    expect(intakeChannelSummary(settings, "slack").warning).toBe(
      "Reinstall the Slack app to send documents.",
    );
  });
});

describe("the mailbox connect form", () => {
  it("starts from what is saved for the same provider, never the secret", () => {
    const email = {
      ...saved().email,
      provider: "graph" as const,
      mailbox: "intake@firm.test",
      graph: { tenant_id: "t", client_id: "c", secret_set: true },
    };
    expect(intakeMailboxForm("graph", email)).toEqual({
      provider: "graph",
      mailbox: "intake@firm.test",
      tenantId: "t",
      clientId: "c",
      clientSecret: "",
    });
    expect(intakeMailboxForm("gmail", email).mailbox).toBe("");
  });

  it("says what is missing, and keeps a saved secret when left empty", () => {
    const form = {
      provider: "graph" as const,
      mailbox: "intake@firm.test",
      tenantId: " t ",
      clientId: "c",
      clientSecret: "",
    };
    expect(intakeMailboxFormProblem({ ...form, mailbox: "intake" }, true)).toMatch(
      /intake address/,
    );
    expect(intakeMailboxFormProblem(form, false)).toMatch(/client secret/);
    expect(intakeMailboxFormProblem(form, true)).toBeNull();
    expect(intakeMailboxConnection(form)).toEqual({
      provider: "graph",
      mailbox: "intake@firm.test",
      tenant_id: "t",
      client_id: "c",
    });
    expect(
      intakeMailboxConnection({ ...form, provider: "gmail" }),
    ).toEqual({ provider: "gmail", mailbox: "intake@firm.test" });
  });
});

describe("intakeChannelChanges", () => {
  it("sends only the channel's own changed fields, with a typed domain", () => {
    const settings = saved();
    const draft = {
      ...intakeAutomationDraft(settings),
      emailEnabled: false,
      domainInput: "Partner.example.org",
      slackEnabled: true,
      clarifyEnabled: false,
    };
    expect(intakeChannelChanges("email", settings, draft)).toEqual({
      email_enabled: false,
      email_allowed_domains: ["firm.test", "partner.example.org"],
    });
    expect(intakeChannelChanges("slack", settings, draft)).toEqual({
      slack_enabled: true,
    });
    expect(intakeChannelChanges("teams", settings, draft)).toEqual({});
  });
});

describe("intakeDraftWithChannels", () => {
  it("takes every channel field as saved, and leaves the rest of the draft", () => {
    const settings = saved();
    const draft = {
      ...intakeAutomationDraft(settings),
      emailEnabled: false,
      domains: ["old.test"],
      signingSecret: "typed",
      teamsAppId: "old",
      clarifyEnabled: false,
    };
    expect(intakeDraftWithChannels(draft, settings)).toMatchObject({
      emailEnabled: true,
      domains: ["firm.test"],
      signingSecret: "",
      teamsAppId: "app",
      // Not a channel's: kept as edited.
      clarifyEnabled: false,
    });
  });
});
