// Builds the extension into dist/extension: load that folder with "Load unpacked", or zip it (npm run zip).

import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("static/manifest.json", "utf8")).version;
if (manifest !== version) throw new Error(`static/manifest.json has version ${manifest}, package.json ${version}`);
const client = readFileSync("src/background/mcp-client.ts", "utf8").match(/version: "([^"]+)"/)?.[1];
if (client !== version) throw new Error(`src/background/mcp-client.ts has version ${client}, package.json ${version}`);

const out = "dist/extension";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync("static", out, { recursive: true });

const common = { bundle: true, target: "chrome120", logLevel: "warning", legalComments: "none" };
await build({ ...common, entryPoints: ["src/background/index.ts"], outfile: `${out}/background.js`, format: "esm" });
await build({ ...common, entryPoints: ["src/content/index.ts"], outfile: `${out}/content.js`, format: "iife" });
await build({ ...common, entryPoints: ["src/options/options.ts"], outfile: `${out}/options.js`, format: "iife" });
await build({ ...common, entryPoints: ["src/popup/popup.ts"], outfile: `${out}/popup.js`, format: "iife" });
console.log(`built ${version}: ${out}`);
