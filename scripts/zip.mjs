// Packs dist/extension into gemini-mcp-bridge-extension-<version>.zip (manifest.json at the root of the zip).

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const zip = resolve(`gemini-mcp-bridge-extension-${version}.zip`);
rmSync(zip, { force: true });
execFileSync("zip", ["-r", "-X", "-q", zip, "."], { cwd: "dist/extension", stdio: "inherit" });
console.log(zip);
