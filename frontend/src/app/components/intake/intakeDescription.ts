/**
 * The original message MikeGC appends to a request's description when it
 * writes a summary (`composeDescription` in the backend's intake.triage.ts):
 *
 *   <summary>
 *
 *   --- Original message ---
 *   From: Will Chen <will@example.com> in Slack
 *   Sent: 3 Nov 2026, 14:11 UTC
 *   Subject: ...                       (email only)
 *
 *   <the message, or a thread as "Author, 3 Nov 2026, 14:11 UTC:\ntext"
 *    entries separated by blank lines>
 *
 *   --- Not attached ---
 *   - name: reason
 *
 * Read back so the page can show the summary on its own and the message as
 * a conversation. A description a lawyer rewrote into another shape is shown
 * as written.
 */

export interface IntakeOriginalEntry {
  author: string;
  /** ISO time, or null when the text carried none we could read. */
  sentAt: string | null;
  text: string;
}

export interface IntakeOriginalMessage {
  /** The description before the original message. */
  summary: string;
  /** Everything from the marker on, as written, kept when the summary is edited. */
  original: string;
  sender: string;
  channel: string | null;
  subject: string | null;
  entries: IntakeOriginalEntry[];
  /** "name: reason" lines for attachments MikeGC left off. */
  notAttached: string[];
  shortened: boolean;
}

const MARKER = "\n\n--- Original message ---\n";
const NOT_ATTACHED = "\n\n--- Not attached ---\n";
const SHORTENED = "\n[Message shortened to fit.]";
const CHANNELS = ["Slack", "Outlook", "Gmail", "Teams"];
const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const TIME = String.raw`(\d{1,2}) ([A-Za-z]{3,4}) (\d{4}), (\d{2}):(\d{2}) UTC`;
const ENTRY_HEAD = new RegExp(String.raw`^(.+), (${TIME}):$`);
/** Channels whose original message can be a thread of entries; an email is one message. */
const THREAD_CHANNELS = ["Slack", "Teams"];
/**
 * A line of MikeGC's list of attachments it left off, in the words of
 * `SKIPPED_REASON` in the backend's intake.triage.ts.
 */
const NOT_ATTACHED_LINE =
  /^- .+: (not a PDF, Word, Excel or PowerPoint file|larger than [\d.]+ MB|more than \d+ attachments|could not be read)$/;

/** "3 Nov 2026, 14:11 UTC" as an ISO time. */
export function parseIntakeSentTime(text: string): string | null {
  const match = new RegExp(`^${TIME}$`).exec(text.trim());
  if (!match) return null;
  const [, day, month, year, hour, minute] = match;
  const m = MONTHS.indexOf(month!.slice(0, 3).toLowerCase());
  if (m < 0) return null;
  const date = new Date(Date.UTC(+year!, m, +day!, +hour!, +minute!));
  // Date.UTC rolls an impossible date over ("31 Feb" is 3 March): refuse it.
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== +year! ||
    date.getUTCMonth() !== m ||
    date.getUTCDate() !== +day! ||
    date.getUTCHours() !== +hour! ||
    date.getUTCMinutes() !== +minute!
  )
    return null;
  return date.toISOString();
}

/** "Name <email>" as its name. */
function senderName(from: string) {
  return from.replace(/\s*<[^>]*>$/, "").trim() || from;
}

export function parseIntakeDescription(
  description: string,
): IntakeOriginalMessage | null {
  const at = description.indexOf(MARKER);
  if (at < 0) return null;
  const summary = description.slice(0, at).trim();
  const original = description.slice(at + 2);
  let rest = description.slice(at + MARKER.length);

  const headerEnd = rest.indexOf("\n\n");
  if (headerEnd < 0) return null;
  const header = rest.slice(0, headerEnd).split("\n");
  rest = rest.slice(headerEnd + 2);
  const field = (name: string) =>
    header.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2) ??
    null;
  let from = field("From");
  const sent = field("Sent");
  if (from === null || sent === null) return null;
  let channel: string | null = null;
  for (const name of CHANNELS)
    if (from.endsWith(` in ${name}`)) {
      channel = name;
      from = from.slice(0, -` in ${name}`.length);
    }

  // MikeGC's list ends the description, in its own words; the same marker
  // in the requester's text is part of their message.
  let notAttached: string[] = [];
  const tail = rest.lastIndexOf(NOT_ATTACHED);
  if (tail >= 0) {
    const listed = rest
      .slice(tail + NOT_ATTACHED.length)
      .trimEnd()
      .split("\n");
    if (listed.every((l) => NOT_ATTACHED_LINE.test(l))) {
      notAttached = listed.map((l) => l.slice(2));
      rest = rest.slice(0, tail);
    }
  }
  const shortened = rest.endsWith(SHORTENED);
  if (shortened) rest = rest.slice(0, -SHORTENED.length);

  // A Slack or Teams thread: entries that each start with "Author, time:"
  // after a blank line, the first on the first line. Anything else, an email
  // above all, is one message, so a line in it shaped like an entry's start
  // can't speak for someone else.
  const entries: IntakeOriginalEntry[] = [];
  let current: IntakeOriginalEntry | null = null;
  const lines = rest.split("\n");
  const thread =
    channel !== null &&
    THREAD_CHANNELS.includes(channel) &&
    ENTRY_HEAD.test(lines[0] ?? "");
  lines.forEach((line, i) => {
    const head =
      thread && (i === 0 || lines[i - 1] === "") && ENTRY_HEAD.exec(line);
    if (head) {
      current = {
        author: head[1]!,
        sentAt: parseIntakeSentTime(head[2]!),
        text: "",
      };
      entries.push(current);
    } else if (current) current.text += `${current.text ? "\n" : ""}${line}`;
    else {
      current = {
        author: senderName(from!),
        sentAt: parseIntakeSentTime(sent),
        text: line,
      };
      entries.push(current);
    }
  });
  for (const entry of entries) entry.text = entry.text.trim();

  return {
    summary,
    original,
    sender: senderName(from),
    channel,
    subject: field("Subject"),
    entries: entries.filter((e) => e.text),
    notAttached,
    shortened,
  };
}
