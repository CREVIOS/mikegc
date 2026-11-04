import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";

const intakeRequestWorkspace = vi.hoisted(() => vi.fn());
vi.mock("../../intake/intake.service", () => ({ intakeRequestWorkspace }));

import { resolvePilledIntake } from "../chat.intake";

// A message's intake pill links its chat to the request once, for someone
// who can read it, in a chat of its own in the request's workspace.

const db = {} as Db;
const base = {
    userId: "u1",
    pilled: "request-1",
    linked: null,
    projectId: null,
    chatOrgId: "org-1",
};

beforeEach(() => {
    vi.clearAllMocks();
    intakeRequestWorkspace.mockResolvedValue({
        ok: true,
        data: { orgId: "org-1", personal: false },
    });
});

describe("resolvePilledIntake", () => {
    it("links a chat in the request's organization", async () => {
        await expect(resolvePilledIntake(db, base)).resolves.toEqual({
            ok: true,
            link: "request-1",
        });
        expect(intakeRequestWorkspace).toHaveBeenCalledWith(db, "u1", "request-1");
    });

    it("links a Personal request's chat, which has no organization", async () => {
        intakeRequestWorkspace.mockResolvedValue({
            ok: true,
            data: { orgId: "personal-org", personal: true },
        });
        await expect(
            resolvePilledIntake(db, { ...base, chatOrgId: null }),
        ).resolves.toEqual({ ok: true, link: "request-1" });
    });

    it("links nothing without a pill, or for the request already linked", async () => {
        await expect(
            resolvePilledIntake(db, { ...base, pilled: null }),
        ).resolves.toEqual({ ok: true, link: null });
        await expect(
            resolvePilledIntake(db, { ...base, linked: "request-1" }),
        ).resolves.toEqual({ ok: true, link: null });
        expect(intakeRequestWorkspace).not.toHaveBeenCalled();
    });

    it("keeps a chat to one request, and out of projects", async () => {
        await expect(
            resolvePilledIntake(db, { ...base, linked: "request-2" }),
        ).resolves.toMatchObject({ ok: false, status: 400 });
        await expect(
            resolvePilledIntake(db, { ...base, projectId: "project-1" }),
        ).resolves.toMatchObject({ ok: false, status: 400 });
        expect(intakeRequestWorkspace).not.toHaveBeenCalled();
    });

    it("404s a request the person can't read", async () => {
        intakeRequestWorkspace.mockResolvedValue({
            ok: false,
            kind: "not_found",
            detail: "Request not found.",
        });
        await expect(resolvePilledIntake(db, base)).resolves.toEqual({
            ok: false,
            status: 404,
            detail: "Request not found.",
        });
    });

    it("refuses a chat outside the request's workspace", async () => {
        await expect(
            resolvePilledIntake(db, { ...base, chatOrgId: "org-2" }),
        ).resolves.toMatchObject({ ok: false, status: 400 });
    });
});
