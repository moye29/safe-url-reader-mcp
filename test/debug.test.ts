import { describe, expect, it } from "vitest";

import { debugUrlConnection } from "../src/debug";
import type { Fetcher } from "../src/generic";

describe("debug_url connection diagnostics", () => {
  it("returns response metadata without consuming the final body", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("body should not be read"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher: Fetcher = async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/html" },
      });

    const result = await debugUrlConnection("https://example.com", fetcher);
    expect(result.outcome).toBe("response_received");
    expect(result.hops).toHaveLength(1);
    expect(result.hops[0]?.status).toBe(200);
    expect(cancelled).toBe(true);
  });

  it("records redirect hops and follows each hop once", async () => {
    const requested: string[] = [];
    const fetcher: Fetcher = async (input) => {
      const url = input.toString();
      requested.push(url);
      if (requested.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.org/final" },
        });
      }
      return new Response(null, {
        status: 204,
        headers: { "content-type": "text/plain" },
      });
    };

    const result = await debugUrlConnection("https://example.com/start", fetcher);
    expect(result.outcome).toBe("response_received");
    expect(requested).toEqual([
      "https://example.com/start",
      "https://example.org/final",
    ]);
  });

  it("blocks unsafe redirect destinations before requesting them", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      });
    };

    await expect(debugUrlConnection("https://example.com", fetcher)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("marks Xiaohongshu diagnostics as no-retry, no-alternate-UA/protocol", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      throw new Error("timeout");
    };

    const result = await debugUrlConnection(
      "https://www.xiaohongshu.com/explore/test",
      fetcher,
    );

    expect(result.isXhs).toBe(true);
    expect(result.outcome).toBe("timeout_or_network_error");
    expect(calls).toBe(1);
    expect(result.requestPolicy).toContain("no retries");
    expect(result.requestPolicy).toContain("no alternate UA/protocol");
  });
});
