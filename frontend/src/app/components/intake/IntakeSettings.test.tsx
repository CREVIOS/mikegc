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
  const card = (name: string) => screen.getByRole("article", { name });
  /** Opens a channel's modal from its card's button. */
  async function openModal(
    user: ReturnType<typeof userEvent.setup>,
    button: string,
    name: string,
  ) {
    await user.click(screen.getByRole("button", { name: button }));
    return screen.findByRole("dialog", { name });
  }

  it("shows each channel as a card with Set up or Manage, then Triage rules", async () => {
    render(<IntakeSettings orgId="org-a" />);
    await form();
    expect(mocks.automation).toHaveBeenCalledWith("org-a");
    expect(screen.queryByRole("tab")).toBeNull();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual(["Channels", "Triage rules"]);

    // One line of status each, and one button naming the channel.
    expect(card("Email")).toHaveTextContent(
      "Off · intake@example.com · Outlook",
    );
    expect(card("Slack")).toHaveTextContent("On · Acme Legal");
    expect(card("Teams")).toHaveTextContent("Not set up");
    for (const name of ["Manage Email", "Manage Slack", "Set up Teams"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveAttribute("aria-haspopup", "dialog");
    }
    expect(
      within(card("Teams")).getByRole("button", { name: "Set up Teams" }),
    ).toHaveTextContent(/^Set up$/);
    // No fields, secrets or steps on the cards themselves.
    expect(section("Channels").querySelector("input")).toBeNull();
    expect(screen.queryByLabelText("Signing Secret")).toBeNull();
    expect(screen.queryByRole("switch", { name: /Record requests/ })).toBeNull();
    expect(screen.queryByText("How to set it up")).toBeNull();

    // The rules have a page of their own in the organization's settings.
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
    // Nothing has changed, so nothing was sent.
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("says on a card what needs attention", async () => {
    server = settings({
      email: unconnectedEmail({ needs_reconnect: true }),
      slack: { ...settings().slack, missing_scopes: ["files:write"] },
      teams: {
        ...settings().teams,
        enabled: true,
        configured: true,
        app_id: "app-1",
        tenant_id: "tenant-1",
        files_access: false,
      },
    });
    render(<IntakeSettings orgId="org-a" />);
    await form();
    expect(card("Email")).toHaveTextContent("Not set up");
    expect(card("Email")).toHaveTextContent(
      "Connect your intake mailbox to keep recording email.",
    );
    expect(
      screen.getByRole("button", { name: "Set up Email" }),
    ).toBeInTheDocument();
    expect(card("Slack")).toHaveTextContent(
      "Reinstall the Slack app to send documents.",
    );
    expect(card("Teams")).toHaveTextContent("On");
    expect(card("Teams")).toHaveTextContent(
      "Document access isn't set up, so MikeGC posts text only.",
    );

    cleanup();
    server = settings({
      email: {
        ...connectedEmail(),
        status: {
          ...connectedEmail().status,
          error: "Microsoft 365 refused MikeGC's credentials. Reconnect the mailbox.",
        },
      },
    });
    render(<IntakeSettings orgId="org-a" />);
    await form();
    expect(card("Email")).toHaveTextContent(
      "Microsoft 365 refused MikeGC's credentials.",
    );
  });

  it("opens a channel's modal named for it, with its fields and steps, and gives focus back on close", async () => {
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const manage = screen.getByRole("button", { name: "Manage Slack" });
    const dialog = await openModal(user, "Manage Slack", "Slack");
    // Focus moves into the modal.
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    expect(
      within(dialog).getByRole("switch", { name: "Record requests from Slack" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(dialog).toHaveTextContent(
      "https://api.example.test/webhooks/intake/slack/0b6f",
    );
    expect(
      within(dialog).getByRole("button", { name: "Copy Events Request URL" }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Acme Legal");
    expect(dialog).toHaveTextContent("MikeGC bot user U0BOT");
    // The setup steps are in the modal now.
    expect(dialog).toHaveTextContent("How to set it up");
    expect(dialog).toHaveTextContent(
      "app_mention, message.channels and message.groups",
    );
    // Nothing changed: there is nothing to save.
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(manage).toHaveFocus();
  });

  it("never fills in a secret, and saves a typed one only with Save", async () => {
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const dialog = await openModal(user, "Manage Slack", "Slack");
    const secret = within(dialog).getByLabelText("Signing Secret");
    const token = within(dialog).getByLabelText("Bot User OAuth Token");
    for (const field of [secret, token]) {
      expect(field).toHaveAttribute("type", "password");
      expect(field).toHaveValue("");
      expect(field).toHaveAccessibleDescription(
        "Leave empty to keep the saved one.",
      );
    }
    expect(within(dialog).getAllByText("Saved")).toHaveLength(2);
    await user.type(secret, " s3cret ");
    expect(within(dialog).getAllByText("Saved")).toHaveLength(1);
    // Typed, it isn't sent until saved, however long the pause.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(mocks.update).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith("org-a", {
        slack_signing_secret: "s3cret",
      }),
    );
    // Saved, the modal closes and says so.
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(mocks.success).toHaveBeenCalledWith("Slack settings saved");
    // Enter in a secret saves it too.
    const again = await openModal(user, "Manage Slack", "Slack");
    await user.type(
      within(again).getByLabelText("Bot User OAuth Token"),
      "xoxb-new{Enter}",
    );
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
        slack_bot_token: "xoxb-new",
      }),
    );
  });

  it("discards what wasn't saved when the modal is closed", async () => {
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    let dialog = await openModal(user, "Manage Slack", "Slack");
    await user.type(within(dialog).getByLabelText("Signing Secret"), "half");
    await user.click(
      within(dialog).getByRole("switch", { name: "Record requests from Slack" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    dialog = await openModal(user, "Manage Slack", "Slack");
    expect(within(dialog).getByLabelText("Signing Secret")).toHaveValue("");
    expect(
      within(dialog).getByRole("switch", { name: "Record requests from Slack" }),
    ).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("sets up Teams in one save: its switch, IDs and write-only secret", async () => {
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const dialog = await openModal(user, "Set up Teams", "Teams");
    const toggle = within(dialog).getByRole("switch", {
      name: "Record requests from Teams",
    });
    await user.click(toggle);
    expect(dialog).toHaveTextContent(
      "Save the app ID, tenant ID and client secret to finish turning Teams on.",
    );
    expect(dialog).toHaveTextContent(
      "https://api.example.test/webhooks/intake/teams/5e2a",
    );
    await user.type(within(dialog).getByLabelText("App ID"), "app-1");
    await user.type(within(dialog).getByLabelText("Tenant ID"), "tenant-1");
    const secret = within(dialog).getByLabelText("Client secret");
    expect(secret).toHaveAttribute("type", "password");
    await user.type(secret, "s3cret");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith("org-a", {
        teams_enabled: true,
        teams_app_id: "app-1",
        teams_tenant_id: "tenant-1",
        teams_client_secret: "s3cret",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    // Set up now, its card offers Manage.
    expect(card("Teams")).toHaveTextContent("On");
    const manage = screen.getByRole("button", { name: "Manage Teams" });
    await user.click(manage);
    const managing = await screen.findByRole("dialog", { name: "Teams" });
    expect(managing).toHaveTextContent("Document access");
    expect(managing).toHaveTextContent("Not checked yet");
    expect(within(managing).getByLabelText("App ID")).toHaveValue("app-1");
  });

  it("shows a refused save in the modal and keeps what was typed", async () => {
    const user = userEvent.setup();
    const detail =
      "Save the Slack app's signing secret and bot token before turning Slack on.";
    server = settings({
      slack: {
        ...settings().slack,
        enabled: false,
        configured: false,
        team_id: null,
        team_name: null,
        bot_user_id: null,
      },
    });
    mocks.update.mockRejectedValueOnce(
      Object.assign(new Error(detail), { status: 400, detail }),
    );
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const dialog = await openModal(user, "Set up Slack", "Slack");
    // No Saved marks before anything is saved.
    expect(within(dialog).queryByText("Saved")).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Signing Secret")).toHaveAttribute(
      "placeholder",
      "Paste the app's Signing Secret",
    );
    await user.click(
      within(dialog).getByRole("switch", { name: "Record requests from Slack" }),
    );
    await user.type(within(dialog).getByLabelText("Signing Secret"), "s3cret");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(detail);
    expect(within(dialog).getByLabelText("Signing Secret")).toHaveValue(
      "s3cret",
    );
    expect(mocks.update).toHaveBeenCalledWith("org-a", {
      slack_enabled: true,
      slack_signing_secret: "s3cret",
    });
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("connects an Outlook mailbox from the email modal, which then manages it", async () => {
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
    const dialog = await openModal(user, "Set up Email", "Email");
    // Nothing to switch on until a mailbox is connected.
    expect(
      within(dialog).queryByRole("switch", { name: "Record requests from email" }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", {
        name: "Connect Gmail (Google Workspace)",
      }),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", {
        name: "Connect Outlook (Microsoft 365)",
      }),
    );
    const connect = within(dialog).getByRole("button", { name: "Connect" });
    // Each field is needed before it can connect.
    expect(connect).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText("Intake address"),
      "intake@company.com",
    );
    await user.type(within(dialog).getByLabelText("Tenant ID"), "tenant-9");
    await user.type(within(dialog).getByLabelText("Client ID"), "client-9");
    const secret = within(dialog).getByLabelText("Client secret");
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
    expect(mocks.success).toHaveBeenCalledWith("Connected intake@company.com");
    // The modal stays open to finish: the switch, domains, a test.
    expect(
      await within(dialog).findByRole("switch", {
        name: "Record requests from email",
      }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("intake@company.com")).toBeInTheDocument();
    expect(within(dialog).getByText("company.com")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Client secret")).toBeNull();
    // And the card behind it says so.
    expect(card("Email")).toHaveTextContent("intake@company.com · Outlook");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("says in the modal why a mailbox couldn't connect", async () => {
    const user = userEvent.setup();
    server = settings({ email: unconnectedEmail() });
    const detail =
      "Microsoft 365 didn't accept these credentials. Check the tenant ID, client ID and client secret.";
    mocks.connect.mockRejectedValue(
      Object.assign(new Error(detail), { status: 400, detail }),
    );
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const dialog = await openModal(user, "Set up Email", "Email");
    await user.click(
      within(dialog).getByRole("button", {
        name: "Connect Outlook (Microsoft 365)",
      }),
    );
    await user.type(
      within(dialog).getByLabelText("Intake address"),
      "intake@company.com",
    );
    await user.type(within(dialog).getByLabelText("Tenant ID"), "t");
    await user.type(within(dialog).getByLabelText("Client ID"), "c");
    await user.type(within(dialog).getByLabelText("Client secret"), "s");
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Microsoft 365 didn't accept these credentials.",
    );
    // The form stays, with what was typed, to correct.
    expect(within(dialog).getByLabelText("Tenant ID")).toHaveValue("t");
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("shows the service account's client ID to delegate for Gmail, or says the deployment has none", async () => {
    const user = userEvent.setup();
    server = settings({ email: unconnectedEmail() });
    mocks.connect.mockImplementation(async () => server);
    render(<IntakeSettings orgId="org-a" />);
    await form();
    let dialog = await openModal(user, "Set up Email", "Email");
    await user.click(
      within(dialog).getByRole("button", {
        name: "Connect Gmail (Google Workspace)",
      }),
    );
    expect(dialog).toHaveTextContent("1122334455");
    expect(dialog).toHaveTextContent(
      "https://www.googleapis.com/auth/gmail.modify",
    );
    expect(within(dialog).queryByLabelText("Client secret")).toBeNull();
    await user.type(
      within(dialog).getByLabelText("Intake address"),
      "intake@company.com",
    );
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
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
    dialog = await openModal(user, "Set up Email", "Email");
    await user.click(
      within(dialog).getByRole("button", {
        name: "Connect Gmail (Google Workspace)",
      }),
    );
    expect(dialog).toHaveTextContent("INTAKE_GMAIL_SERVICE_ACCOUNT_KEY");
    expect(
      within(dialog).getByRole("button", { name: "Connect" }),
    ).toBeDisabled();
  });

  it("asks an organization that used Postmark to connect its mailbox", async () => {
    const user = userEvent.setup();
    server = settings({ email: unconnectedEmail({ needs_reconnect: true }) });
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const dialog = await openModal(user, "Set up Email", "Email");
    expect(dialog).toHaveTextContent(
      "MikeGC no longer receives mail through Postmark.",
    );
  });

  it("sends a test email and disconnects only after confirming", async () => {
    const user = userEvent.setup();
    mocks.test.mockResolvedValue({ sent_to: "admin@example.com" });
    mocks.disconnect.mockImplementation(async () => {
      server = settings({ email: unconnectedEmail() });
      return server;
    });
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const dialog = await openModal(user, "Manage Email", "Email");
    expect(dialog).toHaveTextContent("Outlook (Microsoft 365)");
    expect(dialog).toHaveTextContent("Last read");
    expect(dialog).toHaveTextContent("New-mail notifications renew before");
    await user.click(
      within(dialog).getByRole("button", { name: "Send test email" }),
    );
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith(
        "Test email sent to admin@example.com",
      ),
    );
    expect(mocks.test).toHaveBeenCalledWith("org-a");

    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    const confirm = within(dialog).getByRole("group", {
      name: "Disconnect the intake mailbox?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Keep connected" }),
    );
    expect(mocks.disconnect).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await user.click(
      within(
        within(dialog).getByRole("group", {
          name: "Disconnect the intake mailbox?",
        }),
      ).getByRole("button", { name: "Disconnect" }),
    );
    await waitFor(() =>
      expect(mocks.disconnect).toHaveBeenCalledWith("org-a"),
    );
    expect(
      await within(dialog).findByRole("button", {
        name: "Connect Outlook (Microsoft 365)",
      }),
    ).toBeInTheDocument();
    expect(card("Email")).toHaveTextContent("Not set up");
  });

  it("saves the mailbox's switch, sender name and domains together with Save", async () => {
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const dialog = await openModal(user, "Manage Email", "Email");
    await user.click(
      within(dialog).getByRole("switch", { name: "Record requests from email" }),
    );
    const name = within(dialog).getByLabelText("Sender name");
    expect(name).toHaveValue("Legal");
    await user.clear(name);
    await user.type(name, "Legal team");
    const domain = within(dialog).getByLabelText("Allowed sender domains");
    await user.type(domain, "Partner.Example.org");
    // Add is a text button inside the field.
    const add = within(dialog).getByRole("button", { name: "Add" });
    expect(domain.parentElement).toContainElement(add);
    await user.click(add);
    await user.click(
      within(dialog).getByRole("button", { name: "Remove example.com" }),
    );
    // A domain typed but not yet added goes with the save too.
    await user.type(domain, "eu.example.com");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(mocks.update).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith("org-a", {
        email_enabled: true,
        email_allowed_domains: ["partner.example.org", "eu.example.com"],
        email_from_name: "Legal team",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(card("Email")).toHaveTextContent("On · intake@example.com");
  });

  it("refuses an invalid domain inline, and doesn't save it", async () => {
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const dialog = await openModal(user, "Manage Email", "Email");
    const domain = within(dialog).getByLabelText("Allowed sender domains");
    await user.type(domain, "not a domain{Enter}");
    expect(
      within(dialog).getByText("Enter a domain like example.com."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Add" })).toBeDisabled();
    // Nothing else changed, so there is nothing to save.
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("won't save other changes while a typed domain is invalid", async () => {
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const dialog = await openModal(user, "Manage Email", "Email");
    const name = within(dialog).getByLabelText("Sender name");
    expect(name).toHaveAttribute("maxLength", "80");
    await user.clear(name);
    await user.type(name, "Legal Ops");
    await user.type(
      within(dialog).getByLabelText("Allowed sender domains"),
      "not a domain",
    );
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    // Enter in another field doesn't send the change without the domain.
    await user.type(name, "{Enter}");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("raises a save that failed for another reason as a notice with Retry", async () => {
    const user = userEvent.setup();
    mocks.update.mockRejectedValueOnce(
      Object.assign(new Error("Bad gateway"), { status: 502 }),
    );
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const dialog = await openModal(user, "Manage Slack", "Slack");
    await user.type(within(dialog).getByLabelText("Signing Secret"), "s3cret");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(1));
    const [, options] = mocks.notify.mock.calls[0] as [
      unknown,
      { action: string; onRetry: () => void },
    ];
    expect(options.action).toBe("save the Slack settings");
    // Nothing on screen is wrong, so nothing is shown beside the fields.
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBe(dialog);
    options.onRetry();
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
      slack_signing_secret: "s3cret",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("sends only what failed when Retry comes after the modal closed", async () => {
    const user = userEvent.setup();
    mocks.update.mockRejectedValueOnce(
      Object.assign(new Error("Bad gateway"), { status: 502 }),
    );
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const dialog = await openModal(user, "Manage Slack", "Slack");
    await user.type(within(dialog).getByLabelText("Signing Secret"), "s3cret");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(1));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const [, options] = mocks.notify.mock.calls[0] as [
      unknown,
      { onRetry: () => void },
    ];
    options.onRetry();
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("Slack settings saved"),
    );
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
      slack_signing_secret: "s3cret",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
    expect(await screen.findByRole("status")).toHaveTextContent("Saving…");
    await waitFor(
      () =>
        expect(mocks.update).toHaveBeenCalledWith("org-a", {
          clarify_enabled: false,
        }),
      SAVE_WAIT,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Saved"),
    );
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("turns the switch back when its save fails, and Retry sends the same save again", async () => {
    const user = userEvent.setup();
    mocks.update.mockRejectedValueOnce(
      Object.assign(new Error("Bad gateway"), { status: 502 }),
    );
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const toggle = screen.getByRole("switch", {
      name: "Ask requesters for missing details",
    });
    await user.click(toggle);
    await screen.findByRole("alert", {}, SAVE_WAIT);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await waitFor(
      () => expect(mocks.update).toHaveBeenCalledTimes(2),
      SAVE_WAIT,
    );
    expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
      clarify_enabled: false,
    });
  });

  it("never sends a channel back after its modal saved", async () => {
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const dialog = await openModal(user, "Manage Email", "Email");
    await user.click(
      within(dialog).getByRole("switch", { name: "Record requests from email" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith("org-a", {
        email_enabled: true,
      }),
    );
    // The page's own autosave then has nothing to send.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(mocks.update).toHaveBeenCalledTimes(1);
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

  it("shows the page's layout while it loads: the channel cards", () => {
    mocks.automation.mockReturnValue(new Promise(() => {}));
    render(<IntakeSettings orgId="org-a" />);
    const skeleton = screen.getByLabelText("Loading the intake settings");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    // The save status's line, then the Channels heading and its three cards.
    expect(skeleton.children).toHaveLength(2);
    expect(
      skeleton.querySelectorAll(".rounded-full.h-7.w-20, .h-7.w-20.rounded-full"),
    ).toHaveLength(3);
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
