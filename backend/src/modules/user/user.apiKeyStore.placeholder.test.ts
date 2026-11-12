import { afterEach, describe, expect, it, vi } from "vitest";
import { hasEnvApiKey } from "./user.apiKeyStore";

describe("deployment keys from a copied .env.example", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("do not show a placeholder key as configured", () => {
        vi.stubEnv("OPENAI_API_KEY", "your-openai-key");
        vi.stubEnv("GEMINI_API_KEY", "your-gemini-key");
        vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-real");
        expect(hasEnvApiKey("openai")).toBe(false);
        expect(hasEnvApiKey("gemini")).toBe(false);
        expect(hasEnvApiKey("claude")).toBe(true);
    });
});
