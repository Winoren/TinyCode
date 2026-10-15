/**
 * Page object for the TinyCode desktop app under test.
 *
 * Launches Electron with the deterministic fake driver
 * (`TINYCODE_DESKTOP_FAKE=1`) pointed at a scratch workspace, so tests
 * exercise the real Runtime, gate, tool registry and persistence without a
 * network or credentials.
 */

import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect, type ElectronApplication, type Page } from "@playwright/test";

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class DesktopApp {
  private constructor(
    readonly page: Page,
    private readonly electron: ElectronApplication,
  ) {}

  static async launch(workspace: string): Promise<DesktopApp> {
    const electron: ElectronApplication = await _electron.launch({
      args: [APP_DIR],
      env: {
        ...process.env,
        TINYCODE_DESKTOP_FAKE: "1",
        TINYCODE_DESKTOP_WORKSPACE: workspace,
      },
    });
    const page = await electron.firstWindow();
    await page.getByTestId("task-input").waitFor();
    return new DesktopApp(page, electron);
  }

  /** A scratch git repository to run the fake driver against. */
  static async createWorkspace(): Promise<string> {
    const workspace = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "tinycode-e2e-"));
    execSync("git init", { cwd: workspace, stdio: "ignore" });
    return workspace;
  }

  static async removeWorkspace(workspace: string): Promise<void> {
    await rm(workspace, { recursive: true, force: true });
  }

  get taskInput() { return this.page.getByTestId("task-input"); }
  get runButton() { return this.page.getByTestId("run-button"); }
  get cancelButton() { return this.page.getByTestId("cancel-button"); }
  get approvalDialog() { return this.page.getByTestId("approval-dialog"); }
  get approvalQuestion() { return this.page.getByTestId("approval-question"); }
  get approveButton() { return this.page.getByTestId("approve-button"); }
  get declineButton() { return this.page.getByTestId("decline-button"); }
  get terminalBanner() { return this.page.getByTestId("terminal-banner"); }
  get usagePanel() { return this.page.getByTestId("usage-panel"); }
  get workspaceName() { return this.page.getByTestId("workspace-name"); }
  get liveButton() { return this.page.getByTestId("live-button"); }
  get historyRuns() { return this.page.locator('[data-testid="history-run"]'); }

  toolCard(status: string): ReturnType<Page["locator"]> {
    return this.page.locator(`[data-testid="timeline-tool"][data-status="${status}"]`);
  }

  async runTask(task: string): Promise<void> {
    await this.taskInput.fill(task);
    await this.runButton.click();
  }

  async expectTerminal(status: string): Promise<void> {
    await expect(this.terminalBanner).toHaveAttribute("data-terminal-status", status);
  }

  async close(): Promise<void> {
    await this.electron.close();
  }
}
