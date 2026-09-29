// UI audit: loads every page at desktop / tablet / mobile widths and reports horizontal overflow,
// console errors, failed requests, and basic accessibility gaps (unlabelled controls, images without
// alt, missing h1, duplicate ids). Screenshots go to AUDIT_OUT. Usage:
//   AUDIT_EMAIL=owner@acme.test AUDIT_PASSWORD=... node scripts/ui-audit.mjs [route ...]
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";

const BASE = process.env.AUDIT_BASE ?? "http://localhost:3000";
const OUT = process.env.AUDIT_OUT ?? "test-results/ui-audit";
const routes = process.argv.slice(2).length ? process.argv.slice(2) : JSON.parse(readFileSync(process.env.AUDIT_ROUTES, "utf8"));
const widths = { desktop: [1440, 900], tablet: [820, 1100], mobile: [375, 812] };
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const results = [];
for (const [device, [width, height]] of Object.entries(widths)) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  if (process.env.AUDIT_EMAIL) {
    const r = await ctx.request.post(`${BASE}/api/v1/auth/login`, { data: { email: process.env.AUDIT_EMAIL, password: process.env.AUDIT_PASSWORD }, headers: { origin: BASE } });
    if (!r.ok()) throw new Error(`login failed: ${r.status()}`);
  }
  for (const route of routes) {
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
    page.on("response", (r) => r.status() >= 500 && errors.push(`${r.status()} ${r.url()}`));
    const res = await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 60_000 }).catch((e) => ({ status: () => `ERR ${e.message}` }));
    await page.waitForTimeout(400);
    const findings = await page.evaluate(() => {
      const out = [];
      const vw = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth > vw + 1) {
        const offenders = [...document.querySelectorAll("body *")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.right <= vw + 1) return false;
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
              const s = getComputedStyle(p);
              if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return false;
            }
            return true;
          })
          .slice(0, 4)
          .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} right=${Math.round(el.getBoundingClientRect().right)}`);
        out.push(`overflow-x: page ${document.documentElement.scrollWidth}px > ${vw}px [${offenders.join("; ")}]`);
      }
      const name = (el) => (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title") || el.textContent || "").trim();
      const unnamed = [...document.querySelectorAll("button, a[href], [role=button]")].filter((el) => el.offsetParent !== null && !name(el) && !el.querySelector("img[alt]:not([alt=''])"));
      if (unnamed.length) out.push(`unnamed controls: ${unnamed.slice(0, 4).map((e) => e.outerHTML.slice(0, 90)).join(" | ")}`);
      const unlabelled = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")].filter((el) => {
        if (el.offsetParent === null) return false;
        if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.title) return false;
        if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return false;
        return !el.closest("label");
      });
      if (unlabelled.length) out.push(`unlabelled inputs: ${unlabelled.slice(0, 4).map((e) => e.outerHTML.slice(0, 90)).join(" | ")}`);
      const noAlt = [...document.querySelectorAll("img:not([alt])")];
      if (noAlt.length) out.push(`img without alt: ${noAlt.length}`);
      const h1 = document.querySelectorAll("h1").length;
      if (h1 !== 1) out.push(`h1 count: ${h1}`);
      const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
      const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
      if (dup.length) out.push(`duplicate ids: ${dup.slice(0, 5).join(", ")}`);
      const tiny = [...document.querySelectorAll("button, a[href], input, select")].filter((el) => {
        if (el.offsetParent === null) return false;
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.height < 24 && r.width < 24 && getComputedStyle(el).display !== "inline";
      });
      if (tiny.length) out.push(`small targets (<24px): ${tiny.slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")}`).join(", ")}`);
      if (document.body.innerText.match(/\u2014/)) out.push("contains em dash");
      if (document.body.innerText.match(/undefined|NaN|\[object Object\]/)) out.push("renders undefined/NaN/[object Object]");
      return { title: document.title, findings: out };
    });
    const file = `${OUT}/${device}-${route.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home"}.png`;
    await page.screenshot({ path: file, fullPage: true });
    results.push({ device, route, status: res?.status?.(), title: findings.title, issues: [...findings.findings, ...errors.map((e) => `console: ${e}`)] });
    await page.close();
  }
  await ctx.close();
}
await browser.close();
for (const r of results) {
  const flag = r.issues.length ? "!!" : "ok";
  console.log(`${flag} ${r.device.padEnd(7)} ${String(r.status).padEnd(4)} ${r.route}`);
  for (const i of r.issues) console.log(`     - ${i}`);
}
