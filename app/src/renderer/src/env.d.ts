import type { DesktopApi } from "../../shared/protocol.ts";

declare global {
  interface Window {
    tinycode: DesktopApi;
  }
}

export {};
