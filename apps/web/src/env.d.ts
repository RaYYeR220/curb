/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The RPC the site reads through; a path such as `rpc` is resolved against the site's origin. */
  readonly VITE_RPC?: string;
}
