/** Compile-time injected from package.json by vite.config.ts (`define`). */
declare const __APP_VERSION__: string;

/** Minimal Vite env typing so `import.meta.env.DEV` typechecks under tsc.
 *  Vite statically replaces this literal (DEV=false in prod), so guarded
 *  dev-only branches tree-shake out of the production bundle. */
interface ImportMeta {
  readonly env: { readonly DEV: boolean; readonly PROD: boolean; readonly MODE: string };
}
