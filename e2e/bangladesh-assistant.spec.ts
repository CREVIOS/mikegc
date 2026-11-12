import { expect, test } from "./fixtures";

test.use({ storageState: { cookies: [], origins: [] }, actionTimeout: 30_000 });

// A Bangladesh answer as the real frontend renders it, with the API mocked in
// the browser: the Laws of Bangladesh search step, Bangla text, and the notice
// for a law-report citation the answer did not read in any source. Both a
// saved answer and a live streamed one are checked.

const BANGLA = "চুক্তি আইন, ১৮৭২ এর ধারা ২৭ অনুযায়ী চাকরি শেষে প্রতিযোগিতা নিষেধের শর্ত বাতিল।";

test("a Bangladesh answer shows its Laws of Bangladesh steps, Bangla text and unverified citations", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.addInitScript((bangla) => {
        const originalFetch = window.fetch.bind(window);
        const json = async (body: unknown) =>
            new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
        const chat = {
            id: "bd-chat",
            title: "Non-compete in a Dhaka appointment letter",
            user_id: "bd-user",
            project_id: null,
            model: "gpt-6.1-sol",
            created_at: "2026-11-12T00:00:00Z",
            is_owner: true,
            access_role: "owner",
        };
        const savedAnswer = [
            {
                type: "web_search",
                search_id: "s1",
                query: "Laws of Bangladesh: Contract Act restraint of trade",
                results: [{ url: "https://bdlaws.minlaw.gov.bd/act-26.html", title: "The Contract Act, 1872" }],
            },
            { type: "web_read", read_id: "r1", url: "https://bdlaws.minlaw.gov.bd/act-26.html", title: "The Contract Act, 1872" },
            { type: "content", text: `${bangla}\n\nSee also 70 DLR (AD) 99.` },
            { type: "citation_check", unverified: ["70 DLR (AD) 99"] },
        ];
        window.fetch = (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            const path = new URL(url, location.href).pathname;
            if (!path.startsWith("/api/")) return originalFetch(input, init);
            if (path === "/api/auth/session") return json({ user: { id: "bd-user", email: "advocate@example.com" } });
            if (path === "/api/user/profile") {
                return json({ onboardingComplete: true, displayName: "Advocate", apiKeyStatus: {}, creditsRemaining: 100 });
            }
            if (path === "/api/models/configured") {
                return json({ models: [{ id: "gpt-6.1-sol", label: "GPT-6.1 Sol", source: "Configured" }] });
            }
            if (path.startsWith("/api/models/")) return json({ models: [] });
            if (path === "/api/chat/bd-chat") {
                return json({
                    chat,
                    is_owner: true,
                    access_role: "owner",
                    messages: [
                        { id: "q1", role: "user", content: "Is the 12-month non-compete enforceable?" },
                        { id: "a1", role: "assistant", content: savedAnswer },
                    ],
                });
            }
            if (path === "/api/chat" && init?.method === "POST") {
                const encoder = new TextEncoder();
                const stream = new ReadableStream({
                    start(controller) {
                        const send = (event: unknown) =>
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                        send({ type: "chat_id", chatId: chat.id, assistantMessageId: "a2" });
                        send({ type: "web_search_start", search_id: "s2", query: "Laws of Bangladesh: Arbitration Act" });
                        send({
                            type: "web_search",
                            search_id: "s2",
                            query: "Laws of Bangladesh: Arbitration Act",
                            results: [{ url: "https://bdlaws.minlaw.gov.bd/act-850.html", title: "The Arbitration Act, 2001" }],
                        });
                        send({ type: "content_delta", text: "Foreign awards are enforced under section 45 of the Arbitration Act, 2001. Compare 12 SCOB [2019] AD 5." });
                        send({ type: "citation_check", unverified: ["12 SCOB [2019] AD 5"] });
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                        controller.close();
                    },
                });
                return Promise.resolve(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }));
            }
            if (path === "/api/chat") return json([chat]);
            return json([]);
        };
    }, BANGLA);

    await page.goto("/assistant/chat/bd-chat");
    // The brand reads Spectre, nothing more.
    await expect(page.getByText("Spectre", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/SpectreGC/)).toHaveCount(0);

    // The saved answer. Its steps are folded under a summary; open them.
    await expect(page.getByText(BANGLA)).toBeVisible();
    await page.getByRole("button", { name: /Completed in 2 steps/ }).click();
    await expect(
        page.getByText("Searched the Laws of Bangladesh for “Contract Act restraint of trade”"),
    ).toBeVisible();
    const savedNote = page.getByRole("note", { name: "Citations not verified" }).first();
    await expect(savedNote).toContainText("1 citation not verified");
    await expect(savedNote).toContainText("70 DLR (AD) 99");

    // A live answer: the search step and the notice arrive over the stream.
    await page.getByPlaceholder("How can I help?").fill("How is a SIAC award enforced in Bangladesh?");
    await page.keyboard.press("Enter");
    await expect(page.getByText("12 SCOB [2019] AD 5", { exact: true })).toBeVisible();
    const steps = page.getByRole("button", { name: /Completed in 1 step/ });
    if (await steps.count()) await steps.last().click();
    await expect(page.getByText("Searched the Laws of Bangladesh for “Arbitration Act”")).toBeVisible();
    await expect(page.getByRole("note", { name: "Citations not verified" })).toHaveCount(2);

    if (process.env.BD_SCREENSHOT) await page.screenshot({ path: process.env.BD_SCREENSHOT, fullPage: true });
    expect(errors).toEqual([]);
});
