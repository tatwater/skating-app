// `import.meta.glob` is a Vite feature used only in tests to build convex-test's
// module map. Declared locally so we don't take a hard dependency on `vite/client`
// types. The return type is assignable to convex-test's `Record<string, () =>
// Promise<any>>` module-map parameter.
interface ImportMeta {
  glob(pattern: string | string[]): Record<string, () => Promise<Record<string, unknown>>>;
}

// `process.env` is readable in Convex's function runtime for deployment env vars
// (e.g. auth.config.ts). Declared minimally so we don't pull full @types/node — and
// its node-only APIs — into the isolate's type surface.
declare const process: { readonly env: Record<string, string | undefined> };
