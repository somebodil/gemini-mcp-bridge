import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exposeTools, noSuchTool } from "./tools.ts";

const servers = [
  { id: "a", name: "local", tools: [{ name: "read_file" }, { name: "run_command" }] },
  { id: "b", name: "other", tools: [{ name: "read_file" }, { name: "search" }] },
];

describe("exposeTools", () => {
  it("prefixes a name only when two servers share it", () => {
    const { visible } = exposeTools(servers, {});
    assert.deepEqual(
      visible.map((t) => [t.name, t.original, t.serverId]),
      [
        ["local__read_file", "read_file", "a"],
        ["run_command", "run_command", "a"],
        ["other__read_file", "read_file", "b"],
        ["search", "search", "b"],
      ],
    );
  });

  it("asks by default, runs auto ones, hides off ones", () => {
    const { visible, hidden } = exposeTools(servers, { run_command: "auto", search: "off" });
    assert.deepEqual(
      visible.map((t) => [t.name, t.policy]),
      [
        ["local__read_file", "ask"],
        ["run_command", "auto"],
        ["other__read_file", "ask"],
      ],
    );
    assert.deepEqual(
      hidden.map((t) => t.name),
      ["search"],
    );
  });

  it("says which tools there are when one is missing", () => {
    assert.equal(noSuchTool("x", ["a", "b"]), 'There is no tool named "x". Available tools: a, b.');
    assert.equal(noSuchTool("x", []), 'There is no tool named "x". Available tools: none.');
  });
});
