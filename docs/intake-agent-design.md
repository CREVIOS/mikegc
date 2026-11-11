# Intake agent: one loop for channel messages (design proposal)

Status: proposal, not built. Written 2026-11-10.

## Why

Intake decides what to do with a Slack, Teams, Gmail or Outlook message in
three separate model steps, each with its own prompt and its own rules about
which of its output is kept:

| Step | Prompt | Runs when | Keeps |
|---|---|---|---|
| Triage | `SYSTEM_PROMPT`, `intake.triage.ts` | A new message arrives | Everything: reply, or a request's fields, rule and questions |
| `rerunRule` | Same triage prompt, `intake.reply.ts` | The requester answers a "which rule?" question on a recorded request | Rule and assignee only; the new subject, summary and date are dropped |
| Readiness | `READINESS_PROMPT`, `intake.clarify.ts` | Before preprocessing, and when the requester answers its questions | Ready or not, and questions |

Around them sits a set of special cases in code. For example, questions are
only kept when there are rules, a reply is refused with attachments or a
thread, chat replies stop after 3 rounds, and a reply is only allowed in
chat channels and in email threads of a request's own.

The result is hard to follow and has gaps. A requester's answer never
updates a request's details, and answers to readiness questions never reach
triage at all.

**Proposal:** replace triage, `rerunRule` and the chat-reply path with one
agent that, for each incoming message in a thread, reads the whole
conversation and acts through a small set of tools. The code enforces every
limit inside the tools, not in the prompt.

## Scope

In scope:
- New messages and replies in Slack, Teams, Gmail and Outlook threads.
- Replying, asking, recording, updating a request's details, choosing a
  rule.

Out of scope for the first version:
- Preprocessing and its readiness check. These depend on the workflow or
  playbook of the chosen rule and stay as they are; the agent only queues
  them, as `processInbound` does today.
- Postmark email, which has no thread to answer in. It is always recorded.
- Lawyers' messages and MikeGC's own messages, which never run the agent.

## The loop

One job, `intake.agent`, replaces `intake.inbound` and the rule-stage part of
`intake.reply`. For each stored incoming message:

```
context = {
  thread:      everything people wrote in the thread, oldest first,
               plus MikeGC's own earlier replies (marked as such)
  request:     the linked request's subject, summary, due date, state,
               and which fields a member has edited, or none
  rules:       numbered conditions, as triage gets them today
  attachments: numbered, with name, type and size
  today, channel, sender
}

run the model with the tools below, at most 4 steps
```

Each step's tool calls run in order. The loop stops when the model stops
calling tools, when it calls `reply`, or after 4 steps. If the loop ends
having done nothing, the code falls back to what triage does with no model
today: record the message as it arrived, unassigned. A message is never lost.

The loop builds on `streamChatWithTools` in `lib/llm`, which the assistant
chat already uses, with a non-streaming wrapper.

## Tools

Every tool checks its own limits and returns a short result the model can
read ("recorded", "refused: …"). Refusals never throw.

### `reply(text)`

Posts in the thread the message came from, under MikeGC's name.

Code limits:
- At most 600 characters. No links, email addresses or mentions (today's
  `REPLY_FORBIDDEN`).
- At most 3 replies per thread without a request (today's
  `intake_conversations.rounds`). Past that, refused, and the loop records.
- Once per run.
- Escaped for the channel, as today.

### `record_request(subject, summary, requester_name, requester_email, due_date, attachments)`

Records the request, links it to the thread, adds the chosen attachments and
queues the acknowledgement.

Code limits:
- Only when no request is linked to the thread yet.
- The same field checks `applyTriage` makes today: a real calendar date, an
  email only if it is the sender's or appears in the message, attachment
  numbers in range, subject and summary lengths.
- The description keeps the original message under the summary, as today.

### `update_request(subject?, summary?, due_date?)`

Changes a linked request's details from what the requester said.

Code limits:
- Only on a request that is open (not resolved or cancelled).
- Never a field a member has edited since MikeGC set it. The request records
  which fields MikeGC last wrote; any later member edit locks that field
  against the agent.
