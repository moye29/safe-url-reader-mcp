import { describe, expect, it } from "vitest";

import { readUrlWithJina } from "../src/jina";
import type { Fetcher } from "../src/generic";

describe("explicit Jina Reader fallback", () => {
  it("reads a normal non-XHS URL through Jina", async () => {
    let requested = "";
    const fetcher: Fetcher = async (input, init) => {
      requested = String(input);
      expect(init?.headers).toMatchObject({
        accept: "application/json",
        DNT: "1",
        "X-Timeout": "20",
      });
      return new Response(
        JSON.stringify({
          data: {
            url: "https://example.com/article",
            title: "Example",
            content: "Readable content",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const result = await readUrlWithJina("https://example.com/article", 20_000, fetcher);
    expect(requested).toBe("https://r.jina.ai/https://example.com/article");
    expect(result).toMatchObject({
      finalUrl: "https://example.com/article",
      title: "Example",
      content: "Readable content",
      source: "jina",
      truncated: false,
    });
  });

  it.each([
    "https://xiaohongshu.com/explore/abc",
    "https://www.xiaohongshu.com/explore/abc",
    "https://foo.xiaohongshu.com/explore/abc",
    "https://xhslink.com/a",
    "https://foo.xhslink.com/a",
  ])("hard-blocks Xiaohongshu target %s before contacting Jina", async (url) => {
    let called = false;
    const fetcher: Fetcher = async () => {
      called = true;
      return new Response("unexpected");
    };

    await expect(readUrlWithJina(url, 20_000, fetcher)).rejects.toThrow("禁止通过 Jina");
    expect(called).toBe(false);
  });

  it("truncates returned content to the requested limit", async () => {
    const fetcher: Fetcher = async () =>
      new Response(
        JSON.stringify({
          data: {
            url: "https://example.com",
            title: "Example",
            content: "x".repeat(2_000),
          },
        }),
        { status: 200 },
      );

    const result = await readUrlWithJina("https://example.com", 1_000, fetcher);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain("[内容已截断]");
  });
});
