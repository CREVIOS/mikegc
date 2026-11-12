import { describe, expect, it } from "vitest";
import { environmentKey } from "../envKey";

describe("environmentKey", () => {
    it("reads a real key, trimmed", () => {
        expect(environmentKey("K", { K: "  sk-live-123  " })).toBe("sk-live-123");
    });

    it("treats unset, blank and .env.example placeholders as no key", () => {
        expect(environmentKey("K", {})).toBeNull();
        expect(environmentKey("K", { K: "   " })).toBeNull();
        expect(environmentKey("K", { K: "your-openai-key" })).toBeNull();
        expect(environmentKey("K", { K: "YOUR_ANTHROPIC_KEY" })).toBeNull();
    });

});
