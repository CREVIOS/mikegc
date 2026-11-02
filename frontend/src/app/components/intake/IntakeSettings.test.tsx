import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes } from "react";
import type {
  IntakeAutomationSettings,
  IntakeEmailWebhook,
  IntakeMember,
} from "@mike/contracts";
import { IntakeSettings, IntakeSettingsPage } from "./IntakeSettings";
import { IntakePageHeader } from "./IntakePageHeader";

const mocks = vi.hoisted(() => ({
  automation: vi.fn(),
  update: vi.fn(),
  generate: vi.fn(),
  members: vi.fn(),
  push: vi.fn(),
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
  generateIntakeEmailWebhook: mocks.generate,
  getIntakeMembers: mocks.members,
}));
vi.mock("@/app/lib/userFacingError", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/userFacingError")>()),
  notifyError: mocks.notify,
  notifySuccess: mocks.success,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
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

const settings = (
  overrides: Partial<IntakeAutomationSettings> = {},
): IntakeAutomationSettings => ({
  email: {
    enabled: false,
    configured: true,
    token_hint: "9f3c",
    allowed_domains: ["example.com"],
  },
  slack: {
    enabled: true,
    events_url: "https://api.example.test/webhooks/intake/slack/0b6f",
    configured: true,
    team_id: "T0123",
    team_name: "Acme Legal",
    bot_user_id: "U0BOT",
  },
  triage: { enabled: true, default_timezone: null, model_available: true },
  focus: [{ user_id: "lawyer-a", focus: "NDAs and procurement contracts" }],
  recent: [
    {
      id: "in-1",
      source: "email",
      status: "done",
      error: null,
      request_id: "request-1",
      created_at: "2026-11-02T09:00:00Z",
    },
    {
      id: "in-2",
      source: "slack",
      status: "ignored",
      error: "The sender's domain isn't allowed.",
      request_id: null,
      created_at: "2026-11-02T08:00:00Z",
    },
    {
      id: "in-3",
      source: "email",
      status: "failed",
      error: "The message could not be read.",
      request_id: null,
      created_at: "2026-11-01T08:00:00Z",
    },
  ],
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const form = () => screen.findByRole("form", { name: "Automated intake" });
const section = (name: string) => screen.getByRole("region", { name });
const save = () => screen.getByRole("button", { name: "Save" });

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
  mocks.automation.mockResolvedValue(settings());
  mocks.members.mockResolvedValue(members);
  mocks.update.mockImplementation(async () => settings());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("IntakeSettings", () => {
  it("shows every section from the saved settings", async () => {
    render(<IntakeSettings orgId="org-a" />);
    await form();
    expect(mocks.automation).toHaveBeenCalledWith("org-a");
    expect(mocks.members).toHaveBeenCalledWith("org-a");

    const email = section("Email");
    expect(
      within(email).getByRole("switch", { name: "Record requests from email" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(email).toHaveTextContent("Webhook URL ending …9f3c");
    expect(
      within(email).getByRole("button", { name: "Replace webhook URL" }),
    ).toBeInTheDocument();
    expect(within(email).getByText("example.com")).toBeInTheDocument();
    expect(
      within(email).getByRole("button", { name: "Remove example.com" }),
    ).toBeInTheDocument();
    expect(within(email).getAllByRole("listitem").length).toBeGreaterThan(2);

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

    const triage = section("AI triage");
    expect(
      within(triage).getByRole("switch", {
        name: "Summarize, fill in details and assign with AI",
      }),
    ).toHaveAttribute("aria-checked", "true");
    expect(within(triage).getByLabelText("Default timezone")).toHaveValue("");
    expect(
      within(triage).getByRole("textbox", { name: "Lawyer A Handles" }),
    ).toHaveValue("NDAs and procurement contracts");
    expect(
      within(triage).getByRole("textbox", { name: "Lawyer B Handles" }),
    ).toHaveValue("");
    // Emails are shown whole, on their own line.
    expect(within(triage).getByText(LONG_EMAIL)).toHaveClass(
      "[overflow-wrap:anywhere]",
    );
    expect(triage).not.toHaveTextContent("Triage needs a model API key");

    const recent = section("Recent messages");
    const rows = within(recent).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Email");
    expect(rows[0]).toHaveTextContent("Recorded");
    expect(
      within(rows[0]).getByRole("link", { name: /^Open request/ }),
    ).toHaveAttribute("href", "/intake/request-1?org=org-a");
    expect(rows[1]).toHaveTextContent("Slack");
    expect(rows[1]).toHaveTextContent("Ignored");
    expect(rows[1]).toHaveTextContent("The sender's domain isn't allowed.");
    expect(within(rows[1]).queryByRole("link")).not.toBeInTheDocument();
    expect(within(rows[2]).getByText("Failed")).toHaveClass("text-red-600");

    // Nothing has changed yet.
    expect(save()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("All changes saved");
  });

  it("says when triage has no model, linking to the organization's keys", async () => {
    mocks.automation.mockResolvedValue(
      settings({
        triage: {
          enabled: true,
          default_timezone: null,
          model_available: false,
        },
      }),
    );
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const triage = section("AI triage");
    expect(triage).toHaveTextContent("Triage needs a model API key");
    expect(
      within(triage).getByRole("link", {
        name: "Add a key in Bring Your Own Keys",
      }),
    ).toHaveAttribute("href", "/organizations/org-a/settings/providers");
  });

  it("saves only the fields that changed, and nothing while saving", async () => {
    const user = userEvent.setup();
    const pending = deferred<IntakeAutomationSettings>();
    mocks.update.mockReturnValue(pending.promise);
    render(<IntakeSettings orgId="org-a" />);
    await form();
    await user.click(
      screen.getByRole("switch", { name: "Record requests from email" }),
    );
    await user.type(
      screen.getByLabelText("Allowed sender domains"),
      "Partner.Example.org{Enter}",
    );
    expect(
      screen.getByRole("button", { name: "Remove partner.example.org" }),
    ).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "Lawyer B Handles" }),
      "Employment",
    );
    await user.type(screen.getByLabelText("Default timezone"), "Europe/London");
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
    await user.click(save());

    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith("org-a", {
      email_enabled: true,
      email_allowed_domains: ["example.com", "partner.example.org"],
      default_timezone: "Europe/London",
      focus: [
        { user_id: "lawyer-a", focus: "NDAs and procurement contracts" },
        { user_id: "lawyer-b", focus: "Employment" },
      ],
    });
    // While it is sent, nothing can change and it cannot be sent twice.
    expect(save()).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "Record requests from email" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "Lawyer B Handles" }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");

    pending.resolve(
      settings({
        email: {
          enabled: true,
          configured: true,
          token_hint: "9f3c",
          allowed_domains: ["example.com", "partner.example.org"],
        },
        triage: {
          enabled: true,
          default_timezone: "Europe/London",
          model_available: true,
        },
        focus: [
          { user_id: "lawyer-a", focus: "NDAs and procurement contracts" },
          { user_id: "lawyer-b", focus: "Employment" },
        ],
      }),
    );
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("Intake settings saved"),
    );
    expect(screen.getByRole("status")).toHaveTextContent("All changes saved");
    expect(save()).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "Lawyer B Handles" }),
    ).toHaveValue("Employment");
  });

  it("adds a typed domain on Save, and clears a member's note by sending the rest", async () => {
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    await user.click(
      screen.getByRole("button", { name: "Remove example.com" }),
    );
    await user.type(
      screen.getByLabelText("Allowed sender domains"),
      "@acme.test",
    );
    await user.clear(screen.getByRole("textbox", { name: "Lawyer A Handles" }));
    await user.click(save());
    expect(mocks.update).toHaveBeenCalledWith("org-a", {
      email_allowed_domains: ["acme.test"],
      focus: [],
    });
  });

  it("keeps unsaved edits when a save fails, and Retry sends them again", async () => {
    const user = userEvent.setup();
    const failure = Object.assign(new Error("Bad gateway"), { status: 502 });
    mocks.update.mockRejectedValueOnce(failure);
    render(<IntakeSettings orgId="org-a" />);
    await form();
    await user.click(
      screen.getByRole("switch", { name: "Record requests from Slack" }),
    );
    await user.type(
      screen.getByLabelText("Bot User OAuth Token"),
      "xoxb-new-token",
    );
    await user.click(save());
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(1));
    const [error, options] = mocks.notify.mock.calls[0];
    expect(error).toBe(failure);
    expect(options.action).toBe("save the intake settings");
    // Still on screen, still unsaved.
    expect(
      screen.getByRole("switch", { name: "Record requests from Slack" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.getByLabelText("Bot User OAuth Token")).toHaveValue(
      "xoxb-new-token",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
    expect(mocks.success).not.toHaveBeenCalled();

    await options.onRetry();
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
      slack_enabled: false,
      slack_bot_token: "xoxb-new-token",
    });
  });

  it("never fills in a secret, keeps a saved one when left empty, and clears a typed one once saved", async () => {
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

    // An untouched secret is not sent.
    await user.click(
      screen.getByRole("switch", {
        name: "Summarize, fill in details and assign with AI",
      }),
    );
    await user.click(save());
    expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
      triage_enabled: false,
    });

    // A typed one is, trimmed, and is gone from the field once saved.
    await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(1));
    await user.type(within(slack).getByLabelText("Signing Secret"), " s3cret ");
    expect(within(slack).getAllByText("Saved")).toHaveLength(1);
    await user.click(save());
    // Only the secret: the page shows what the last save kept.
    expect(mocks.update).toHaveBeenLastCalledWith("org-a", {
      slack_signing_secret: "s3cret",
    });
    await waitFor(() =>
      expect(within(slack).getByLabelText("Signing Secret")).toHaveValue(""),
    );
  });

  it("asks for the secrets, with no Saved mark, before Slack is set up", async () => {
    mocks.automation.mockResolvedValue(
      settings({
        slack: {
          enabled: false,
          events_url: "https://api.example.test/webhooks/intake/slack/0b6f",
          configured: false,
          team_id: null,
          team_name: null,
          bot_user_id: null,
        },
      }),
    );
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const slack = section("Slack");
    expect(within(slack).queryByText("Saved")).not.toBeInTheDocument();
    expect(slack).not.toHaveTextContent("Connected workspace");
    expect(within(slack).getByLabelText("Signing Secret")).toHaveAttribute(
      "placeholder",
      "Paste the app's Signing Secret",
    );
  });

  it("shows a generated webhook URL once, to copy, and asks before replacing it", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mocks.automation.mockResolvedValue(
      settings({
        email: {
          enabled: false,
          configured: false,
          token_hint: null,
          allowed_domains: [],
        },
      }),
    );
    const first: IntakeEmailWebhook = {
      webhook_url:
        "https://api.example.test/webhooks/intake/email/first-token-a1b2",
      token_hint: "a1b2",
    };
    const second: IntakeEmailWebhook = {
      webhook_url:
        "https://api.example.test/webhooks/intake/email/second-token-c3d4",
      token_hint: "c3d4",
    };
    mocks.generate.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const email = section("Email");
    expect(email).toHaveTextContent("No webhook URL yet.");

    // Nothing is in use yet, so it is generated without asking.
    await user.click(
      within(email).getByRole("button", { name: "Generate webhook URL" }),
    );
    expect(
      await within(email).findByText(first.webhook_url),
    ).toBeInTheDocument();
    expect(mocks.generate).toHaveBeenCalledWith("org-a");
    expect(email).toHaveTextContent("Copy it now: MikeGC won't show it again.");
    await user.click(
      within(email).getByRole("button", { name: "Copy webhook URL" }),
    );
    expect(writeText).toHaveBeenCalledWith(first.webhook_url);
    await waitFor(() =>
      expect(mocks.success).toHaveBeenCalledWith("Webhook URL copied"),
    );
    // Generating does not change the unsaved settings.
    expect(save()).toBeDisabled();

    // Replacing one stops it working, so it asks first.
    await user.click(
      within(email).getByRole("button", { name: "Replace webhook URL" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Replace the webhook URL?",
    });
    expect(dialog).toHaveTextContent("The current URL stops working at once.");
    await user.click(
      within(dialog).getByRole("button", { name: "Keep current URL" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(within(email).getByText(first.webhook_url)).toBeInTheDocument();

    await user.click(
      within(email).getByRole("button", { name: "Replace webhook URL" }),
    );
    await user.click(screen.getByRole("button", { name: "Replace URL" }));
    expect(
      await within(email).findByText(second.webhook_url),
    ).toBeInTheDocument();
    expect(
      within(email).queryByText(first.webhook_url),
    ).not.toBeInTheDocument();
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });

  it("shows only the saved URL's ending when it was generated before", async () => {
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const email = section("Email");
    expect(email).toHaveTextContent("Webhook URL ending …9f3c");
    expect(
      within(email).queryByRole("button", { name: "Copy webhook URL" }),
    ).not.toBeInTheDocument();
  });

  it("refuses an unknown timezone or domain inline, and holds Save until fixed", async () => {
    const user = userEvent.setup();
    render(<IntakeSettings orgId="org-a" />);
    await form();
    const timezone = screen.getByLabelText("Default timezone");
    await user.type(timezone, "Mars/Olympus");
    expect(timezone).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByText(
        "Choose a timezone from the list, such as Europe/London.",
      ),
    ).toBeInTheDocument();
    expect(save()).toBeDisabled();
    await user.clear(timezone);

    const domain = screen.getByLabelText("Allowed sender domains");
    await user.type(domain, "not a domain{Enter}");
    expect(
      screen.getByText("Enter a domain like example.com."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(save()).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Correct the sender domain to save.",
    );
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
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a failed load as an error with Try again", async () => {
    const user = userEvent.setup();
    mocks.members.mockRejectedValueOnce(
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

  it("shows the page's layout while it loads", () => {
    mocks.automation.mockReturnValue(new Promise(() => {}));
    render(<IntakeSettings orgId="org-a" />);
    const skeleton = screen.getByLabelText("Loading the intake settings");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(skeleton.children).toHaveLength(4);
  });

  it("leaves out the members in Personal and points to the person's own keys", async () => {
    mocks.automation.mockResolvedValue(
      settings({
        focus: [],
        triage: {
          enabled: true,
          default_timezone: null,
          model_available: false,
        },
      }),
    );
    render(<IntakeSettings orgId="personal" />);
    await form();
    expect(mocks.automation).toHaveBeenCalledWith("personal");
    expect(mocks.members).not.toHaveBeenCalled();
    const triage = section("AI triage");
    expect(triage).not.toHaveTextContent("What each member handles");
    expect(
      within(triage).getByRole("link", {
        name: "Add a key in Bring Your Own Keys",
      }),
    ).toHaveAttribute("href", "/settings/byok");
  });

  it("is /intake/settings, named in the header with the other Intake pages", async () => {
    render(<IntakeSettingsPage />);
    expect(
      screen.getByRole("heading", { name: "Intake: Settings" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await form();
  });
});

describe("IntakePageHeader", () => {
  it.each([
    ["an owner", { id: "org-a", role: "owner" }, "org-a", true],
    ["an admin", { id: "org-a", role: "admin" }, "org-a", true],
    ["a member", { id: "org-a", role: "member" }, "org-a", false],
    ["Personal's owner", null, "personal", true],
  ])("offers Settings to %s: %s", (_who, organization, workspaceId, shown) => {
    mocks.workspace = {
      accountId: "account-a",
      workspaceId: workspaceId as string,
      activeOrganization: organization,
    };
    render(<IntakePageHeader page="requests" />);
    expect(
      screen.getByRole("button", { name: "Dashboard" }),
    ).toBeInTheDocument();
    expect(!!screen.queryByRole("button", { name: "Settings" })).toBe(shown);
  });

  it("leaves Settings out while the organization's role is unknown", () => {
    mocks.workspace = {
      accountId: "account-a",
      workspaceId: "org-a",
      activeOrganization: null,
    };
    render(<IntakePageHeader page="dashboard" />);
    expect(
      screen.queryByRole("button", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });

  it("opens the settings page from Settings", async () => {
    const user = userEvent.setup();
    render(<IntakePageHeader page="dashboard" />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(mocks.push).toHaveBeenCalledWith("/intake/settings");
  });
});
