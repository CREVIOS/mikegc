import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntakeActionEvent, IntakeState } from "@mike/contracts";
import { IntakeActionCard, latestIntakeActionCardId } from "./IntakeActionCard";

const { getIntakeRequest, commandIntakeRequest, notifyError } = vi.hoisted(
    () => ({
        getIntakeRequest: vi.fn(),
        commandIntakeRequest: vi.fn(),
        notifyError: vi.fn(),
    }),
);
vi.mock("@/app/lib/mikeApi", () => ({ getIntakeRequest, commandIntakeRequest }));
vi.mock("@/app/lib/userFacingError", () => ({ notifyError }));

function request(
    state: IntakeState,
    capabilities: Partial<Record<"resolve" | "cancel" | "reopen", boolean>> = {},
) {
    return {
        id: "request-1",
        subject: "Review mutual NDA",
        state,
        clarify_stage: null,
        version: 4,
        capabilities: {
            resolve: false,
            cancel: false,
            wait: false,
            resume: false,
            reopen: false,
            ...capabilities,
        },
    };
}

const event = (
    action: IntakeActionEvent["action"],
    note?: string,
): IntakeActionEvent => ({
    type: "intake_action",
    card_id: "card-1",
    org_id: "org-1",
    request_id: "request-1",
    action,
    ...(note ? { note } : {}),
});

describe("IntakeActionCard", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("changes nothing until the user confirms, then sends the request's command", async () => {
        getIntakeRequest
            .mockResolvedValueOnce(request("in_review", { resolve: true }))
            .mockResolvedValueOnce(request("resolved", { reopen: true }));
        commandIntakeRequest.mockResolvedValue({ request_id: "request-1" });
        render(<IntakeActionCard event={event("resolve", "Signed as drafted.")} />);

        const note = await screen.findByLabelText("Resolution (optional)");
        expect(note).toHaveValue("Signed as drafted.");
        expect(screen.getByRole("link", { name: "Review mutual NDA" })).toHaveAttribute(
            "href",
            "/intake/request-1?org=org-1",
        );
        expect(commandIntakeRequest).not.toHaveBeenCalled();

        await userEvent.clear(note);
        await userEvent.type(note, "Signed.");
        await userEvent.click(screen.getByRole("button", { name: "Resolve" }));

        expect(commandIntakeRequest).toHaveBeenCalledWith(
            "org-1",
            "request-1",
            "resolve",
            expect.objectContaining({ expected_version: 4, body: "Signed." }),
        );
        expect(await screen.findByRole("status")).toHaveTextContent(
            "Done. Request resolved.",
        );
    });

    it("asks for a reason before cancelling", async () => {
        getIntakeRequest.mockResolvedValue(request("in_review", { cancel: true }));
        render(<IntakeActionCard event={event("cancel")} />);
        const button = await screen.findByRole("button", { name: "Cancel request" });
        expect(button).toBeDisabled();
        await userEvent.type(screen.getByLabelText("Reason"), "Duplicate");
        expect(button).toBeEnabled();
    });

    it("says when the change no longer applies", async () => {
        getIntakeRequest.mockResolvedValue(request("cancelled", { reopen: true }));
        render(<IntakeActionCard event={event("resolve")} />);
        expect(
            await screen.findByText(
                "This change no longer applies. The request is Cancelled.",
            ),
        ).toBeInTheDocument();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("offers only the chat's newest proposal", async () => {
        getIntakeRequest.mockResolvedValue(request("in_review", { resolve: true }));
        render(<IntakeActionCard event={event("resolve")} replaced />);
        expect(
            await screen.findByText("A later proposal replaces this one."),
        ).toBeInTheDocument();
        expect(screen.queryByRole("button")).toBeNull();
        expect(
            latestIntakeActionCardId([
                { events: [{ ...event("wait"), card_id: "card-1" }] },
                { events: [] },
                {
                    events: [
                        { ...event("resume"), card_id: "card-2" },
                        { type: "content", text: "Confirm it above." },
                    ],
                },
            ]),
        ).toBe("card-2");
        expect(latestIntakeActionCardId([{ events: [] }])).toBeNull();
    });

    it("shows a failure without claiming the change was made", async () => {
        getIntakeRequest.mockResolvedValue(request("in_review", { resolve: true }));
        commandIntakeRequest.mockRejectedValue(new Error("conflict"));
        render(<IntakeActionCard event={event("resolve")} />);
        await userEvent.click(await screen.findByRole("button", { name: "Resolve" }));
        expect(notifyError).toHaveBeenCalledWith(expect.any(Error), {
            action: "resolve the request",
        });
        expect(screen.queryByText(/Done\./)).toBeNull();
    });
});
