import { describe, expect, it } from "vitest";

import { isXhsUrl, readGenericUrl, type Fetcher } from "../src/generic";

describe("generic URL reader", () => {
  it("detects Xiaohongshu hosts", () => {
    expect(isXhsUrl("https://www.xiaohongshu.com/explore/abc")).toBe(true);
    expect(isXhsUrl("https://xhslink.com/a")).toBe(true);
    expect(isXhsUrl("https://example.com")).toBe(false);
  });

  it("reads a normal HTML page", async () => {
    const fetcher: Fetcher = async () =>
      new Response("<html><head><title>Example</title></head><body><main><h1>Hello</h1><p>World</p></main></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });

    const result = await readGenericUrl("https://example.com", 20_000, fetcher);
    expect(result.title).toBe("Example");
    expect(result.content).toContain("Hello");
    expect(result.content).toContain("World");
    expect(result.truncated).toBe(false);
  });

  it.each([
    "http://localhost/",
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/",
    "http://[::1]/",
  ])("blocks SSRF target %s before fetch", async (url) => {
    let called = false;
    const fetcher: Fetcher = async () => {
      called = true;
      return new Response("ok");
    };

    await expect(readGenericUrl(url, 20_000, fetcher)).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("revalidates redirect destinations and blocks private IP redirects", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/admin" },
      });
    };

    await expect(readGenericUrl("https://example.com", 20_000, fetcher)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("rejects declared bodies larger than 5 MB", async () => {
    const fetcher: Fetcher = async () =>
      new Response("small", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": String(5 * 1024 * 1024 + 1),
        },
      });

    await expect(readGenericUrl("https://example.com", 20_000, fetcher)).rejects.toThrow("5 MB");
  });

  it("rejects unsupported content types", async () => {
    const fetcher: Fetcher = async () =>
      new Response("%PDF", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });

    await expect(readGenericUrl("https://example.com/file.pdf", 20_000, fetcher)).rejects.toThrow("暂不读取此内容类型");
  });
});
