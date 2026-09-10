import { build } from "esbuild";
import { fileURLToPath } from "node:url";

export async function buildClient() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/src/client/client.js", import.meta.url))],
    bundle: true, format: "esm", platform: "browser", target: "es2022",
    minify: true, legalComments: "none", write: false, external: [], logLevel: "warning",
    loader: { '.css': 'text' }
  });
  const [output] = result.outputFiles;
  if (!output) throw new Error("esbuild produced no client output.");
  return output.text;
}
