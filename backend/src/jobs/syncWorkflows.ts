import "../instrument";
import { createServerSupabase } from "../lib/supabase";
import { flushSentry, reportError } from "../lib/observability/sentry";
import { syncWorkflowCatalog } from "../lib/workflowCatalogSync";

async function main() {
  const result = await syncWorkflowCatalog(createServerSupabase());
  console.log(
    `Synced ${result.workflows} Spectre workflows and ${result.assets} assets from ${result.sourceCommit}`,
  );
}

void main().catch(async (error) => {
  reportError(error, { tags: { component: "workflow-sync" }, level: "fatal" });
  console.error("Spectre workflow sync failed", error);
  await flushSentry();
  process.exit(1);
});
