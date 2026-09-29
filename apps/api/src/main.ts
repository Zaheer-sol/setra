import { appEnv } from "@setra/config";
import { closePools } from "@setra/database";
import { buildServer } from "./server";

process.env.SETRA_SERVICE ??= "setra-api";
const env = appEnv();
const app = await buildServer();
await app.listen({ host: "0.0.0.0", port: env.API_PORT });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await closePools();
    process.exit(0);
  });
}
