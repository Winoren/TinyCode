/**
 * Desktop E2E against the deterministic fake driver.
 *
 * Covers the plan's assertions without a network: run a task, watch the
 * timeline fill, answer the approval dialog both ways, see the terminal
 * banner, and replay the run from history.
 */

import { expect, test } from "@playwright/test";
import { DesktopApp } from "./desktop-app.ts";

const test_ = test.extend<{ app: DesktopApp }>({
  app: async ({}, use) => {
    const workspace = await DesktopApp.createWorkspace();
    const app = await DesktopApp.launch(workspace);
    await use(app);
    await app.close();
    await DesktopApp.removeWorkspace(workspace);
  },
});

test_.describe("TinyCode desktop", () => {
  test_("approve the gated command and reach a complete run", async ({ app }) => {
    await app.runTask("reset the repository state");

    // The gate asks before the tool runs; the dialog shows the command text.
    await app.approvalDialog.waitFor();
    await expect(app.approvalQuestion).toContainText("git reset --hard");
    await app.approveButton.click();
    await app.approvalDialog.waitFor({ state: "detached" });

    await expect(app.toolCard("success")).toHaveCount(1);
    await app.expectTerminal("complete");
    await app.usagePanel.waitFor();
  });

  test_("decline the gated command and reach a partial run", async ({ app }) => {
    await app.runTask("reset the repository state");

    await app.approvalDialog.waitFor();
    await app.declineButton.click();
    await app.approvalDialog.waitFor({ state: "detached" });

    await expect(app.toolCard("declined")).toHaveCount(1);
    await app.expectTerminal("partial");
  });

  test_("record the run in history and replay it read-only", async ({ app }) => {
    await app.runTask("reset the repository state");
    await app.approvalDialog.waitFor();
    await app.approveButton.click();
    await app.expectTerminal("complete");

    const completed = app.page.locator('[data-testid="history-run"][data-status="completed"]');
    await completed.waitFor();
    await completed.click();

    // The replay is the same fold over the same events: the assistant's final
    // message and the tool card must both appear.
    await expect(
      app.page
        .locator('[data-testid="timeline-assistant"]')
        .filter({ hasText: "Fake run finished." }),
    ).toBeVisible();
    await expect(app.toolCard("success")).toBeVisible();

    await app.liveButton.click();
    await app.taskInput.waitFor();
  });
});
