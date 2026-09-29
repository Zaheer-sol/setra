// Health monitor: checks GET /v1/health and alerts when Setra is degraded (database down, ingestion
// delayed or failing, webhook delivery stalled). Run from cron or any scheduler, or with --watch.
//
//   SETRA_HEALTH_URL=https://api.example.com/v1/health node scripts/health-monitor.mjs
//   SETRA_HEALTH_URL=... ALERT_WEBHOOK_URL=https://hooks.slack.com/... node scripts/health-monitor.mjs --watch 60
//
// Exit code 0 = ok, 1 = degraded, 2 = unreachable. ALERT_WEBHOOK_URL receives a Slack-compatible
// {"text": ...} POST on every state change (ok -> degraded, degraded -> ok).
const url = process.env.SETRA_HEALTH_URL ?? "http://localhost:4000/v1/health";
const alertUrl = process.env.ALERT_WEBHOOK_URL;
const watchIdx = process.argv.indexOf("--watch");
const intervalSec = watchIdx >= 0 ? Number(process.argv[watchIdx + 1] ?? 60) : 0;

async function check() {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = await res.json().catch(() => null);
    if (!body) return { code: 2, summary: `HTTP ${res.status} with no JSON body` };
    const problems = body.problems ?? [];
    return body.status === "ok" && res.ok ? { code: 0, summary: "ok" } : { code: 1, summary: problems.join("; ") || `status ${body.status}` };
  } catch (e) {
    return { code: 2, summary: `unreachable: ${e.message}` };
  }
}

async function alert(text) {
  if (!alertUrl) return;
  await fetch(alertUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }).catch((e) => console.error(`alert failed: ${e.message}`));
}

let last = null;
async function run() {
  const r = await check();
  const line = JSON.stringify({ time: new Date().toISOString(), url, status: ["ok", "degraded", "unreachable"][r.code], detail: r.summary });
  (r.code ? console.error : console.log)(line);
  if (last !== null && last !== r.code) await alert(r.code ? `Setra ${r.code === 1 ? "degraded" : "unreachable"}: ${r.summary}` : "Setra recovered: all checks ok");
  if (last === null && r.code && !intervalSec) await alert(`Setra ${r.code === 1 ? "degraded" : "unreachable"}: ${r.summary}`);
  last = r.code;
  return r.code;
}

if (intervalSec > 0) {
  await run();
  setInterval(run, intervalSec * 1000);
} else {
  process.exit(await run());
}
