/** Names an intake request to process in a new assistant chat. */
export const LINKED_INTAKE_PARAM = "intake";
/** The request's workspace: an organization's id, or "personal". */
export const LINKED_INTAKE_ORG_PARAM = "intake_org";

/** What the composer suggests asking about a request, sent only when the user sends it. */
export const INTAKE_PROCESS_PROMPT =
  "Process this intake request: work out what is being asked and what is still missing, review it and its documents for the main legal issues and risks, and recommend the next steps.";

/** A new assistant chat with the request's pill and a suggested prompt in the composer. */
export function assistantPathWithIntake(requestId: string, org: string) {
  const params = new URLSearchParams({
    [LINKED_INTAKE_PARAM]: requestId,
    [LINKED_INTAKE_ORG_PARAM]: org,
  });
  return `/assistant?${params.toString()}`;
}
