import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes } from "react";
import type {
  IntakeAutomationSettings,
  IntakeAutomationUpdate,
  IntakeMailboxConnection,
  IntakeMember,
} from "@mike/contracts";
import { IntakeModelSettings } from "./IntakeModelSettings";
import { IntakeSettings } from "./IntakeSettings";
import { IntakePageHeader } from "./IntakePageHeader";
import { IntakeSettingsRedirect } from "./IntakeSettingsRedirect";

const mocks = vi.hoisted(() => ({
  automation: vi.fn(),
  update: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  test: vi.fn(),
  members: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  notify: vi.fn(),
  success: vi.fn(),
  workspace: {
    accountId: "account-a",
    workspaceId: "org-a",
    activeOrganization: { id: "org-a", role: "admin" } as {
      id: string;
      role: string;
    } | null,
  },
}));
vi.mock("@/app/lib/mikeApi", () => ({
  getIntakeAutomation: mocks.automation,
  updateIntakeAutomation: mocks.update,
  connectIntakeMailbox: mocks.connect,
  disconnectIntakeMailbox: mocks.disconnect,
  sendIntakeMailboxTest: mocks.test,
  getIntakeMembers: mocks.members,
}));
vi.mock("@/app/lib/userFacingError", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/userFacingError")>()),
  notifyError: mocks.notify,
  notifySuccess: mocks.success,
}));
vi.mock("@/shared/lib/errorNotifier", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/errorNotifier")>()),
  notifySuccess: mocks.success,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}));
vi.mock("next/link", () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
  PERSONAL_WORKSPACE: "personal",
  useWorkspace: () => mocks.workspace,
}));

const LONG_EMAIL =
  "alexandra.montgomery-fitzwilliam.legal-operations@subsidiary.example.com";
const members: IntakeMember[] = [
  {
    user_id: "lawyer-a",
    display_name: "Lawyer A",
    email: "a@example.test",
    profile_photo: null,
  },
  {
    user_id: "lawyer-b",
    display_name: "Lawyer B",
    email: LONG_EMAIL,
    profile_photo: null,
  },
];

/** The email block with an Outlook mailbox connected, switched off. */
const connectedEmail = (): IntakeAutomationSettings["email"] => ({
  enabled: false,
  provider: "graph",
  mailbox: "intake@example.com",
  allowed_domains: ["example.com"],
  from_name: "Legal",
  graph: { tenant_id: "tenant-1", client_id: "client-1", secret_set: true },
  notification_url: "https://api.example.test/webhooks/intake/graph/7c1d",
  gmail_client_id: "1122334455",
  status: {
    subscription_expires_at: "2026-11-06T10:00:00Z",
    last_read_at: "2026-11-03T09:30:00Z",
    error: null,
  },
  needs_reconnect: false,
});
/** The email block before any mailbox is connected. */
const unconnectedEmail = (
  overrides: Partial<IntakeAutomationSettings["email"]> = {},
): IntakeAutomationSettings["email"] => ({
  ...connectedEmail(),
  provider: null,
  mailbox: null,
  allowed_domains: [],
  graph: { tenant_id: null, client_id: null, secret_set: false },
  status: { subscription_expires_at: null, last_read_at: null, error: null },
  ...overrides,
});

const settings = (
  overrides: Partial<IntakeAutomationSettings> = {},
): IntakeAutomationSettings => ({
  clarify_enabled: true,
  email: connectedEmail(),
  slack: {
    enabled: true,
    events_url: "https://api.example.test/webhooks/intake/slack/0b6f",
    configured: true,
    team_id: "T0123",
    team_name: "Acme Legal",
    bot_user_id: "U0BOT",
    missing_scopes: [],
    message_events_seen: true,
  },
  teams: {
    enabled: false,
    events_url: "https://api.example.test/webhooks/intake/teams/5e2a",
    configured: false,
    app_id: null,
    tenant_id: null,
    files_access: null,
  },
  models: {
    available: ["claude-haiku-4-5", "claude-sonnet-5-5", "gpt-6-luna"],
    triage: "claude-haiku-4-5",
    triage_available: true,
    preprocessing: "claude-sonnet-5-5",
    preprocessing_available: true,
  },
  rules: [
    {
      condition: "The request is about an NDA or procurement contract",
      assignee_id: "lawyer-a",
      preprocess: false,
      preprocess_with: null,
    },
  ],
  recent: [],
  ...overrides,
});

/** Saved settings with email on, so its setup shows. */
const emailOn = () =>
  settings({ email: { ...settings().email, enabled: true } });

const form = () => screen.findByRole("form", { name: "Automated intake" });
const section = (name: string) => screen.getByRole("region", { name });
/** Longer than the autosave's pause after typing. */
const SAVE_WAIT = { timeout: 2500 };

