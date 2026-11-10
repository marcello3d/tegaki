#!/usr/bin/env node
// Device autosave test for Tegaki on 2draw (2draw/tegaki-draft.js).
//
//   node 2draw/build.mjs && node 2draw/test-autosave.mjs
//
// Serves dist-2draw/ with a same-origin stand-in for 2draw's draw page
// (host.html: index.html?draft=<key> in an iframe, window.tegakiHost,
// drawGuard, drawDraftSaved) and checks: the leave flags; a save after a
// stroke and its restore on reload (same layers, undo, the recording carries
// on); a save mid-stroke when the page is hidden; a failing store ("Not
// saved", retried); one editor per draft (two tabs); sealed chunks on a long
// drawing; a revision (anim=) continued from the copy; a picture-only
// revision (load=); a copy that can't be read is set aside; expiry; and
// submit deletes the copy once the host calls uploaded().
//
// Needs playwright-core: PLAYWRIGHT_CORE=<dir> or 2draw.net's worker/node_modules.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist-2draw");
const pwDir =
  process.env.PLAYWRIGHT_CORE ||
  [path.join(os.homedir(), "github/2draw.net/worker/node_modules/playwright-core")].find((d) => fs.existsSync(d));
if (!pwDir) throw new Error("playwright-core not found (set PLAYWRIGHT_CORE)");
const { chromium } = createRequire(path.join(pwDir, "package.json"))("./index.js");

