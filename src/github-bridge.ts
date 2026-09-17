import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * GitHub tools, exposed only when Secret Tunnel has started its local broker.
 *
 * These are a deliberately compact surface over the desktop coordinator rather
 * than a Git command runner. Three properties are worth stating plainly,
 * because they are what makes the surface safe to expose to a model:
 *
 * 1. There is no `github_approve`. Approval happens in the Secret Tunnel window
 *    and nowhere else. A model can describe a change and ask for it, but it
 *    cannot authorise one, and no argument to these tools substitutes for that.
 * 2. Nothing here runs a command. Each tool posts JSON to a loopback broker that
 *    accepts a fixed set of typed requests; there is no field that becomes part
 *    of a command line.
 * 3. The broker address and token arrive through this process's environment. If
 *    they are absent the tools are not registered at all, so a build without the
 *    feature wired advertises nothing.
 */

const BROKER_URL_ENV = "SECRET_TUNNEL_BROKER_URL";
const BROKER_TOKEN_ENV = "SECRET_TUNNEL_BROKER_TOKEN";

/** Bound so a wedged desktop cannot hang a ChatGPT turn indefinitely. */
const BROKER_TIMEOUT_MS = 30_000;

interface BrokerError {
  code?: string;
  message?: string;
}

async function callBroker(route: string, body: unknown): Promise<unknown> {
  const base = process.env[BROKER_URL_ENV];
  const token = process.env[BROKER_TOKEN_ENV];
  if (!base || !token) {
    throw new Error("Secret Tunnel's GitHub broker is not available.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BROKER_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal
    });

    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = (parsed as { error?: BrokerError }).error;
      throw new Error(error?.message ?? `Secret Tunnel refused the request (${response.status}).`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Secret Tunnel did not respond in time.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function asToolResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }]
  };
}

function asToolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }]
  };
}

/**
 * Register the GitHub tools if, and only if, the broker is configured.
 *
 * `readOnlySurface` mirrors the file tools: in read-only mode only the status
 * tool is offered, so a session told it has read-only access is not handed the
 * means to propose a commit.
 */
export function registerGitHubTools(server: McpServer, readOnlySurface: boolean): void {
  if (!process.env[BROKER_URL_ENV] || !process.env[BROKER_TOKEN_ENV]) {
    return;
  }

  server.registerTool(
    "github_status",
    {
      title: "GitHub status",
      description:
        "Report whether Secret Tunnel can perform GitHub actions for the selected folder: " +
        "whether the feature is enabled, whether the folder is a Git repository, which " +
        "repository it is bound to, and which plans are waiting for the user's approval.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    async () => {
      try {
        return asToolResult(await callBroker("/github/status", {}));
      } catch (error) {
        return asToolError(error);
      }
    }
  );

  if (readOnlySurface) {
    return;
  }

  server.registerTool(
    "github_plan",
    {
      title: "Propose a GitHub action",
      description:
        "Describe a change and ask the user to approve it. This does NOT perform the change: " +
        "it creates a plan that the user must review and approve in the Secret Tunnel window. " +
        "Pass the exact repository-relative paths to commit and a commit message. " +
        "Tell the user to approve it in Secret Tunnel, then call github_apply with the plan id.",
      inputSchema: {
        action: z
          .enum(["commit", "commit_push", "push"])
          .describe("commit applies locally; commit_push and push also publish to GitHub."),
        paths: z
          .array(z.string())
          .default([])
          .describe("Exact repository-relative paths this change should commit."),
        message: z.string().optional().describe("Commit message.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async (args) => {
      try {
        return asToolResult(await callBroker("/github/plan", args));
      } catch (error) {
        return asToolError(error);
      }
    }
  );

  server.registerTool(
    "github_apply",
    {
      title: "Apply an approved GitHub action",
      description:
        "Carry out a plan the user has already approved in the Secret Tunnel window. " +
        "Fails if the plan was not approved, has expired, or if the repository changed " +
        "since the plan was made. There is no way to approve a plan from here.",
      inputSchema: {
        planId: z.string().describe("The id returned by github_plan.")
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    async (args) => {
      try {
        return asToolResult(await callBroker("/github/apply", args));
      } catch (error) {
        return asToolError(error);
      }
    }
  );
}
