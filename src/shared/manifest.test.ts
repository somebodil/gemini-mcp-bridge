// The extension asks for as little as it can: no site until the user turns it on in a tab (activeTab), and of
// the rest only the MCP servers on the user's own computer.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "static", "manifest.json"), "utf8")) as Record<string, unknown>;

describe("manifest", () => {
  it("goes into no page by itself", () => {
    assert.equal(manifest.content_scripts, undefined);
    assert.deepEqual(manifest.permissions, ["storage", "activeTab", "scripting"]);
  });

  it("reaches only 127.0.0.1 and localhost", () => {
    assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*", "http://localhost/*"]);
  });
});
