/**
 * The Slack app manifest from docs/slack-intake-app-manifest.example.json,
 * shown in the Slack modal with the organization's own Events Request URL so
 * it can be pasted into Slack as it is. A test keeps the two the same.
 */
export const SLACK_INTAKE_MANIFEST = {
  display_information: {
    name: "MikeGC",
    description:
      "Mention @MikeGC to send a message or thread to Legal as an intake request. MikeGC answers in the thread.",
    background_color: "#1f2937",
  },
  features: {
    bot_user: {
      display_name: "MikeGC",
      always_online: true,
    },
  },
  oauth_config: {
    scopes: {
      bot: [
        "app_mentions:read",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "chat:write",
        "chat:write.customize",
        "files:read",
        "files:write",
        "users:read",
        "users:read.email",
      ],
    },
  },
  settings: {
    event_subscriptions: {
      request_url:
        "https://your-mikegc.example.com/api/webhooks/intake/slack/YOUR-WEBHOOK-ID",
      bot_events: ["app_mention", "message.channels", "message.groups"],
    },
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    token_rotation_enabled: false,
  },
};

/** The manifest as JSON, with the organization's Events Request URL. */
export function slackIntakeManifest(eventsUrl: string): string {
  const manifest = structuredClone(SLACK_INTAKE_MANIFEST);
  manifest.settings.event_subscriptions.request_url = eventsUrl;
  return JSON.stringify(manifest, null, 2);
}
