import { defineConfig } from "rolldown";

/**
 * Production bundle for the Discord Runtime.
 *
 * Mirrors the previous esbuild invocation: every dependency (discord.js
 * included) is bundled into a single ESM file. The banner shims `require`
 * via `createRequire` for CJS deps that need it in ESM output; the import
 * is aliased because rolldown's interop also declares `createRequire`.
 */
export default defineConfig({
  input: "src/index.ts",
  platform: "node",
  output: {
    file: "dist/index.js",
    format: "esm",
    sourcemap: true,
    banner:
      "import { createRequire as __createRequire } from 'module';const require = __createRequire(import.meta.url);",
  },
});
