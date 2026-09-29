// Bundle a Node service (API or worker) into a single ESM file.
// Workspace packages (@setra/*) are compiled in; third-party dependencies stay external and are
// installed normally in the runtime image.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) throw new Error("usage: build-service <entry> <outfile>");

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
const external = Object.keys(lock.packages)
  .filter((p) => p.startsWith("node_modules/") && !p.includes("/node_modules/", 13))
  .map((p) => p.slice("node_modules/".length))
  .filter((name) => !name.startsWith("@setra/"));

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info"
});
