/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_BACKEND_PORT?: string;
  readonly VITE_BACKEND_URL?: string;
  /** Same value as server `.env` `BACKEND_API_KEY` / `MMB_API_TOKEN` — injected at build/dev for `x-api-key`. */
  readonly VITE_BACKEND_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
