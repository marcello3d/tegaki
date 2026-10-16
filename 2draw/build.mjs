#!/usr/bin/env node
// Builds the 2draw distribution of tegaki.js into dist-2draw/ (no Ruby needed).
//
//   node 2draw/build.mjs
//
// tegaki.js is concatenated in the Rakefile's order (strings, tools, js/*.js
// sorted, UZIP), then the 2draw glue and player are copied next to it. Every
// file is same-origin: the icon font is a data: URI inside tegaki.css.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist-2draw");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const TOOLS = ["tool", "brush", "pencil", "airbrush", "pen", "bucket", "tone", "pipette", "blur", "eraser"];

let src = "/*! tegaki.js, MIT License */'use strict';";
src += read("js/strings/en.js");
for (const t of TOOLS) src += read(`js/tools/${t}.js`);
for (const f of readdirSync(join(ROOT, "js")).filter((f) => f.endsWith(".js")).sort()) src += read(`js/${f}`);
src += read("lib/UZIP/UZIP.js");

let commit = "unknown";
let upstream = "unknown";
try {
  commit = execSync("git rev-parse --short=8 HEAD", { cwd: ROOT }).toString().trim();
  upstream = execSync("git rev-parse --short=8 upstream/master 2>/dev/null || git rev-parse --short=8 origin/master", { cwd: ROOT, shell: "/bin/sh" }).toString().trim();
  if (execSync("git status --porcelain -- js css lib 2draw", { cwd: ROOT }).toString().trim()) commit += "-dirty";
} catch {}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "tegaki.js"), src);
copyFileSync(join(ROOT, "css/tegaki.css"), join(OUT, "tegaki.css"));
for (const f of ["tegaki-2draw.js", "tegaki-2draw.css", "player.js", "README.md"])
  copyFileSync(join(ROOT, "2draw", f), join(OUT, f));
// The pages name their scripts with ?v=<build>, so a new build is never mixed
// with a cached old one.
for (const f of ["index.html", "replay.html"])
  writeFileSync(join(OUT, f), read(`2draw/${f}`).replaceAll("__BUILD__", commit.replace(/-dirty$/, "")));
copyFileSync(join(ROOT, "LICENSE"), join(OUT, "LICENSE.txt"));
writeFileSync(
  join(OUT, "THIRD-PARTY.txt"),
  "tegaki.js bundles UZIP.js:\n\n" + read("lib/UZIP/LICENSE") + "\n\ntegaki.css embeds icons from:\n\n" + read("fonts/LICENSE.txt"),
);
writeFileSync(
  join(OUT, "VERSION"),
  `${commit}\nupstream https://github.com/desuwa/tegaki ${upstream} (0.9.4)\npatches ~/github/tegaki branch 2draw ${commit}\n`,
);
console.log(`dist-2draw/ written (tegaki ${commit})`);
