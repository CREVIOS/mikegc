import { afterEach, expect, it, vi } from "vitest";
import { openAiStoresResponses, streamAiSdk } from "../aiSdk";
import { config, makeModel, textStep } from "./mockLanguageModel";

afterEach(() => vi.unstubAllEnvs());

async function openAiCallOptions(conversationId?: string) {
    const model = await makeModel([textStep("ok")]);
    await streamAiSdk(
        {
            model: "gpt-6.1-sol",
            systemPrompt: "S",
            messages: [{ role: "user", content: "go" }],
            ...(conversationId ? { conversationId } : {}),
        },
        { ...config(model), provider: "openai", modelId: "gpt-6.1-sol" },
    );
    return model.doStreamCalls[0].providerOptions as Record<string, Record<string, unknown>> | undefined;
}

it("asks OpenAI not to store responses, with or without a conversation", async () => {
    expect(await openAiCallOptions()).toMatchObject({ openai: { store: false } });
    expect(await openAiCallOptions("chat-1")).toMatchObject({
        openai: { store: false, promptCacheKey: "chat-1" },
    });
});

it("lets a deployment restore OpenAI's default storage", async () => {
    vi.stubEnv("SPECTRE_OPENAI_STORE", "true");
    expect(openAiStoresResponses()).toBe(true);
    const options = await openAiCallOptions("chat-1");
    expect(options?.openai).toEqual({ promptCacheKey: "chat-1" });
});

it("leaves other providers' options alone", async () => {
    const model = await makeModel([textStep("ok")]);
    await streamAiSdk(
        { model: "m", systemPrompt: "S", messages: [{ role: "user", content: "go" }] },
        config(model),
    );
    expect(model.doStreamCalls[0].providerOptions?.openai).toBeUndefined();
});
