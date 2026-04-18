/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_SIGNUP_ENDPOINT?: string;
  readonly PUBLIC_SIGNUP_SOURCE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
