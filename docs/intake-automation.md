# Automated intake

MikeGC can record intake requests itself, so a lawyer doesn't have to retype
what arrived. It reads two channels:

- **Email.** Mail sent to a shared address, such as
  `legal-intake@example.com`, is forwarded to
  [Postmark](https://postmarkapp.com/)'s inbound processing, which posts each
  message to MikeGC.
- **Slack.** Anyone in the organization's Slack workspace mentions `@MikeGC`
  in a channel MikeGC has been added to. A top-level message becomes the
  request, and its author is the requester. A mention in a thread sends the
  whole thread, up to the mention, and the thread's first author is the
  requester. MikeGC replies in the thread with a link to the request and who
  it went to.

Each message becomes a **New** or **In progress** request in the
organization's queue, created by **MikeGC**: MikeGC is not an account, so the
request, its "created" entry and the documents it attached all read as
MikeGC's. The request page notes where it came from ("Created by MikeGC from
Slack").

An organization's owners and admins set this up under **Intake → Settings**.
Other members don't see the page. In Personal, the account's owner can use it
for their own requests.

## AI triage

With **AI triage** on, MikeGC reads each message and:

- writes a subject and a summary, and keeps the original message, with its
  sender and time, below the summary;
- fills in the requester's name and email, and a target date if the message
  asks for one, read in the organization's default timezone (UTC unless set);
- assigns the request to one reviewer, chosen from the members using what
  each one **handles** (a short note per member in Settings, such as "NDAs
  and procurement contracts") and how many open and overdue requests each
  already has; it leaves the request unassigned when no one is a clear fit;
- attaches the documents that matter to the request and leaves out the rest,
  such as signature logos.

Triage is a convenience, not a legal decision. Reviewers can reassign a
request, edit its details and add or remove documents as with any other
request.

The message is untrusted text. Triage can only pick from the organization's
members and the message's own attachments, a requester email must appear in
the message or be the sender's, and every field is checked like one a member
typed. When triage is off, no model is available, or the model's answer is
unusable, MikeGC still records the request: the email subject or the first
line of the Slack message as the subject, the message as the description, the
sender as requester, no target date, unassigned, with every accepted
attachment.

Triage runs with the organization's model keys, as the owner or admin who
last saved the settings, on a fast, low-cost model (for example Claude Haiku)
from the first provider with a key. If that person is no longer an owner or
admin, it uses only the deployment's own keys. **Intake → Settings** says
when no model is available.

## Documents

PDF, Word, Excel and PowerPoint attachments are accepted: up to 10 per message
and 25 MB each. Anything else, or anything over those limits, is listed at the
end of the request's description so a reviewer can ask for it. Accepted
documents become the request's documents, like ones a member uploads, and
every member can open them.

## Setting up email

You need a [Postmark](https://postmarkapp.com/) account. Its free tier handles
inbound mail.

1. In MikeGC, open **Intake → Settings → Email** and choose **Generate webhook
   URL**. Copy it straight away: it contains a secret and is shown only once.
   Generating another replaces it, and the old one stops working.
2. In Postmark, open your server's **Inbound** message stream. Paste the URL as
   its **Webhook URL** and save. Note the stream's inbound address
   (`…@inbound.postmarkapp.com`), or set up an inbound domain.
3. Forward your intake address to that inbound address: a Google Workspace
   routing rule or Gmail forwarding for Gmail, or a mail flow rule or mailbox
   forwarding for Outlook and Exchange Online.
4. Optionally list the **sender domains** to accept, such as `example.com`.
   Mail from other domains is recorded as ignored, without creating a request.
   Leaving the list empty accepts any sender, which suits an address only
   colleagues know.
5. Turn **Email** on and save. Send a test message, then check **Recent
   messages** on the settings page.

Automatic replies, such as out-of-office messages and bulk mail, are ignored.
A message Postmark delivers twice is recorded once.

## Setting up Slack

Someone allowed to create apps in your Slack workspace does this once per
organization. Slack verifies the events URL as soon as you enter it, so save
the app's credentials in MikeGC first.

1. Open [Slack app management](https://api.slack.com/apps), choose **Create
   New App → From an app manifest**, pick the workspace, and paste
   [`slack-intake-app-manifest.example.json`](slack-intake-app-manifest.example.json).
   It creates a bot called MikeGC that can read messages that mention it and
   the threads they're in, read their files, look up the people in them, and
   reply.
2. Install the app to the workspace. Copy its **Bot User OAuth Token**
   (`xoxb-…`, under **OAuth & Permissions**) and its **Signing Secret** (under
   **Basic Information**).
3. In MikeGC, open **Intake → Settings → Slack**, paste both and save. MikeGC
   checks the token with Slack and shows the workspace it belongs to.
4. Back in the Slack app, open **Event Subscriptions**, turn events on, and
   paste MikeGC's **Events Request URL** from the settings page. Slack should
   show it as verified. Under **Subscribe to bot events**, add `app_mention`,
   save, and reinstall the app if Slack asks.
5. Turn **Slack** on in MikeGC and save.
6. Invite MikeGC to the channels people ask Legal in (`/invite @MikeGC`).
   Slack only tells MikeGC about mentions in channels it's a member of.

MikeGC's reply in the thread includes the request's subject and its reviewer,
so anyone in the channel can see them.

## How it works

- **Receiving.** Webhooks arrive under `/webhooks/intake/` on the API, outside
  the signed-in `/intake` API. Slack requests are checked against the signing
  secret (HMAC-SHA256 over the raw body, rejected after five minutes). Email
  requests must carry the secret token from the generated URL; MikeGC keeps
  only its SHA-256 hash and last four characters.
- **Recording.** Each message is stored once in `intake_inbound`, keyed by its
  Slack channel and timestamp or its email `Message-ID`, so a webhook
  delivered again records nothing new. Email attachments are stored
  temporarily until the message is handled. A background job (`intake.inbound`)
  then runs triage, records the request with `intake_submit_automated`, makes
  its documents and links them with `intake_attach_automated`, and replies in
  Slack. A retried job reuses the request and documents it already made and
  never replies twice. A message that still fails after its retries is
  recorded as failed, with a reason, in **Recent messages**, and MikeGC says
  so in the Slack thread.
- **Secrets.** The Slack signing secret and bot token are encrypted at rest
  with `MCP_CONNECTORS_ENCRYPTION_SECRET`, like connector credentials, and are
  never sent back to the browser.
- **Retention.** A message's content is kept only until it is handled; the
  request then holds it. Deleting all intake requests in **Privacy & Data**,
  and purging the organization, delete received messages too. What a member
  handles is deleted when they leave the organization.

## Deployment

Apply `backend/migrations/20261102_02_intake_automation.sql` before starting
the new build. There are no new environment variables: the webhook URLs are
built from `API_PUBLIC_URL`, the request links in Slack replies from
`FRONTEND_URL`, and secrets are encrypted with `MCP_CONNECTORS_ENCRYPTION_SECRET`
(or `USER_API_KEYS_ENCRYPTION_SECRET`). Both webhooks must reach the API over
public HTTPS; for local development, run a tunnel and set `API_PUBLIC_URL` to
it, as for the Slack connector in [connectors.md](connectors.md).