- Never the requester, the assignee or the state.
- Each change adds an activity entry ("MikeGC updated the due date to
  14 Nov from the requester's answer").

### `choose_rule(rule_number | null)`

Assigns the request to the rule's lawyer, or leaves it unassigned with
`null`, and queues the rule's preprocessing if it asks for it.

Code limits:
- Only numbers listed in RULES. Member ids never reach the model.
- Only while the rule is undecided: on a new request, or one waiting on
  rule answers. A request already assigned keeps its assignee.

## What the prompt says

The prompt shrinks to judgement. The limits now live in the tools.

- If the message isn't a request (a greeting, thanks, small talk, a question
  about MikeGC or how to reach Legal), `reply` and stop.
- If it is a request:
  - If you can tell which rule fits, call `record_request`, then
    `choose_rule`.
  - If you can't tell which rule fits and there are no attachments, `reply`
    with up to 3 questions. Don't record yet.
  - With attachments, `record_request` first, then `reply` with your
    questions.
- If a request is already linked and the requester answered, call
  `update_request` with anything the answer changes, then `choose_rule` if
  the rule was undecided.
- Never give legal advice or opinions. A legal question is a request.
- The untrusted-content paragraph, word for word as today.

## Retries and idempotency

Jobs retry after crashes, so every tool must be safe to run twice. Each tool
call gets a key: the incoming message's id, plus the step and call index.

| Tool | How a repeat is a no-op |
|---|---|
| `record_request` | Keyed by the message id, as `intake_submit_automated` is today. |
| `reply` | An outbox row keyed by the tool call. Delivery asks the channel whether an earlier attempt landed, as `intake.deliver` does today. |
| `update_request` | Writes fixed values, so repeating it is harmless. The activity entry is keyed by the tool call. |
| `choose_rule` | Settles once, as `settleClarify` does today. |

The model's tool calls for a run are saved on the message before any tool
runs. A retry replays the saved calls instead of asking the model again, so
the model's answer can't change between attempts. This is the same approach
as today's saved `payload.plan`.

## Prompt injection

The thread is untrusted. An agent with `update_request` is a bigger target
than today's single JSON answer, so:
- Tools take only plain values, checked as listed above.
- `update_request` can't touch the requester, assignee or state, or override a
  member's edit. The worst an injected message can do is make the request's
  own summary misleading, and the original text is always kept below it.
- `reply` can't carry links, addresses or mentions, and goes only to the
  thread the message came from.
- Every agent action shows in the request's activity.

## Cost and speed

At most 4 model steps per message, against 1 today, though most messages
take 1 or 2: a greeting is one `reply`, and a clear request is one step with
two tool calls. Readiness is unchanged. The triage model setting keeps
choosing the model.

## What gets removed

- `triageInbound`'s JSON format, `applyTriage`'s reply and questions
  handling, and the `questions` field of `TriagePlan`.
- `rerunRule` in `intake.reply.ts`. Replies on a request waiting on rule
  answers run the agent instead. Readiness replies still go to the
  readiness check.
- The chat-reply branch in `processInbound` (`sendChatReply` stays as the
  `reply` tool's sender).

`intake_conversations` stays. It now counts `reply` calls per thread.

## Rollout

1. Build the loop and tools behind an organization setting, off by default,
   with Slack only.
2. Run the agent and today's triage side by side in tests, on the existing
   fixtures, and compare their decisions.
3. Turn it on for Slack in the dev organization. Then Teams, then email.
4. Remove the old path once all four channels use the agent.

## Open questions

- **Field-edit tracking.** `update_request` needs to know whether a member
  edited a field since MikeGC set it. Is the activity history enough, or
  does `intake_requests` need a per-field "last set by" column?
- **Step limit.** Is 4 right? A greeting needs 1, and record, then choose,
  then reply needs 2 or 3.
- **Readiness.** Should the readiness check become a tool later, so one loop
  covers every requester question?
- **Model choice.** Tool calling needs a model that does it reliably. Should
  the setting only offer such models?
