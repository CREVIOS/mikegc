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

An organization's owners and admins set this up in the **Intake** section of
the organization's settings (`/organizations/<id>/settings/intake`, also
reached from the settings icon in Intake's header), with Email, Slack and
**Triage rules** one after another. The models triage and preprocessing run
with are chosen in the organization's **Model Preferences** tab
(`/organizations/<id>/settings/models`), also for owners and admins. A channel's setup shows while it is on, and the info button beside its
heading shows how to set it up. Changes save by themselves: switches and lists
at once, text when typing pauses, and the Slack secrets once entered in full.
A channel turned on starts once it is set up: email once its webhook URL
exists, Slack once both its secrets are saved. Who each request goes to, and
whether MikeGC preprocesses it, is set on the rules page beside it
(`…/settings/intake/rules`). Other members aren't offered either page, and one
who follows a link to it is told it is for owners and admins; the API refuses
them too. In Personal, the account's owner finds both in their own
**Settings → Intake** (`/settings/intake`), and its models in their own
**Settings → Model Preferences**. The old `/intake/settings` and
`/intake/rules` links open the active workspace's pages.

## AI triage

AI triage is how MikeGC fills in a request. There is no switch for it: it runs
with the **Triage** model chosen under **Intake** in Model Preferences, and
doesn't run without one. With a model, MikeGC reads each message and:

- writes a subject and a summary, and keeps the original message, with its
  sender and time (in UTC, since members read it from anywhere), below the
  summary;
- fills in the requester's name and email, and a target date if the message
  asks for one, working out dates such as "by Friday" from today in UTC;
- assigns a reviewer using the organization's **rules**: the request goes to
  the member of the first rule, in order, whose condition it meets, and is
  left unassigned when none does;
- attaches the documents that matter to the request and leaves out the rest,
  such as signature logos.

## Rules and AI preprocessing

The rules page is a table of rules, opened with **Edit** under **Triage
rules** in the Intake settings. It works like the other tables:
search and **New rule** in the header, **All**, **Preprocessed** and **Not
preprocessed** tabs in the toolbar, filters on the **Assign to** and
**Preprocessing rule** columns, and checkboxes whose
selection the toolbar's **Actions** can turn AI preprocessing on or off for,
or delete (after asking). Each row has:

- a **Condition**, in plain words, such as "The request is about an NDA or a
  procurement contract";
- the member to **Assign to**;
- **AI preprocessing**, Yes or No;
- a **Preprocessing rule**: an assistant workflow or a playbook for
  preprocessing to follow, or none.

A member can have several rules. Rules are tried from the top, so put the most
specific first: drag a rule by the handle beside its priority to move it, or
use Move up and Move down in its row's menu (`···`, or a right-click), which
also deletes it. Each rule's **Priority** is its place in the order, and
filtering keeps it. A condition too long for its column opens whole, over the
rows below, when clicked or tabbed into; Enter, Escape or leaving it closes
it. A rule saves once
it has both a condition and a member. Rules need a triage model: without one,
requests are left unassigned and nothing is preprocessed.

With AI preprocessing on, once MikeGC has recorded a request the rule assigns,
and attached its documents, it works on the request in the background, before
the reviewer picks it up:

- **With a workflow**, MikeGC follows the workflow's instructions to answer
  the request and suggest changes to its documents.
- **With a playbook**, MikeGC reviews each document against the playbook, as a
  playbook review does, and the review appears in that admin's playbook runs.
- **With neither**, MikeGC answers the request in general terms and suggests
  the changes a careful in-house lawyer would make.

MikeGC posts its answer as a note on the request, which reads as MikeGC's. It
makes its suggested changes to the request's Word documents as tracked
changes signed MikeGC, as a new version that reviewers accept or reject like
any other. It marks up only a document as it arrived: one already revised is
left alone. PDFs and other files are read but not marked up. It waits for a
document's text to be extracted, and after its last try answers without
it, naming the documents it couldn't read.

Preprocessing runs as the owner or admin who last saved the intake settings,
with their access and the organization's model keys, on a mid-tier model (for
example Claude Sonnet). A workflow or playbook newly chosen in a rule must be
one the admin saving it can open; one that later can't be opened, a missing
model key, or an admin who no longer administers the organization is
explained in the note instead. Its answer is a first draft for a lawyer, not
legal advice, and the request's text and documents are treated as untrusted
content, as in triage.

Triage is a convenience, not a legal decision. Reviewers can reassign a
request, edit its details and add or remove documents as with any other
request.

The message is untrusted text. Triage can only pick one of the
organization's rules and the message's own attachments, and every field is checked like
one a member typed. A requester email must appear in the message; otherwise
the sender's address is used when the sender is the requester, and none
when someone else is. If the details are still refused, the request is
recorded without the target date and requester email rather than not at
all. When no model is chosen, its key has gone, or the model's answer is
unusable, MikeGC still records the request: the email subject or the first
line of the Slack message as the subject, the message as the description, the
sender as requester, no target date, unassigned, with every accepted
attachment.

Triage and AI preprocessing run with the organization's model keys, as the
owner or admin who last saved the settings, each with its own model under
**Intake** in Model Preferences. Each list offers every model those keys can run, and saving one
checks it has a key. New settings start triage on a fast, low-cost model (for
example Claude Haiku) and preprocessing on a stronger one (for example Claude
Sonnet), each with a key, so both run from the start; with no key at all they
start with none. If the person they run as is no longer an owner or admin,
they use only the deployment's own keys. The Intake settings say, for each,
when there is no model to choose, none is chosen, or the chosen model's key
has gone; preprocessing that can't run says why in its note instead.

## Documents

