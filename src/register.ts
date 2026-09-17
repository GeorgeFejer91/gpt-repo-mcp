import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { toolRegistry } from "./tools/registry.js";
import { registerCatalogTool } from "./tools/define-tool.js";
import { registerGitHubTools } from "./github-bridge.js";
import type { RuntimeContext } from "./runtime/context.js";

export { SERVER_INSTRUCTIONS };

const READ_ONLY_SURFACE_ENV = "GPT_REPO_READ_ONLY_SURFACE";

export function createMcpServer(context: RuntimeContext): McpServer {
  const server = new McpServer(
    {
      name: "gpt-repo-mcp",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      },
      instructions: SERVER_INSTRUCTIONS
    }
  );

  const readOnlySurface = process.env[READ_ONLY_SURFACE_ENV] === "1";
  const tools = readOnlySurface
    ? toolRegistry.filter((tool) => tool.annotations.readOnlyHint === true)
    : toolRegistry;

  for (const tool of tools) {
    registerCatalogTool(server, context, tool);
  }

  // Registered separately from the catalogue on purpose: these tools do not
  // touch the repository themselves. They ask the Secret Tunnel desktop app to,
  // and only after the user has approved the change there. They are registered
  // at all only when that app has started its loopback broker.
  registerGitHubTools(server, readOnlySurface);

  return server;
}
