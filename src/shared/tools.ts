// Which tools Gemini sees, under which names, and how each may run.

import type { ExposedTool, Policy } from "./config.ts";
import type { ToolInfo } from "./protocol.ts";

export interface ServerTools {
  id: string;
  name: string;
  tools: ToolInfo[];
}

/**
 * Tool names as Gemini sees them: the server's own name, with the server's name in front only when two servers
 * share it. A tool without a policy is asked about; "off" ones are not shown to Gemini.
 */
export function exposeTools(servers: ServerTools[], policies: Record<string, Policy>): { visible: ExposedTool[]; hidden: ExposedTool[] } {
  const count = new Map<string, number>();
  for (const s of servers) for (const t of s.tools) count.set(t.name, (count.get(t.name) ?? 0) + 1);
  const visible: ExposedTool[] = [];
  const hidden: ExposedTool[] = [];
  for (const s of servers) {
    for (const t of s.tools) {
      const name = (count.get(t.name) ?? 0) > 1 ? `${s.name}__${t.name}` : t.name;
      const tool: ExposedTool = { ...t, name, original: t.name, serverId: s.id, policy: policies[name] ?? "ask" };
      (tool.policy === "off" ? hidden : visible).push(tool);
    }
  }
  return { visible, hidden };
}

/** The message for a tool Gemini named that does not exist. */
export function noSuchTool(name: string, available: string[]): string {
  return `There is no tool named "${name}". Available tools: ${available.join(", ") || "none"}.`;
}
