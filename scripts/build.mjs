// Builds the extension into dist/extension: load that folder with "Load unpacked", or zip it (npm run zip).
// The version is package.json's: it is written into the manifest here, and the code imports it.
// With --test: dist/extension-test, which may also go into any page without a click on its icon (the end-to-end
// tests turn tabs on from the service worker; they cannot click Chrome's toolbar). Never for release.

import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const test = process.argv.includes("--test");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const out = test ? "dist/extension-test" : "dist/extension";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync("static", out, { recursive: true });
const manifest = JSON.parse(readFileSync("static/manifest.json", "utf8"));
if (test) manifest.host_permissions = [...manifest.host_permissions, "<all_urls>"];
writeFileSync(`${out}/manifest.json`, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);

// __GMB_TEST__: the tests' build keeps the extension's shadow roots open (the tests read the cards and the status
// button), and lets the tests turn tabs on
const common = { bundle: true, target: "chrome120", logLevel: "warning", legalComments: "none", define: { __GMB_TEST__: String(test) } };
await build({ ...common, entryPoints: ["src/background/index.ts"], outfile: `${out}/background.js`, format: "esm" });
await build({ ...common, entryPoints: ["src/content/index.ts"], outfile: `${out}/content.js`, format: "iife" });
await build({ ...common, entryPoints: ["src/options/options.ts"], outfile: `${out}/options.js`, format: "iife" });
console.log(`built ${version}: ${out}`);
