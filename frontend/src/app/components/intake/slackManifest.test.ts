import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SLACK_INTAKE_MANIFEST, slackIntakeManifest } from "./slackManifest";

describe("the Slack app manifest", () => {
  it("is the setup guide's, so the two never drift apart", () => {
    const guide = JSON.parse(
      readFileSync(
        resolve(__dirname, "../../../../../docs/slack-intake-app-manifest.example.json"),
        "utf8",
      ),
    );
    expect(SLACK_INTAKE_MANIFEST).toEqual(guide);
  });

  it("carries the organization's own Events Request URL", () => {
    const url = "https://api.example.test/webhooks/intake/slack/0b6f";
    const manifest = JSON.parse(slackIntakeManifest(url));
    expect(manifest.settings.event_subscriptions.request_url).toBe(url);
    // The shared template is left as it was.
    expect(SLACK_INTAKE_MANIFEST.settings.event_subscriptions.request_url).toMatch(
      /YOUR-WEBHOOK-ID/,
    );
  });
});
