/**
 * The preload bridge: the only door between the renderer and the main process.
 *
 * Exposes exactly the typed `DesktopApi` surface through contextBridge — no raw
 * `ipcRenderer`, no dynamic channel names. The host pushes messages on one
 * channel; every call the renderer can make is a named function here.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, HostMessage } from "../shared/protocol.ts";

const HOST_CHANNEL = "desktop:host-message";

const api: DesktopApi = {
  startRun: (task, cwd) => ipcRenderer.invoke("desktop:start-run", task, cwd),
  cancelRun: () => ipcRenderer.invoke("desktop:cancel-run"),
  answerHuman: (requestId, value) => ipcRenderer.invoke("desktop:answer-human", requestId, value),
  pickWorkspace: () => ipcRenderer.invoke("desktop:pick-workspace"),
  listRuns: (cwd) => ipcRenderer.invoke("desktop:list-runs", cwd),
  loadRun: (cwd, runId) => ipcRenderer.invoke("desktop:load-run", cwd, runId),
  getInitialState: () => ipcRenderer.invoke("desktop:initial-state"),
  onHostMessage: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: HostMessage): void => {
      listener(message);
    };
    ipcRenderer.on(HOST_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(HOST_CHANNEL, handler);
    };
  },
};

contextBridge.exposeInMainWorld("tinycode", api);
