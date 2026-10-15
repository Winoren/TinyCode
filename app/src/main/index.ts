/**
 * Electron entry point: window lifecycle plus the IPC surface.
 *
 * All agent work lives in AgentHost; this file wires handlers and validates the
 * arguments that cross the trust boundary. Security defaults: context
 * isolation on, nodeIntegration off, no remote content, every renderer call
 * validated before use.
 */

import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import type { ApiResult } from "../shared/protocol.ts";
import { AgentHost } from "./agent-host.ts";
import { loadDotEnv } from "./dotenv.ts";
import { isFakeMode } from "./fake-run.ts";

// The install root holds the `.env` the CLI launcher would read. The built
// entry lives at <root>/app/out/main/index.js, so the root is three levels up.
const installRoot = path.resolve(import.meta.dirname, "../../..");
loadDotEnv(installRoot);

let window: BrowserWindow | null = null;
const host = new AgentHost(() => window, installRoot);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

function result<T>(work: () => T | Promise<T>): Promise<ApiResult<T>> {
  return Promise.resolve()
    .then(work)
    .then((data) => ({ ok: true as const, data }))
    .catch((error: unknown) => ({ ok: false as const, error: describe(error) }));
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function registerIpcHandlers(): void {
  ipcMain.handle("desktop:start-run", (_event, task: unknown, cwd: unknown) =>
    result(async () => {
      if (!isNonEmptyString(task)) throw new Error("task must be a non-empty string");
      if (!isNonEmptyString(cwd)) throw new Error("workspace must be a non-empty string");
      await host.startRun(task, cwd);
      return null;
    }),
  );

  ipcMain.handle("desktop:cancel-run", () =>
    result(() => {
      host.cancelRun();
      return null;
    }),
  );

  ipcMain.handle("desktop:answer-human", (_event, requestId: unknown, value: unknown) =>
    result(() => {
      if (typeof requestId !== "number" || !Number.isInteger(requestId) || requestId <= 0) {
        throw new Error("requestId must be a positive integer");
      }
      host.answerHuman(requestId, value);
      return null;
    }),
  );

  ipcMain.handle("desktop:pick-workspace", () => result(() => host.pickWorkspace()));

  ipcMain.handle("desktop:list-runs", (_event, cwd: unknown) =>
    result(async () => {
      if (!isNonEmptyString(cwd)) throw new Error("workspace must be a non-empty string");
      return host.listRuns(cwd);
    }),
  );

  ipcMain.handle("desktop:load-run", (_event, cwd: unknown, runId: unknown) =>
    result(async () => {
      if (!isNonEmptyString(cwd)) throw new Error("workspace must be a non-empty string");
      if (!isNonEmptyString(runId)) throw new Error("runId must be a non-empty string");
      return host.loadRun(cwd, runId);
    }),
  );

  ipcMain.handle("desktop:initial-state", () =>
    result(() => ({
      workspace:
        process.env.TINYCODE_DESKTOP_WORKSPACE ??
        (process.env.HOME !== undefined && process.env.HOME !== "" ? process.env.HOME : installRoot),
      fakeMode: isFakeMode(),
    })),
  );
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 940,
    minHeight: 600,
    title: "TinyCode",
    backgroundColor: "#14181d",
    show: false,
    webPreferences: {
      preload: path.join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload requires the sandbox off. The preload is trusted local code
      // that only bridges typed IPC — it loads no content and takes no input.
      sandbox: false,
    },
  });

  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = null;
  });

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    // Dev server (electron-vite). Local only, no remote content.
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window === null) {
      createWindow();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(() => {
    registerIpcHandlers();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // One window, one run: quitting with the window is the expected lifecycle.
  app.on("window-all-closed", () => {
    app.quit();
  });
}