PDF, Word, Excel and PowerPoint attachments are accepted: up to 10 per message
and 25 MB each. Anything else, or anything over those limits, is listed at the
end of the request's description so a reviewer can ask for it. Images
embedded in an email's body, such as signature logos, are left out without
being listed. Accepted documents become the request's documents, like ones a
member uploads, and every member can open them: Word and PowerPoint files are
converted for the viewer the same way, and they are stored under
`documents/intake-<organization ID>/` because MikeGC is not a user.

## Setting up email

You need a [Postmark](https://postmarkapp.com/) account. Its free tier handles
inbound mail.

1. In MikeGC, open the organization's **Settings → Intake**, turn on **Record
   requests from email** and choose **Generate**. Copy the webhook URL
   straight away: it contains a secret and is shown only once. **Replace**
   generates another, and the old one stops working.
2. In Postmark, open your server's **Inbound** message stream. Paste the URL as
   its **Webhook URL** and save. Note the stream's inbound address
   (`…@inbound.postmarkapp.com`), or set up an inbound domain.
3. Forward your intake address to that inbound address: a Google Workspace
   routing rule or Gmail forwarding for Gmail, or a mail flow rule or mailbox
   forwarding for Outlook and Exchange Online.
4. List the **sender domains** to accept, such as `example.com` (which also
   accepts its subdomains, such as `eu.example.com`). Until at least one is
   listed, no mail is recorded. Mail from other domains is recorded as
   ignored, without creating a request. The check reads the From header,
   which a sender can forge: it keeps out stray mail, not a determined
   impostor.
5. Send a test message from an accepted domain, then check that it appears in
   Intake's requests.

Automatic replies, such as out-of-office messages, and bulk or list mail
are recorded as ignored, without their content. A message Postmark delivers
twice is recorded once. A webhook URL that has been replaced, or email
switched off, answers `403`, which tells Postmark to stop retrying.

## Setting up Slack

Someone allowed to create apps in your Slack workspace does this once per
organization. Slack verifies the events URL as soon as you enter it, so enter
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
3. In MikeGC, open the organization's **Settings → Intake**, turn on **Record
   requests from Slack** and paste both. Each saves when you leave its field
   or press Enter, and Slack turns on once both are saved. MikeGC checks the
   token with Slack and shows the workspace it belongs to.
4. Back in the Slack app, open **Event Subscriptions**, turn events on, and
   paste MikeGC's **Events Request URL** from the settings page. Slack should
   show it as verified. Under **Subscribe to bot events**, add `app_mention`,
   save, and reinstall the app if Slack asks.
5. Invite MikeGC to the channels people ask Legal in (`/invite @MikeGC`).
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
  recorded as failed, with a reason, in `intake_inbound`, and MikeGC says so
  in the Slack thread.
- **Preprocessing.** When a request's rule asks for it, the inbound job queues
  `intake.preprocess` once its documents are attached. The job reads the
  documents through the documents module's organization-owned path (they have
  no uploader, so no member's access applies), writes tracked changes as a new
  version through the same module, and posts its note with
  `intake_note_automated`. The note's ID is fixed when the job is queued, so a
  retried job posts it once and does nothing after; a job that fails for good
  posts a short note saying preprocessing couldn't finish.
- **Secrets.** The Slack signing secret and bot token are encrypted at rest
  with `MCP_CONNECTORS_ENCRYPTION_SECRET`, like connector credentials, and are
  never sent back to the browser.
- **Retention.** A message's content is kept only until it is handled; the
  request then holds it. Deleting all intake requests in **Privacy & Data**,
  and purging the organization, delete received messages too, and a database
  trigger hands the attachments of any still waiting to the storage worker.
  A member's assignment rules are deleted when they leave the organization.
- **Not recorded.** Changes to these settings are not written to the audit
  log yet.

## Deployment

Apply `backend/migrations/20261102_02_intake_automation.sql`,
`backend/migrations/20261102_03_intake_assignment_rules.sql`,
`backend/migrations/20261102_04_intake_remove_timezone.sql`,
`backend/migrations/20261102_05_intake_rule_preprocessing.sql`,
`backend/migrations/20261103_01_intake_triage_always_on.sql`,
`backend/migrations/20261103_02_intake_triage_model.sql` and
`backend/migrations/20261103_03_intake_preprocessing_model.sql` before starting
the new build. The second turns any note of what a member handles into a rule
assigning to them. The third removes the timezone that requests kept with
their target date, which is overdue once it has passed where the viewer is.
The fourth adds AI preprocessing to rules and lets MikeGC post notes. The
fifth removes the switch that turned AI triage off, so it runs for every
organization, including any that had switched it off. The sixth adds the
triage model, and the seventh the preprocessing model; settings that already
exist have neither, so an admin chooses them before triage and preprocessing
run again. No new environment variables are required: the webhook URLs are
built from `API_PUBLIC_URL`, the request links in Slack replies from
`FRONTEND_URL`, and secrets are encrypted with `MCP_CONNECTORS_ENCRYPTION_SECRET`
(or `USER_API_KEYS_ENCRYPTION_SECRET`). Webhook deliveries have their own rate
limit, 120 a minute per sending address, which `RATE_LIMIT_WEBHOOK_MAX` and
`RATE_LIMIT_WEBHOOK_WINDOW_MINUTES` can change.

Both webhooks must reach the API over public HTTPS. The frontend's `/api`
gateway forwards them unchanged, including Slack's signature headers, the raw
body Slack signs and large Postmark messages, so `API_PUBLIC_URL` can be the
usual same-origin gateway. For local development, run a tunnel and set
`API_PUBLIC_URL` to it, as for the Slack connector in
[connectors.md](connectors.md).
