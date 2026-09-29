import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildServer } from "../server";

const app = await buildServer({ logger: false });
await app.ready();
const out = resolve(import.meta.dirname, "../../../../docs/openapi.json");
writeFileSync(out, JSON.stringify(app.swagger(), null, 2));
console.log(`wrote ${out}`);
await app.close();
process.exit(0);
