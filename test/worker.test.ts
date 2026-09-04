import { describe, expect, it, vi } from "vitest";

import { createWorker } from "../src/worker";

describe("Worker HTTP boundary", () => {
  it("rejects an unauthenticated /mcp request before invoking MCP", async () => {
    const mcpHandler = vi.fn(() => new Response("unexpected"));
    const worker = createWorker(mcpHandler);

    const response = await worker.fetch(
      new Request("https://worker.example/mcp", { method: "POST" }),
      { MCP_BEARER_TOKEN: "secret" },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mcpHandler).not.toHaveBeenCalled();
  });

  it("fails closed when the Bearer token secret is not configured", async () => {
    const mcpHandler = vi.fn(() => new Response("unexpected"));
    const worker = createWorker(mcpHandler);

    const response = await worker.fetch(
      new Request("https://worker.example/mcp", {
        headers: { authorization: "Bearer undefined" },
      }),
      { MCP_BEARER_TOKEN: "" },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(500);
    expect(mcpHandler).not.toHaveBeenCalled();
  });
});