const extra = new Map();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".txt": "text/plain" };
const HOST = `<!doctype html><meta charset="utf-8"><title>host</title>
<style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0;display:block}</style>
<script>
  window.log = { guard: [], saved: [], submits: [] };
  window.drawGuard = function (on) { log.guard.push(!!on); };
  window.drawDraftSaved = function (info) { log.saved.push(info); };
  window.uploadedOk = true;
  window.tegakiHost = {
    submit: function (png, extra) {
      return extra.animation.arrayBuffer().then(function (buf) {
        log.submits.push({ png: png.size, anim: buf.byteLength });
        window.lastAnim = new Uint8Array(buf);
        return extra.uploaded && extra.uploaded();
      });
    },
    draftSaved: function (info) { window.drawDraftSaved(info); },
  };
</script>
<iframe id="f" src="/index.html${"${Q}"}"></iframe>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/host.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HOST.replace("${Q}", u.search));
    return;
  }
  if (u.pathname === "/js/client-error.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end("window.reportClientError=function(m){(window.__reports=window.__reports||[]).push(m)};");
    return;
  }
  if (extra.has(u.pathname)) {
    const e = extra.get(u.pathname);
    res.writeHead(200, { "content-type": e.type, "access-control-allow-origin": "*" });
    res.end(e.body);
    return;
  }
  const f = path.join(DIST, u.pathname === "/" ? "index.html" : u.pathname);
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const context = await browser.newContext({ viewport: { width: 1000, height: 760 } });

let failures = 0, passes = 0;
function check(ok, what, detail) {
  if (ok) {
    passes++;
    console.log("  ok   " + what);
  } else {
    failures++;
    console.log("  FAIL " + what + (detail !== undefined ? " — " + JSON.stringify(detail) : ""));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(page, q) {
  await page.goto(`${ORIGIN}/host.html?${q}`);
  const frame = page.frame({ url: /index\.html/ });
  await frame.waitForFunction(() => window.Tegaki && Tegaki.layers && Tegaki.layers.length > 0 && document.getElementById("tegaki-finish-btn"));
  await sleep(150);
  return frame;
}
function state(frame) {
  return frame.evaluate(() => ({
    hash: TegakiDraft.hashLayers(),
    events: Tegaki.replayRecorder ? Tegaki.replayRecorder.events.length : -1,
    undo: TegakiHistory.undoStack.length,
    persists: window.parent.drawPersists,
    unchanged: window.parent.drawUnchanged,
    guard: window.parent.log.guard[window.parent.log.guard.length - 1],
    saved: window.parent.log.saved.slice(),
    saves: window.tegakiSaver ? window.tegakiSaver.saves : -1,
    taken: !!document.getElementById("tegaki-2draw-taken"),
  }));
}
function ink(frame) {
  return frame.evaluate(() => {
    let n = 0;
    for (const l of Tegaki.layers) { const d = l.imageData.data; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; }
    return n;
  });
}
async function canvasBox(page, frame) {
  const el = await frame.evaluateHandle(() => Tegaki.layersCnt);
  return el.boundingBox();
}
async function stroke(page, frame, x0, y0, x1, y1, steps = 12, up = true) {
  const b = await canvasBox(page, frame);
  await page.mouse.move(b.x + x0, b.y + y0);
  await page.mouse.down();
  await page.mouse.move(b.x + x1, b.y + y1, { steps });
  if (up) await page.mouse.up();
}
async function waitSaved(frame, n) {
  await frame.waitForFunction((n) => window.tegakiSaver && window.tegakiSaver.saves >= n && !window.tegakiSaver.saving && !window.tegakiSaver.dirty, n, { timeout: 15000 });
}
function meta(frame, key) {
  return frame.evaluate((key) => TegakiDraft.loadDraft(key).then((d) => d && { ...d.meta, head: undefined, tail: d.meta.tail ? d.meta.tail.length : 0, parts: [...d.parts.keys()] }), key);
}
async function hide(frame) {
  await frame.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

const W = 300, H = 200;
const q = (key, more = "") => `w=${W}&h=${H}&draft=${key}${more}`;

// --- 1. save and restore ------------------------------------------------------
console.log("save after a stroke, restore on reload");
{
  const page = await context.newPage();
  let f = await open(page, q("aaaa1111"));
  let s = await state(f);
  check(s.unchanged === true && s.persists === false && s.guard === false, "fresh: nothing to lose, no leave question", s);
  await stroke(page, f, 30, 30, 200, 120);
  s = await state(f);
  check(s.guard === true && s.unchanged === false, "after a stroke: leave question on until saved", s);
  await waitSaved(f, 1);
  s = await state(f);
  check(s.guard === false && s.persists === true, "saved: Close asks nothing, no leave question", s);
  check(s.saved.length > 0 && s.saved[s.saved.length - 1].at > 0, "the bar heard 'Saved'", s.saved);
  await stroke(page, f, 40, 150, 250, 40);
  await waitSaved(f, 2);
  const before = await state(f);
  const flushed = await f.evaluate(() => window.parent.drawFlush().then(() => true));
  check(flushed, "drawFlush resolves");
  f = await open(page, q("aaaa1111"));
  const after = await state(f);
  check(after.hash === before.hash && after.hash !== null, "reload restores the same layers", [before.hash, after.hash]);
  check((await ink(f)) > 100, "and they have the strokes in them", await ink(f));
  check(after.events === before.events, "the recording carries on from the copy", [before.events, after.events]);
  check(after.undo === 2, "undo history comes back", after.undo);
  check(after.persists === true && after.guard === false, "restored: persists, no leave question", after);
  check(after.saved.length === 1 && after.saved[0].at > 0, "the bar shows the copy's save time", after.saved);
  await f.evaluate(() => TegakiHistory.undo());
  await waitSaved(f, 1);
  f = await open(page, q("aaaa1111"));
  check((await state(f)).undo === 1, "an undo is kept too");

  // --- submit -----------------------------------------------------------------
  console.log("submit");
  await f.evaluate(() => document.getElementById("tegaki-finish-btn").click());
  await page.waitForFunction(() => log.submits.length === 1);
  await sleep(300);
  check((await meta(f, "aaaa1111")) === null, "the copy is deleted once the host has the drawing");
  const anim = await page.evaluate(() => Array.from(window.lastAnim));
  extra.set("/anim.tgkr", { type: "application/octet-stream", body: Buffer.from(anim) });
  await page.close();
}

// --- 2. mid-stroke hide ---------------------------------------------------------
console.log("hidden mid-stroke");
{
  const page = await context.newPage();
  let f = await open(page, q("bbbb2222"));
  await stroke(page, f, 20, 20, 120, 60);
  await waitSaved(f, 1);
  const one = await state(f);
  await stroke(page, f, 200, 30, 260, 180, 10, false); // pen still down
  const live = await f.evaluate(() => { Tegaki.isPainting = false; const h = TegakiDraft.hashLayers(); Tegaki.isPainting = true; return h; });
  await hide(f);
  await waitSaved(f, 2);
  const m = await meta(f, "bbbb2222");
  check(m && m.openStroke === true && m.hash === null, "saved with the stroke under way", m && { open: m.openStroke, hash: m.hash });
  await page.mouse.up();
  await page.close();
  const page2 = await context.newPage();
  f = await open(page2, q("bbbb2222"));
  const s = await state(f);
  check(s.hash !== one.hash && s.hash === live, "reload has the half stroke, as it was", [one.hash, live, s.hash]);
  check(s.undo === 2, "the half stroke is a step of its own", s.undo);
  await page2.close();
}

// --- 3. failing store -------------------------------------------------------------
console.log("a failing store");
{
  const page = await context.newPage();
  const f = await open(page, q("cccc3333"));
  await f.evaluate(() => {
    window.__put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () {
      throw new DOMException("full", "QuotaExceededError");
    };
  });
  await stroke(page, f, 30, 30, 200, 120);
  await f.waitForFunction(() => window.tegakiSaver.failed, null, { timeout: 8000 });
  let s = await state(f);
  check(s.saved.some((i) => i.failed), "the bar heard 'Not saved'", s.saved);
  check(s.guard === true && s.persists === false, "the leave question stays on; Close asks", s);
  await f.evaluate(() => { IDBObjectStore.prototype.put = window.__put; });
  await f.waitForFunction(() => !window.tegakiSaver.failed && window.tegakiSaver.saves >= 1, null, { timeout: 12000 });
  s = await state(f);
  check(s.guard === false && s.persists === true && s.saved[s.saved.length - 1].at > 0, "retried: saved again", s);
  await page.close();
}

// --- 4. two tabs ---------------------------------------------------------------------
console.log("two tabs");
{
  const a = await context.newPage();
  const fa = await open(a, q("dddd4444"));
  await stroke(a, fa, 30, 30, 200, 120);
  await sleep(200); // not saved yet: the hand-off saves it
  const sa = await state(fa);
  const b = await context.newPage();
  const fb = await open(b, q("dddd4444"));
  const sb = await state(fb);
  check(sb.hash === sa.hash, "the new tab opens with everything the old one drew", [sa.hash, sb.hash]);
  const sa2 = await state(fa);
  check(sa2.taken === true, "the old tab says the drawing is open in another tab");
  check(sa2.guard === false && sa2.persists === true, "the old tab doesn't ask on leaving", sa2);
  await stroke(b, fb, 40, 150, 250, 40);
  await waitSaved(fb, 1);
  await fa.evaluate(() => document.querySelector("#tegaki-2draw-taken button").click());
  await a.waitForTimeout(300);
  const fa2 = a.frame({ url: /index\.html/ });
  await fa2.waitForFunction(() => window.Tegaki && Tegaki.layers && Tegaki.layers.length && window.tegakiSaver, null, { timeout: 15000 });
  await sleep(300);
  const back = await state(fa2);
  const sb2 = await state(fb);
  const bHash = await fb.evaluate(() => TegakiDraft.hashLayers());
  check(back.hash === bHash && back.events > sa.events, "Continue here takes it back with the other tab's strokes", [back.hash, bHash, back.events, sa.events]);
  check(sb2.taken === true, "and the other tab is covered now");
  await a.close();
  await b.close();
}

// --- 5. a long drawing: sealed chunks ------------------------------------------------
console.log("a long drawing");
{
  const page = await context.newPage();
  let f = await open(page, q("eeee5555"));
  for (let i = 0; i < 6; i++) await stroke(page, f, 10 + i * 10, 10, 280 - i * 10, 190, 500);
  await waitSaved(f, 1);
  const m = await meta(f, "eeee5555");
  check(m.chunks.length >= 1, "sealed chunks", m.chunks.length);
  await stroke(page, f, 10, 100, 290, 100, 30);
  await waitSaved(f, 2);
  const before = await state(f);
  const m2 = await meta(f, "eeee5555");
  check(m2.chunks.length === m.chunks.length && m2.parts.length === m2.chunks.length, "chunks are not rewritten; no stray parts", [m.chunks.length, m2.chunks.length, m2.parts.length]);
  const stats = await f.evaluate(() => window.tegakiSaver.lastStats);
  console.log("       " + JSON.stringify(stats));
  f = await open(page, q("eeee5555"));
  const after = await state(f);
  check(after.hash === before.hash && after.events === before.events, "restores a long drawing", [before, after].map((s) => [s.hash, s.events]));
  await stroke(page, f, 10, 50, 290, 50, 30);
  await waitSaved(f, 1);
  const m3 = await meta(f, "eeee5555");
  check(m3.parts.every((n) => n.startsWith(m3.session)), "a restored session rewrites the copy under its own parts, the old ones go", m3.parts);
  await page.close();
}

// --- 6. revision with a recording ------------------------------------------------------
console.log("a revision (anim=)");
{
  const page = await context.newPage();
  let f = await open(page, q("ffff6666", "&anim=" + encodeURIComponent(ORIGIN + "/anim.tgkr")));
  const start = await state(f);
  await stroke(page, f, 50, 50, 150, 150);
  await waitSaved(f, 1);
  const before = await state(f);
  f = await open(page, q("ffff6666", "&anim=" + encodeURIComponent(ORIGIN + "/anim.tgkr")));
  const after = await state(f);
  check(after.hash === before.hash && after.events === before.events && after.events > start.events, "continues the posted recording and the copy", [start.events, before.events, after.events]);
  await page.close();
}

// --- 7. picture-only revision ------------------------------------------------------------
console.log("a picture-only revision (load=)");
{
  // a red picture
  const page = await context.newPage();
  await page.goto(ORIGIN + "/LICENSE.txt");
  const png = await page.evaluate(([w, h]) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "#f00";
    g.fillRect(0, 0, w, h);
    return c.toDataURL("image/png").split(",")[1];
  }, [W, H]);
  extra.set("/pic.png", { type: "image/png", body: Buffer.from(png, "base64") });

  let f = await open(page, q("gggg7777", "&load=" + encodeURIComponent(ORIGIN + "/pic.png")));
  await sleep(500);
  await stroke(page, f, 50, 50, 150, 150);
  await waitSaved(f, 1);
  const m = await meta(f, "gggg7777");
  check(m && m.mode === "picture", "not recorded: the copy is the picture", m && m.mode);
  const before = await f.evaluate(() => { const c = Tegaki.flatten(); return c.getContext("2d").getImageData(100, 100, 1, 1).data.join(","); });
  extra.set("/pic.png", { type: "image/png", body: Buffer.from(png, "base64") });
  f = await open(page, q("gggg7777", "&load=" + encodeURIComponent(ORIGIN + "/pic.png")));
  await sleep(300);
  const after = await f.evaluate(() => { const c = Tegaki.flatten(); return c.getContext("2d").getImageData(100, 100, 1, 1).data.join(","); });
  check(after === before && before !== "255,0,0,255", "reload brings back the picture with the stroke", [before, after]);
  await page.close();
}

// --- 8. unreadable, expiry ------------------------------------------------------------------
console.log("a copy that can't be read; expiry");
{
  const page = await context.newPage();
  let f = await open(page, q("hhhh8888"));
  await stroke(page, f, 30, 30, 200, 120);
  await waitSaved(f, 1);
  await f.evaluate(() => TegakiDraft.loadDraft("hhhh8888").then((d) => {
    d.meta.chunks = [{ name: "missing", count: 10 }];
    return new Promise((r) => {
      const o = indexedDB.open(TegakiDraft.DB_NAME);
      o.onsuccess = () => { const tx = o.result.transaction("drafts", "readwrite"); tx.objectStore("drafts").put(d.meta); tx.oncomplete = r; };
    });
  }));
  f = await open(page, q("hhhh8888"));
  const s = await state(f);
  check(s.events <= 2 && s.undo === 0, "starts over", s);
  const keys = await f.evaluate(() => new Promise((r) => {
    const o = indexedDB.open(TegakiDraft.DB_NAME);
    o.onsuccess = () => { const q = o.result.transaction("drafts").objectStore("drafts").getAllKeys(); q.onsuccess = () => r(q.result); };
  }));
  check(keys.some((k) => k.startsWith("hhhh8888~unreadable-")), "the copy is set aside, not overwritten", keys);
  const reports = await f.evaluate(() => (window.__reports || []).slice());
  check(reports.some((m) => /set aside/.test(m)), "and reported", reports);
  // expiry
  await f.evaluate(() => TegakiDraft.loadDraft("aaaa1111").then(() => new Promise((r) => {
    const o = indexedDB.open(TegakiDraft.DB_NAME);
    o.onsuccess = () => {
      const tx = o.result.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put({ key: "old11111", v: 1, saved: Date.now() - 31 * 86400000, mode: "picture" });
      tx.objectStore("drafts").put({ key: "aside111~unreadable-1", v: 1, saved: Date.now() - 40 * 86400000, aside_at: Date.now() - 86400000, mode: "picture" });
      tx.oncomplete = r;
    };
  })));
  await f.evaluate(() => TegakiDraft.expireDrafts());
  const keys2 = await f.evaluate(() => new Promise((r) => {
    const o = indexedDB.open(TegakiDraft.DB_NAME);
    o.onsuccess = () => { const q = o.result.transaction("drafts").objectStore("drafts").getAllKeys(); q.onsuccess = () => r(q.result); };
  }));
  check(!keys2.includes("old11111"), "a copy not saved for 30 days goes");
  check(keys2.includes("aside111~unreadable-1"), "a copy set aside yesterday stays (30 days from being set aside)");
  await page.close();
}

// --- 9. no draft key: unchanged ------------------------------------------------------------
console.log("without a draft key");
{
  const page = await context.newPage();
  const f = await open(page, `w=${W}&h=${H}`);
  await stroke(page, f, 30, 30, 200, 120);
  await sleep(2200);
  const s = await f.evaluate(() => ({ saver: !!window.tegakiSaver, guard: window.parent.log.guard.length }));
  check(!s.saver && s.guard === 0, "no copy, the page's own warning stays as it was", s);
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
