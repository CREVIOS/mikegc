import { expect, test } from "./fixtures";

// The Bangladesh workflow pack ships with Spectre: the workflow sync merges it
// into the catalog (backend/src/lib/workflowCatalogSource.ts), and a user
// imports it from Workflows > Add-ons. Runs against the real backend and
// database, so a pack the sync dropped, or one the add-on list cannot show,
// fails here.

const ASSISTANT_PACK = "Bangladesh legal practice (assistant)";
const TABULAR_PACK = "Bangladesh contract reviews (tabular)";

test("the Bangladesh workflow pack is offered as add-ons and can be imported", async ({ page }) => {
    await page.goto("/workflows");
    await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Add-ons", exact: true }).click();

    // Both packs are listed under names that tell them apart.
    const expandAssistant = page.getByRole("button", { name: `Expand ${ASSISTANT_PACK}` });
    await expect(expandAssistant).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: `Expand ${TABULAR_PACK}` })).toBeVisible();

    await expandAssistant.click();
    await expect(page.getByText("Writ Petition (Article 102)", { exact: true })).toBeVisible();
    await expect(page.getByText("Legal Notice (উকিল নোটিশ)", { exact: true })).toBeVisible();

    // Import the whole assistant pack from its row. The worker's account is
    // reused across runs, so it may already be imported.
    // Rows are not table roles; the pack's row is the innermost element that
    // holds both its checkbox and an import button.
    const importName = /^(Import|Importing…|Imported)$/;
    const packRow = page
        .locator("div")
        .filter({ has: page.getByRole("checkbox", { name: `Select ${ASSISTANT_PACK}` }) })
        .filter({ has: page.getByRole("button", { name: importName }) })
        .last();
    const importButton = packRow.getByRole("button", { name: importName }).first();
    if ((await importButton.getAttribute("aria-label")) === "Import") await importButton.click();
    await expect(importButton).toHaveAttribute("aria-label", "Imported", { timeout: 30_000 });

    // The imported workflows are the user's own now.
    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(page.getByText("Writ Petition (Article 102)", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Artha Rin (Money Loan) Suit", { exact: true })).toBeVisible();
});
