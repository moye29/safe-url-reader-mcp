import { describe, expect, it } from "vitest";

import worker from "../src/index";

describe("Streamable HTTP MCP endpoint", () => {
  it("answers an initialize request at /mcp with the current server name", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
          },
        }),
      }),
      {},
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("safe-url-reader-mcp");
  });

  it("advertises the unified reader plus compatibility and debug tools", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      }),
      {},
      {} as ExecutionContext,
    );
    const responseText = await response.text();
    const dataLine = responseText
      .split("\n")
      .find((line) => line.startsWith("data: "));
    expect(dataLine).toBeDefined();
    const body = JSON.parse(dataLine?.slice(6) ?? "") as {
      result: {
        tools: Array<{
          name: string;
          annotations: { readOnlyHint: boolean; destructiveHint: boolean };
          inputSchema: { properties?: Record<string, { default?: number; maximum?: number }> };
        }>;
      };
    };

    expect(body).toHaveProperty("result");
    const names = body.result.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "debug_url",
      "debug_xhs_note",
      "read_url",
      "read_xhs_note",
    ]);

    for (const tool of body.result.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
    }

    const readUrl = body.result.tools.find((tool) => tool.name === "read_url");
    expect(readUrl?.inputSchema.properties?.comments).toMatchObject({
      default: 0,
      maximum: 5,
    });
    expect(readUrl?.inputSchema.properties?.max_chars).toMatchObject({
      default: 20000,
      maximum: 50000,
    });
  });
});
