import { decryptString, encryptString } from "../../lib/mcp/client";
import type { AutomationRow } from "./intake.settingsRow";

/**
 * The channel credentials in an organization's intake settings, encrypted at
 * rest with the connectors' key (AES-256-GCM) and never sent to the browser.
 * Each is stored as three columns: `<name>_encrypted`, `_iv` and `_tag`.
 */

type SecretName =
  | "slack_signing_secret"
  | "slack_bot_token"
  | "graph_client_secret"
  | "teams_client_secret";

function secret(row: Partial<AutomationRow>, name: SecretName): string | null {
  const columns = row as Record<string, string | null | undefined>;
  return decryptString(
    columns[`${name}_encrypted`] ?? null,
    columns[`${name}_iv`] ?? null,
    columns[`${name}_tag`] ?? null,
  );
}

export const slackSigningSecret = (row: Partial<AutomationRow>) =>
  secret(row, "slack_signing_secret");
export const slackBotToken = (row: Partial<AutomationRow>) =>
  secret(row, "slack_bot_token");
export const graphClientSecret = (row: Partial<AutomationRow>) =>
  secret(row, "graph_client_secret");
export const teamsClientSecret = (row: Partial<AutomationRow>) =>
  secret(row, "teams_client_secret");

/** A secret's three columns, or null when the encryption key isn't configured. */
export function encryptedColumns(
  name: SecretName,
  value: string,
): Record<string, string> | null {
  try {
    const sealed = encryptString(value);
    return {
      [`${name}_encrypted`]: sealed.encrypted,
      [`${name}_iv`]: sealed.iv,
      [`${name}_tag`]: sealed.tag,
    };
  } catch {
    return null;
  }
}
