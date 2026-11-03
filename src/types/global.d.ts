import type { HmRemoteApi } from "../shared/types";

declare global {
  interface Window {
    hmRemote: HmRemoteApi;
  }
}

export {};
