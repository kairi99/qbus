/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL (ws:// or wss://) of the online race room server. */
  readonly VITE_QBUS_ROOMS_URL?: string;
}
