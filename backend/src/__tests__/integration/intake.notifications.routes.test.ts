import { describe, it, expect, vi } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// POST /intake/notifications/claim is polled twice a minute by every open tab,
// and an office of lawyers can share one address, so signed-in claims stay
// out of the shared per-address budget (they have a per-member limit in the
// intake router). That exemption must not leave the path unbounded: callers
// it turns away, each costing a token check, are counted per address before
// authentication, and other methods stay under the shared budget.
//
// Env is set inside vi.hoisted so it lands before app.ts reads it at import.
// ---------------------------------------------------------------------------
const { rpc, authChecks } = vi.hoisted(() => {
    process.env.RATE_LIMIT_GENERAL_MAX = "5";
    process.env.RATE_LIMIT_INTAKE_NOTIFICATIONS_FAILED_MAX = "3";
    process.env.RATE_LIMIT_INTAKE_NOTIFICATIONS_MAX = "100";
    return {
        rpc: vi.fn(async () => ({ data: [], error: null })),
        authChecks: vi.fn(),
    };
});

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({ rpc })),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        req: { headers: Record<string, string | undefined> },
        res: {
            locals: Record<string, unknown>;
            status: (code: number) => { json: (body: unknown) => void };
        },
        next: () => void,
    ) => {
        authChecks();
        if (req.headers.authorization !== "Bearer member")
            return void res.status(401).json({ detail: "Sign in again." });
        res.locals.userId = "member-1";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

import { app } from "../../app";

const CLAIM = "/intake/notifications/claim";

describe("intake notification claim rate limits", () => {
    it("lets a signed-in member poll past the shared per-address budget", async () => {
        for (let i = 0; i < 8; i++) {
            const res = await request(app)
                .post(CLAIM)
                .set("Authorization", "Bearer member");
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ notifications: [] });
        }
    });

    it("turns away callers without a session per address, before checking a token", async () => {
        authChecks.mockClear();
        for (let i = 0; i < 3; i++)
            expect(
                (await request(app).post(CLAIM).set("Authorization", "Bearer forged"))
                    .status,
            ).toBe(401);
        const limited = await request(app)
            .post(CLAIM)
            .set("Authorization", "Bearer forged");
        expect(limited.status).toBe(429);
        expect(authChecks).toHaveBeenCalledTimes(3);
    });

    it("keeps other methods on the claim path under the shared budget", async () => {
        const statuses: number[] = [];
        for (let i = 0; i < 6; i++)
            statuses.push(
                (await request(app).get(CLAIM).set("Authorization", "Bearer member"))
                    .status,
            );
        expect(statuses.slice(0, 5)).not.toContain(429);
        expect(statuses[5]).toBe(429);
    });
});