/** The API: applies each update to what it keeps and returns the result. */
let server: IntakeAutomationSettings;
function applyUpdate(
  current: IntakeAutomationSettings,
  update: IntakeAutomationUpdate,
): IntakeAutomationSettings {
  return {
    ...current,
    clarify_enabled: update.clarify_enabled ?? current.clarify_enabled,
    email: {
      ...current.email,
      enabled: update.email_enabled ?? current.email.enabled,
      allowed_domains:
        update.email_allowed_domains ?? current.email.allowed_domains,
      from_name: update.email_from_name ?? current.email.from_name,
    },
    teams: {
      ...current.teams,
      enabled: update.teams_enabled ?? current.teams.enabled,
      app_id: update.teams_app_id ?? current.teams.app_id,
      tenant_id: update.teams_tenant_id ?? current.teams.tenant_id,
      configured:
        current.teams.configured ||
        (!!(update.teams_app_id ?? current.teams.app_id) &&
          !!(update.teams_tenant_id ?? current.teams.tenant_id) &&
          !!update.teams_client_secret),
    },
    slack: {
      ...current.slack,
      enabled: update.slack_enabled ?? current.slack.enabled,
      configured:
        current.slack.configured ||
        (!!update.slack_signing_secret && !!update.slack_bot_token),
    },
    models: {
      ...current.models,
      ...(update.triage_model !== undefined && {
        triage: update.triage_model,
        triage_available: update.triage_model !== null,
      }),
      ...(update.preprocessing_model !== undefined && {
        preprocessing: update.preprocessing_model,
        preprocessing_available: update.preprocessing_model !== null,
      }),
    },
    rules: update.rules ?? current.rules,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspace = {
    accountId: "account-a",
    workspaceId: "org-a",
    activeOrganization: { id: "org-a", role: "admin" },
  };
  // The page header measures its breadcrumbs against the viewport.
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  server = settings();
  mocks.automation.mockImplementation(async () => server);
  mocks.members.mockResolvedValue(members);
  mocks.update.mockImplementation(
    async (_orgId: string, update: IntakeAutomationUpdate) => {
      server = applyUpdate(server, update);
      return server;
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IntakeSettings", () => {
  it("shows Email, Slack, Teams and Triage rules one after another", async () => {
    server = emailOn();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    expect(mocks.automation).toHaveBeenCalledWith("org-a");

    // The settings frame around it has the sections; it has no tabs of its own.
    expect(screen.queryByRole("tab")).toBeNull();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual(["Email", "Slack", "Teams", "Triage rules"]);
    expect(screen.queryByText("Recent messages")).not.toBeInTheDocument();

    const email = section("Email");
    // Titled outside their cards, as in Settings.
    expect(within(email).getByRole("heading", { name: "Email" })).toHaveClass(
      "text-xl",
    );
    expect(
      within(email).getByRole("switch", { name: "Record requests from email" }),
    ).toHaveAttribute("aria-checked", "true");
    // The connected mailbox, on its own lines, with how it is going.
    expect(within(email).getByText("intake@example.com")).toBeInTheDocument();
    expect(email).toHaveTextContent("Outlook (Microsoft 365)");
    expect(email).toHaveTextContent("Last read");
    expect(email).toHaveTextContent("New-mail notifications renew before");
    for (const name of [
      "Send test email",
      "Reconnect Outlook (Microsoft 365)",
      "Disconnect",
    ])
      expect(within(email).getByRole("button", { name })).toBeInTheDocument();
    expect(within(email).getByText("example.com")).toBeInTheDocument();
    expect(
      within(email).getByRole("button", { name: "Remove example.com" }),
    ).toBeInTheDocument();

    const slack = section("Slack");
    expect(
      within(slack).getByRole("switch", { name: "Record requests from Slack" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(slack).toHaveTextContent(
      "https://api.example.test/webhooks/intake/slack/0b6f",
    );
    expect(
      within(slack).getByRole("button", { name: "Copy Events Request URL" }),
    ).toBeInTheDocument();
    expect(slack).toHaveTextContent("Acme Legal");
    expect(slack).toHaveTextContent("MikeGC bot user U0BOT");

    // The models are chosen in Model Preferences, not here.
    expect(screen.queryByRole("button", { name: "Triage" })).toBeNull();
    // Intake keeps no timezone: dates show where the viewer is.
    expect(screen.queryByLabelText("Default timezone")).toBeNull();
    // The rules have a page of their own in the organization's settings,
    // which their section links to.
    const triage = section("Triage rules");
    const edit = within(triage).getByRole("link", { name: "Edit rules" });
    expect(edit).toHaveAttribute(
      "href",
      "/organizations/org-a/settings/intake/rules",
    );
    expect(edit).toHaveTextContent(/^Edit$/);
    expect(
      within(triage).getByRole("link", { name: "Model Preferences" }),
    ).toHaveAttribute("href", "/organizations/org-a/settings/models");
    expect(within(triage).queryByRole("textbox")).toBeNull();

    // There is no Save: nothing has changed, so nothing was sent.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("shows each section's setup in a small modal from its info button", async () => {
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const email = section("Email");
    expect(email).not.toHaveTextContent("People in your company email");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(
      within(email).getByRole("button", { name: "How to set up Email" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Set up Email" });
    expect(dialog).toHaveTextContent(/^Intake›Settings›Set up Email/);
    expect(dialog).toHaveTextContent(/People in your company email requests/);
    expect(dialog).toHaveTextContent("Exchange RBAC for Applications");
    expect(dialog).toHaveTextContent("domain-wide delegation");
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(5);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(
      within(section("Slack")).getByRole("button", {
        name: "How to set up Slack",
      }),
    );
    const slackGuide = screen.getByRole("dialog", { name: "Set up Slack" });
    expect(slackGuide).toHaveTextContent(/People write @MikeGC in Slack/);
    expect(slackGuide).toHaveTextContent(
      "app_mention, message.channels and message.groups",
    );
    await user.keyboard("{Escape}");

    await user.click(
      within(section("Teams")).getByRole("button", {
        name: "How to set up Teams",
      }),
    );
    const teamsGuide = screen.getByRole("dialog", { name: "Set up Teams" });
    expect(teamsGuide).toHaveTextContent("Azure Bot");
    expect(within(teamsGuide).getAllByRole("listitem")).toHaveLength(5);
  });

  it("hides a channel's setup while it is off", async () => {
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const email = section("Email");
    expect(
      within(email).getByRole("switch", { name: "Record requests from email" }),
    ).toHaveAttribute("aria-checked", "false");
    // Its connection stays in view; the rest of its setup waits.
    expect(within(email).getByText("intake@example.com")).toBeInTheDocument();
    expect(
      within(email).queryByLabelText("Allowed sender domains"),
    ).not.toBeInTheDocument();
    expect(within(email).queryByLabelText("Sender name")).toBeNull();

    const slack = section("Slack");
    expect(within(slack).getByLabelText("Signing Secret")).toBeInTheDocument();
    await user.click(
      within(slack).getByRole("switch", { name: "Record requests from Slack" }),
    );
    expect(
      within(slack).queryByLabelText("Signing Secret"),
    ).not.toBeInTheDocument();
    expect(
      within(slack).queryByRole("button", { name: "Copy Events Request URL" }),
    ).not.toBeInTheDocument();
  });

  it("saves a switch by itself, sending only that", async () => {
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    await user.click(
      screen.getByRole("switch", { name: "Record requests from email" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Saving…");
    await waitFor(
      () =>
        expect(mocks.update).toHaveBeenCalledWith("org-a", {
          email_enabled: true,
        }),
      SAVE_WAIT,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Saved"),
    );
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("switch", { name: "Record requests from email" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("saves a domain once it is added, never while it is typed", async () => {
    const user = userEvent.setup();
    server = emailOn();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const domain = screen.getByLabelText("Allowed sender domains");
    await user.type(domain, "Partner.Example.org");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(mocks.update).not.toHaveBeenCalled();

    // Add is a text button inside the field.
    const add = screen.getByRole("button", { name: "Add" });
    expect(domain.parentElement).toContainElement(add);
    await user.click(add);
    expect(
      screen.getByRole("button", { name: "Remove partner.example.org" }),
    ).toBeInTheDocument();
    await waitFor(
      () =>
        expect(mocks.update).toHaveBeenCalledWith("org-a", {
          email_allowed_domains: ["example.com", "partner.example.org"],
        }),
      SAVE_WAIT,
    );
    await user.click(
      screen.getByRole("button", { name: "Remove example.com" }),
    );
    await waitFor(
      () =>
        expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
          email_allowed_domains: ["partner.example.org"],
        }),
      SAVE_WAIT,
    );
  });

  it("turns a switch back when a save is refused, with no Retry", async () => {
    const user = userEvent.setup();
    mocks.update.mockRejectedValueOnce(
      Object.assign(
        new Error("Connect the intake mailbox before turning email on."),
        {
          status: 400,
          detail: "Connect the intake mailbox before turning email on.",
        },
      ),
    );
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const toggle = screen.getByRole("switch", {
      name: "Record requests from email",
    });
    await user.click(toggle);
    expect(await screen.findByRole("alert", {}, SAVE_WAIT)).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("turns a switch back when a save fails, and Retry sends the same save again", async () => {
    const user = userEvent.setup();
    mocks.update.mockRejectedValueOnce(
      Object.assign(new Error("Bad gateway"), { status: 502 }),
    );
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const toggle = screen.getByRole("switch", {
      name: "Record requests from Slack",
    });
    await user.click(toggle);
    await screen.findByRole("alert", {}, SAVE_WAIT);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(mocks.update).toHaveBeenCalledWith("org-a", {
      slack_enabled: false,
    });

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await waitFor(
      () => expect(mocks.update).toHaveBeenCalledTimes(2),
      SAVE_WAIT,
    );
    expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
      slack_enabled: false,
    });
  });

  it("never fills in a secret, saves a typed one only once complete, and clears it once saved", async () => {
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const slack = section("Slack");
    const secret = within(slack).getByLabelText("Signing Secret");
    const token = within(slack).getByLabelText("Bot User OAuth Token");
    for (const field of [secret, token]) {
      expect(field).toHaveAttribute("type", "password");
      expect(field).toHaveValue("");
      expect(field).toHaveAccessibleDescription(
        "Leave empty to keep the saved one.",
      );
    }
    expect(within(slack).getAllByText("Saved")).toHaveLength(2);

    // Part-typed, it is not sent, however long the pause.
    await user.type(secret, " s3cret ");
    expect(within(slack).getAllByText("Saved")).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(mocks.update).not.toHaveBeenCalled();

    // Leaving the field sends it, trimmed, and it is gone once saved.
    await user.tab();
    await waitFor(
      () =>
        expect(mocks.update).toHaveBeenCalledWith("org-a", {
          slack_signing_secret: "s3cret",
        }),
      SAVE_WAIT,
    );
    await waitFor(() => expect(secret).toHaveValue(""));

    // Enter sends one too.
    await user.type(token, "xoxb-new{Enter}");
    await waitFor(
      () =>
        expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
          slack_bot_token: "xoxb-new",
        }),
      SAVE_WAIT,
    );
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });

  it("asks for the secrets, with no Saved mark, before Slack is set up", async () => {
    server = settings({
      slack: {
        enabled: false,
        events_url: "https://api.example.test/webhooks/intake/slack/0b6f",
        configured: false,
        team_id: null,
        team_name: null,
        bot_user_id: null,
        missing_scopes: [],
        message_events_seen: false,
      },
    });
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const slack = section("Slack");
    await user.click(
      within(slack).getByRole("switch", { name: "Record requests from Slack" }),
    );
    expect(slack).toHaveTextContent(
      "Save the Signing Secret and Bot User OAuth Token to finish turning Slack on.",
    );
    expect(within(slack).queryByText("Saved")).not.toBeInTheDocument();
    expect(slack).not.toHaveTextContent("Connected workspace");
    expect(within(slack).getByLabelText("Signing Secret")).toHaveAttribute(
      "placeholder",
      "Paste the app's Signing Secret",
    );
    // Turned on but not set up, nothing is sent: the API would refuse it.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(mocks.update).not.toHaveBeenCalled();

    // With both secrets, Slack turns on in the same save.
    await user.type(within(slack).getByLabelText("Signing Secret"), "s3cret");
    await user.type(
      within(slack).getByLabelText("Bot User OAuth Token"),
      "xoxb-1{Enter}",
    );
    await user.tab();
    await waitFor(
      () =>
        expect(mocks.update).toHaveBeenCalledWith("org-a", {
          slack_enabled: true,
          slack_signing_secret: "s3cret",
          slack_bot_token: "xoxb-1",
        }),
      SAVE_WAIT,
    );
  });

  it("connects an Outlook mailbox, sending what the form holds", async () => {
    const user = userEvent.setup();
    server = settings({ email: unconnectedEmail() });
    mocks.connect.mockImplementation(
      async (_orgId: string, connection: IntakeMailboxConnection) => {
        server = {
          ...server,
          email: {
            ...connectedEmail(),
            mailbox: connection.mailbox,
            // The address's own domain is accepted from the start.
            allowed_domains: ["company.com"],
          },
        };
        return server;
      },
    );
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const email = section("Email");
    // Nothing is connected, so there is nothing to switch on yet.
    expect(
      within(email).queryByRole("switch", {
        name: "Record requests from email",
      }),
    ).toBeNull();
    expect(
      within(email).getByRole("button", {
        name: "Connect Gmail (Google Workspace)",
      }),
    ).toBeInTheDocument();
    await user.click(
      within(email).getByRole("button", {
        name: "Connect Outlook (Microsoft 365)",
      }),
    );
    const connect = within(email).getByRole("button", { name: "Connect" });
    // Each field is needed before it can connect.
    expect(connect).toBeDisabled();
    await user.type(
      within(email).getByLabelText("Intake address"),
      "intake@company.com",
    );
    await user.type(within(email).getByLabelText("Tenant ID"), "tenant-9");
    await user.type(within(email).getByLabelText("Client ID"), "client-9");
    const secret = within(email).getByLabelText("Client secret");
    expect(secret).toHaveAttribute("type", "password");
    expect(connect).toBeDisabled();
    await user.type(secret, "s3cret");
    expect(connect).toBeEnabled();
    await user.click(connect);
    await waitFor(() =>
      expect(mocks.connect).toHaveBeenCalledWith("org-a", {
        provider: "graph",
        mailbox: "intake@company.com",
        tenant_id: "tenant-9",
        client_id: "client-9",
        client_secret: "s3cret",
      }),
    );
    expect(
      await within(email).findByText("intake@company.com"),
    ).toBeInTheDocument();
    expect(mocks.success).toHaveBeenCalledWith("Connected intake@company.com");
    expect(within(email).queryByLabelText("Client secret")).toBeNull();
    // Connecting changes no other setting.
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("says under the form why a mailbox couldn't connect", async () => {
    const user = userEvent.setup();
    server = settings({ email: unconnectedEmail() });
    const detail =
      "Microsoft 365 didn't accept these credentials. Check the tenant ID, client ID and client secret.";
    mocks.connect.mockRejectedValue(
      Object.assign(new Error(detail), { status: 400, detail }),
    );
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const email = section("Email");
    await user.click(
      within(email).getByRole("button", {
        name: "Connect Outlook (Microsoft 365)",
      }),
    );
    await user.type(
      within(email).getByLabelText("Intake address"),
      "intake@company.com",
    );
    await user.type(within(email).getByLabelText("Tenant ID"), "t");
    await user.type(within(email).getByLabelText("Client ID"), "c");
    await user.type(within(email).getByLabelText("Client secret"), "s");
    await user.click(within(email).getByRole("button", { name: "Connect" }));
    expect(await within(email).findByRole("alert")).toHaveTextContent(
      "Microsoft 365 didn't accept these credentials.",
    );
    // The form stays, with what was typed, to correct.
    expect(within(email).getByLabelText("Tenant ID")).toHaveValue("t");
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("shows the service account's client ID to delegate for Gmail, or says the deployment has none", async () => {
    const user = userEvent.setup();
    server = settings({ email: unconnectedEmail() });
    mocks.connect.mockImplementation(async () => server);
    render(<IntakeSettings orgId="org-a" />);
    await form();
    let email = section("Email");
    await user.click(
      within(email).getByRole("button", {
        name: "Connect Gmail (Google Workspace)",
      }),
    );
    expect(email).toHaveTextContent("1122334455");
    expect(email).toHaveTextContent(
      "https://www.googleapis.com/auth/gmail.modify",
    );
    expect(within(email).queryByLabelText("Client secret")).toBeNull();
    await user.type(
      within(email).getByLabelText("Intake address"),
      "intake@company.com",
    );
    await user.click(within(email).getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(mocks.connect).toHaveBeenCalledWith("org-a", {
        provider: "gmail",
        mailbox: "intake@company.com",
      }),
    );

    cleanup();
    server = settings({ email: unconnectedEmail({ gmail_client_id: null }) });
    render(<IntakeSettings orgId="org-a" />);
    await form();
    email = section("Email");
    await user.click(
      within(email).getByRole("button", {
        name: "Connect Gmail (Google Workspace)",
      }),
    );
    expect(email).toHaveTextContent("INTAKE_GMAIL_SERVICE_ACCOUNT_KEY");
    expect(
      within(email).getByRole("button", { name: "Connect" }),
    ).toBeDisabled();
  });

  it("asks an organization that used Postmark to connect its mailbox", async () => {
    server = settings({ email: unconnectedEmail({ needs_reconnect: true }) });
    render(<IntakeSettings orgId="org-a" />);
    await form();
    expect(section("Email")).toHaveTextContent(
      "Connect your intake mailbox to keep recording email.",
    );
  });

  it("sends a test email and asks before disconnecting", async () => {
    const user = userEvent.setup();
    mocks.test.mockResolvedValue({ sent_to: "admin@example.com" });
    mocks.disconnect.mockImplementation(async () => {
      server = settings({ email: unconnectedEmail() });
      return server;
    });
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const email = section("Email");
    await user.click(
      within(email).getByRole("button", { name: "Send test email" }),
    );
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith(
        "Test email sent to admin@example.com",
      ),
    );
    expect(mocks.test).toHaveBeenCalledWith("org-a");

    await user.click(within(email).getByRole("button", { name: "Disconnect" }));
    await user.click(
      within(
        screen.getByRole("dialog", { name: "Disconnect the intake mailbox?" }),
      ).getByRole("button", { name: "Keep connected" }),
    );
    expect(mocks.disconnect).not.toHaveBeenCalled();
    await user.click(within(email).getByRole("button", { name: "Disconnect" }));
    await user.click(
      within(
        screen.getByRole("dialog", { name: "Disconnect the intake mailbox?" }),
      ).getByRole("button", { name: "Disconnect" }),
    );
    await waitFor(() =>
      expect(mocks.disconnect).toHaveBeenCalledWith("org-a"),
    );
    expect(
      await within(email).findByRole("button", {
        name: "Connect Outlook (Microsoft 365)",
      }),
    ).toBeInTheDocument();
  });

  it("saves the sender name once typing pauses", async () => {
    const user = userEvent.setup();
    server = emailOn();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const name = within(section("Email")).getByLabelText("Sender name");
    expect(name).toHaveValue("Legal");
    await user.clear(name);
    await user.type(name, "Legal team");
    await waitFor(
      () =>
        expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
          email_from_name: "Legal team",
        }),
      SAVE_WAIT,
    );
  });

  it("asks for a Slack reinstall when the token lacks the loop's scopes, or no thread message has come", async () => {
    server = settings({
      slack: {
        ...settings().slack,
        missing_scopes: ["files:write", "chat:write.customize"],
        message_events_seen: false,
      },
    });
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const slack = section("Slack");
    expect(slack).toHaveTextContent(
      "Reinstall the Slack app to send documents.",
    );
    expect(slack).toHaveTextContent("files:write, chat:write.customize");
    expect(slack).toHaveTextContent(
      "MikeGC hasn't received a thread message yet.",
    );
  });

  it("sets up Teams: IDs save once typed in full, the secret is write-only, and Teams turns on with all three", async () => {
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const teams = section("Teams");
    expect(within(teams).queryByLabelText("App ID")).toBeNull();
    await user.click(
      within(teams).getByRole("switch", { name: "Record requests from Teams" }),
    );
    expect(teams).toHaveTextContent(
      "Save the app ID, tenant ID and client secret to finish turning Teams on.",
    );
    expect(teams).toHaveTextContent(
      "https://api.example.test/webhooks/intake/teams/5e2a",
    );
    await user.type(within(teams).getByLabelText("App ID"), "app-1");
    // Part-typed, nothing is sent.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(mocks.update).not.toHaveBeenCalled();
    await user.tab();
    await waitFor(
      () =>
        expect(mocks.update).toHaveBeenCalledWith("org-a", {
          teams_app_id: "app-1",
        }),
      SAVE_WAIT,
    );
    await user.type(
      within(teams).getByLabelText("Tenant ID"),
      "tenant-1{Enter}",
    );
    await waitFor(
      () =>
        expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
          teams_tenant_id: "tenant-1",
        }),
      SAVE_WAIT,
    );
    const secret = within(teams).getByLabelText("Client secret");
    expect(secret).toHaveAttribute("type", "password");
    await user.type(secret, "s3cret{Enter}");
    await waitFor(
      () =>
        expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
          teams_enabled: true,
          teams_client_secret: "s3cret",
        }),
      SAVE_WAIT,
    );
    await waitFor(() => expect(secret).toHaveValue(""));
    expect(teams).toHaveTextContent("Document access");
    expect(teams).toHaveTextContent("Not checked yet");
  });

  it("saves asking requesters for missing details from the Triage rules section", async () => {
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const ask = within(section("Triage rules")).getByRole("switch", {
      name: "Ask requesters for missing details",
    });
    expect(ask).toHaveAttribute("aria-checked", "true");
    expect(ask).toHaveAccessibleDescription(/two rounds of questions/);
    await user.click(ask);
    await waitFor(
      () =>
        expect(mocks.update).toHaveBeenCalledWith("org-a", {
          clarify_enabled: false,
        }),
      SAVE_WAIT,
    );
  });

  it("refuses an invalid domain inline, and doesn't save it", async () => {
    const user = userEvent.setup();
    server = emailOn();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const domain = screen.getByLabelText("Allowed sender domains");
    await user.type(domain, "not a domain{Enter}");
    expect(
      screen.getByText("Enter a domain like example.com."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("tells a member who isn't an owner or admin that they cannot change it", async () => {
    mocks.automation.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 }),
    );
    render(<IntakeSettings orgId="org-a" />);
    expect(
      await screen.findByText(
        "Only owners and admins can change automated intake.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a failed load as an error with Try again", async () => {
    const user = userEvent.setup();
    mocks.automation.mockRejectedValueOnce(
      Object.assign(new Error("Unavailable"), { status: 503 }),
    );
    render(<IntakeSettings orgId="org-a" />);
    expect(
      await screen.findByText("Unable to load the settings"),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await form()).toBeInTheDocument();
    expect(mocks.automation).toHaveBeenCalledTimes(2);
  });

  it("shows the page's layout while it loads: the first section", () => {
    mocks.automation.mockReturnValue(new Promise(() => {}));
    render(<IntakeSettings orgId="org-a" />);
    const skeleton = screen.getByLabelText("Loading the intake settings");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    // The save status's line, then Email's heading and card.
    expect(skeleton.children).toHaveLength(2);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("points Personal to the person's own rules and Model Preferences", async () => {
    server = settings({ rules: [] });
    render(<IntakeSettings orgId="personal" />);
    await form();
    expect(mocks.automation).toHaveBeenCalledWith("personal");
    const triage = section("Triage rules");
    expect(
      within(triage).getByRole("link", { name: "Edit rules" }),
    ).toHaveAttribute("href", "/settings/intake/rules");
    expect(
      within(triage).getByRole("link", { name: "Model Preferences" }),
    ).toHaveAttribute("href", "/settings/models");
  });
});

describe("IntakeModelSettings", () => {
  const models = () => screen.findByRole("region", { name: "Intake" });

  it("shows the models triage and preprocessing run with", async () => {
    render(<IntakeModelSettings orgId="org-a" />);
    const section = await models();
    expect(mocks.automation).toHaveBeenCalledWith("org-a");
    // Triage can't be switched off; it runs with the model chosen here, and
    // preprocessing with its own.
    expect(within(section).queryByRole("switch")).toBeNull();
    expect(
      within(section).getByRole("button", { name: "Triage" }),
    ).toHaveTextContent("Claude Haiku 4.5");
    expect(
      within(section).getByRole("button", { name: "AI preprocessing" }),
    ).toHaveTextContent("Claude Sonnet 5.5");
    expect(section).not.toHaveTextContent("API key");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("shows its layout while it loads", () => {
    mocks.automation.mockReturnValue(new Promise(() => {}));
    render(<IntakeModelSettings orgId="org-a" />);
    expect(screen.getByLabelText("Loading intake's models")).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("tells a member they can't change it", async () => {
    mocks.automation.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 }),
    );
    render(<IntakeModelSettings orgId="org-a" />);
    expect(
      await screen.findByText(
        "Only owners and admins can change intake's models.",
      ),
    ).toBeInTheDocument();
  });

  it("points Personal to the person's own keys", async () => {
    server = settings({
      models: {
        available: [],
        triage: null,
        triage_available: false,
        preprocessing: null,
        preprocessing_available: false,
      },
    });
    render(<IntakeModelSettings orgId="personal" />);
    const section = await models();
    expect(mocks.automation).toHaveBeenCalledWith("personal");
    expect(
      within(section).getAllByRole("link", {
        name: "Add one in Bring Your Own Keys",
      })[0],
    ).toHaveAttribute("href", "/settings/byok");
  });

  it("saves the model chosen, and can stop triage by choosing none", async () => {
    const user = userEvent.setup();
    render(<IntakeModelSettings orgId="org-a" />);
    await models();
    const model = screen.getByRole("button", { name: "Triage" });
    await user.click(model);
    // Grouped by provider, as other model pickers are.
    expect(await screen.findByText("OpenAI")).toBeInTheDocument();
    await user.click(
      screen.getByRole("menuitemradio", { name: "Claude Sonnet 5.5" }),
    );
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
        triage_model: "claude-sonnet-5-5",
      }),
    );
    expect(model).toHaveTextContent("Claude Sonnet 5.5");
    await user.click(model);
    await user.click(
      await screen.findByRole("menuitemradio", {
        name: /^No model\s*Triage doesn.t run/,
      }),
    );
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
        triage_model: null,
      }),
    );
    expect(model).toHaveTextContent("No model");
    expect(section("Intake")).toHaveTextContent(
      "Choose a model for triage to run.",
    );
  });

  it("saves preprocessing's model on its own", async () => {
    const user = userEvent.setup();
    render(<IntakeModelSettings orgId="org-a" />);
    await models();
    const model = screen.getByRole("button", { name: "AI preprocessing" });
    await user.click(model);
    await user.click(
      await screen.findByRole("menuitemradio", { name: "GPT-6 Luna" }),
    );
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
        preprocessing_model: "gpt-6-luna",
      }),
    );
    expect(model).toHaveTextContent("GPT-6 Luna");
    await user.click(model);
    await user.click(
      await screen.findByRole("menuitemradio", {
        name: /^No model\s*Preprocessing doesn.t run/,
      }),
    );
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
        preprocessing_model: null,
      }),
    );
    expect(section("Intake")).toHaveTextContent(
      "Choose a model for preprocessing to run.",
    );
  });

  it("says when the chosen model has lost its key", async () => {
    server = settings({
      models: {
        available: ["claude-haiku-4-5"],
        triage: "gpt-6-luna",
        triage_available: false,
        preprocessing: "claude-haiku-4-5",
        preprocessing_available: true,
      },
    });
    render(<IntakeModelSettings orgId="org-a" />);
    await models();
    const triage = section("Intake");
    expect(
      within(triage).getByRole("button", { name: "Triage" }),
    ).toHaveTextContent("GPT-6 Luna");
    expect(triage).toHaveTextContent("This model has no API key.");
    // Other models have keys, so another can be chosen.
    expect(
      within(triage).getByRole("button", { name: "Triage" }),
    ).toBeEnabled();
    expect(
      within(triage).getByRole("link", {
        name: "Add one in Bring Your Own Keys",
      }),
    ).toBeInTheDocument();
  });

  it("says when triage has no model, linking to the organization's keys", async () => {
    server = settings({
      models: {
        available: [],
        triage: null,
        triage_available: false,
        preprocessing: null,
        preprocessing_available: false,
      },
    });
    render(<IntakeModelSettings orgId="org-a" />);
    await models();
    const triage = section("Intake");
    // With no key at all there is nothing to choose.
    expect(
      within(triage).getAllByText("No model has an API key."),
    ).toHaveLength(2);
    for (const name of ["Triage", "AI preprocessing"])
      expect(within(triage).getByRole("button", { name })).toBeDisabled();
    expect(triage).not.toHaveTextContent("without AI");
    expect(
      within(triage).getAllByRole("link", {
        name: "Add one in Bring Your Own Keys",
      })[0],
    ).toHaveAttribute("href", "/organizations/org-a/settings/providers");
  });
});

describe("IntakeSettingsRedirect", () => {
  it.each([
    ["org-a", "settings", "/organizations/org-a/settings/intake"],
    ["org-a", "rules", "/organizations/org-a/settings/intake/rules"],
    ["personal", "settings", "/settings/intake"],
    ["personal", "rules", "/settings/intake/rules"],
  ] as const)(
    "sends an old link in %s to its %s in the workspace's settings",
    (workspaceId, to, href) => {
      mocks.workspace = { ...mocks.workspace, workspaceId };
      render(<IntakeSettingsRedirect to={to} />);
      expect(mocks.replace).toHaveBeenCalledWith(href);
    },
  );
});

describe("IntakePageHeader", () => {
  it.each([
    ["an owner", { id: "org-a", role: "owner" }, "org-a", true],
    ["an admin", { id: "org-a", role: "admin" }, "org-a", true],
    ["a member", { id: "org-a", role: "member" }, "org-a", false],
    ["Personal's owner", null, "personal", true],
  ])(
    "offers the intake settings to %s: %s",
    (_who, organization, workspaceId, shown) => {
      mocks.workspace = {
        accountId: "account-a",
        workspaceId: workspaceId as string,
        activeOrganization: organization,
      };
      render(<IntakePageHeader page="requests" />);
      expect(
        screen.getByRole("button", { name: "Dashboard" }),
      ).toBeInTheDocument();
      expect(!!screen.queryByRole("button", { name: "Intake settings" })).toBe(
        shown,
      );
      // The rules are reached from the settings, not from Intake's header.
      expect(screen.queryByRole("button", { name: "Rules" })).toBeNull();
    },
  );

  it("leaves Settings out while the organization's role is unknown", () => {
    mocks.workspace = {
      accountId: "account-a",
      workspaceId: "org-a",
      activeOrganization: null,
    };
    render(<IntakePageHeader page="dashboard" />);
    expect(
      screen.queryByRole("button", { name: "Intake settings" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["org-a", "/organizations/org-a/settings/intake"],
    ["personal", "/settings/intake"],
  ])("opens the settings in %s's own settings", async (workspaceId, href) => {
    const user = userEvent.setup();
    mocks.workspace = { ...mocks.workspace, workspaceId };
    render(<IntakePageHeader page="dashboard" />);
    const settings = screen.getByRole("button", { name: "Intake settings" });
    // A settings icon, with no text beside it.
    expect(settings).toHaveTextContent(/^$/);
    await user.click(settings);
    expect(mocks.push).toHaveBeenCalledWith(href);
  });
});
