// Builds the extension into dist/extension: load that folder with "Load unpacked", or zip it (npm run zip).
// The version is package.json's: it is written into the manifest here, and the code imports it.

import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const out = "dist/extension";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync("static", out, { recursive: true });
const manifest = JSON.parse(readFileSync("static/manifest.json", "utf8"));
writeFileSync(`${out}/manifest.json`, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);

const common = { bundle: true, target: "chrome120", logLevel: "warning", legalComments: "none" };
await build({ ...common, entryPoints: ["src/background/index.ts"], outfile: `${out}/background.js`, format: "esm" });
await build({ ...common, entryPoints: ["src/content/index.ts"], outfile: `${out}/content.js`, format: "iife" });
await build({ ...common, entryPoints: ["src/options/options.ts"], outfile: `${out}/options.js`, format: "iife" });
console.log(`built ${version}: ${out}`);
