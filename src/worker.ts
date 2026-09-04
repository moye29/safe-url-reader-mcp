export interface Env {}

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

      return mcpHandler(request, env, ctx);
    },
  };
}
