import { describe, expect, it, vi } from "vitest";

import { createWorker } from "../src/worker";

describe("Worker HTTP boundary", () => {
  it("forwards /mcp requests without requiring bearer auth", async () => {
    const mcpHandler = vi.fn(() => new Response("ok", { status: 200 }));
    const worker = createWorker(mcpHandler);

    const response = await worker.fetch(
      new Request("https://worker.example/mcp", { method: "POST" }),
      {},
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(mcpHandler).toHaveBeenCalledOnce();
  });

  it("returns 404 outside the MCP endpoint without invoking MCP", async () => {
    const mcpHandler = vi.fn(() => new Response("unexpected"));
    const worker = createWorker(mcpHandler);

    const response = await worker.fetch(
      new Request("https://worker.example/other"),
      {},
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mcpHandler).not.toHaveBeenCalled();
  });
});
