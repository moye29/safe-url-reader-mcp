export interface Env {
  MCP_BEARER_TOKEN: string;
}

export type McpHandler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

export interface WorkerApp {
  fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Response | Promise<Response>;
}

export function createWorker(mcpHandler: McpHandler): WorkerApp {
  return {
    fetch(request, env, ctx) {
      const url = new URL(request.url);

      if (url.pathname !== "/mcp") {
        return Response.json({ error: "Not found" }, { status: 404 });
      }

      if (!env.MCP_BEARER_TOKEN) {
        return Response.json(
          { error: "Server authentication is not configured" },
          { status: 500 },
        );
      }

      if (request.headers.get("authorization") !== `Bearer ${env.MCP_BEARER_TOKEN}`) {
        return Response.json(
          { error: "Unauthorized" },
          {
            status: 401,
            headers: { "www-authenticate": "Bearer" },
          },
        );
      }

      return mcpHandler(request, env, ctx);
    },
  };
}
