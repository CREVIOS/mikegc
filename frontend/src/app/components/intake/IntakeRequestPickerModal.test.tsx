import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntakeRequestPickerModal } from "./IntakeRequestPickerModal";
import { AddDocButton } from "../assistant/AddDocButton";

const { listIntakeRequests } = vi.hoisted(() => ({
  listIntakeRequests: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", () => ({ listIntakeRequests }));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
  useWorkspace: () => ({ workspaceId: "org-1" }),
}));

const summary = (id: string, subject: string) => ({
  id,
  subject,
  requester_name: "Daniel Okafor",
  state: "in_review",
  clarify_stage: null,
});

describe("IntakeRequestPickerModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listIntakeRequests.mockResolvedValue({
      requests: [
        summary("request-1", "Supplier NDA - Kestrel Components"),
        summary("request-2", "Reseller NDA - Atlas Distribution"),
      ],
      next_cursor: null,
    });
  });

  it("lists the workspace's open requests and hands back the one picked", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <IntakeRequestPickerModal
        open
        onClose={onClose}
        onSelect={onSelect}
        breadcrumbs={["Assistant", "Add intake request"]}
      />,
    );
    const row = await screen.findByRole("button", {
      name: /Supplier NDA - Kestrel Components/,
    });
    expect(listIntakeRequests).toHaveBeenCalledWith("org-1", {
      scope: "open",
      search: undefined,
    });
    expect(row).toHaveTextContent("Daniel Okafor · In progress");
    const use = screen.getByRole("button", { name: "Use" });
    expect(use).toBeDisabled();

    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(use);
    expect(onSelect).toHaveBeenCalledWith({
      id: "request-1",
      title: "Supplier NDA - Kestrel Components",
      orgId: "org-1",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("searches on the server", async () => {
    render(
      <IntakeRequestPickerModal
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        breadcrumbs={[]}
      />,
    );
    await screen.findByText("Supplier NDA - Kestrel Components");
    await userEvent.type(
      screen.getByPlaceholderText("Search open requests..."),
      "kestrel",
    );
    await waitFor(() =>
      expect(listIntakeRequests).toHaveBeenLastCalledWith("org-1", {
        scope: "open",
        search: "kestrel",
      }),
    );
  });

  it("says when the requests can't be loaded", async () => {
    listIntakeRequests.mockRejectedValue(new Error("offline"));
    render(
      <IntakeRequestPickerModal
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        breadcrumbs={[]}
      />,
    );
    expect(
      await screen.findByText("Requests couldn’t be loaded. Try again later."),
    ).toBeInTheDocument();
  });
});

describe("AddDocButton intake requests", () => {
  async function menuItems(props: { onIntakeRequests?: () => void }) {
    render(
      <AddDocButton onBrowseAll={vi.fn()} onLocalFiles={vi.fn()} {...props} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add to message" }));
    return (await screen.findAllByRole("menuitem")).map(
      (item) => item.textContent,
    );
  }

  it("offers intake requests only where the composer asks for them", async () => {
    const onIntakeRequests = vi.fn();
    expect(await menuItems({ onIntakeRequests })).toContain("Intake Requests");
    await userEvent.click(screen.getByRole("menuitem", { name: "Intake Requests" }));
    expect(onIntakeRequests).toHaveBeenCalled();
  });

  it("leaves it out elsewhere, such as project chats", async () => {
    expect(await menuItems({})).not.toContain("Intake Requests");
  });
});
