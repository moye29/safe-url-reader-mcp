import { describe, expect, it } from "vitest";

import worker from "../src/index";

describe("Streamable HTTP MCP endpoint", () => {
  it("answers an authenticated initialize request at /mcp", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
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
      { MCP_BEARER_TOKEN: "secret" },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("xhs-read-mcp");
  });

  it("advertises only the read_xhs_note tool with comments capped at 5", async () => {
    const response = await worker.fetch(
      new Request("https://worker.example/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
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
      { MCP_BEARER_TOKEN: "secret" },
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
          inputSchema: { properties: { comments: { default: number; maximum: number } } };
        }>;
      };
    };

    expect(body).toHaveProperty("result");
    expect(body.result.tools).toHaveLength(1);
    expect(body.result.tools[0]?.name).toBe("read_xhs_note");
    expect(body.result.tools[0]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(body.result.tools[0]?.inputSchema.properties.comments).toMatchObject({
      default: 0,
      maximum: 5,
    });
  });
});
