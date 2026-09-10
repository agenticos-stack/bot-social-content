import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The gadget's server module imports `cloudflare:workers`, which only exists
// inside workerd. These are node unit tests of pure logic, so the import is
// aliased to the same minimal shim the API used before this suite moved here —
// it is a stand-in for the runtime, never a claim that the runtime was tested.
const cloudflareWorkersShim = fileURLToPath(
  new URL("./test/unit/_helpers/cloudflare-workers.ts", import.meta.url)
);

export default defineConfig({
  resolve: {
    alias: [{ find: "cloudflare:workers", replacement: cloudflareWorkersShim }]
  },
  test: {
    environment: "node",
    include: ["test/unit/**/*.test.ts"]
  }
});
