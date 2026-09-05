import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

import { debugUrlConnection } from "./debug";
import { isXhsUrl, readGenericUrl } from "./generic";
import { readUrlWithJina } from "./jina";
import { createWorker } from "./worker";
import { debugXhsNote, readXhsNote } from "./xhs";

const attachmentSchema = z.object({
  name: z.string(),
  url: z.string().url().optional(),
  id: z.string().optional(),
  docId: z.string().optional(),
  type: z.string().optional(),
  icon: z.string().url().optional(),
  pageCount: z.number().optional(),
  viewCount: z.number().optional(),
  downloadCount: z.number().optional(),
});

const noteOutputSchema = z.object({
  title: z.string(),
  content: z.string(),
  author: z.string(),
  images: z.array(z.string().url()),
  attachments: z.array(attachmentSchema),
  comments: z.array(
    z.object({
      author: z.string(),
      content: z.string(),
      likes: z.number(),
    }),
  ),
});

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

async function fetchImageBlock(url: string) {
  try {
    const response = await fetch(url, {
      headers: {
        accept: "image/*",
        referer: "https://www.xiaohongshu.com/",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    if (!mimeType.startsWith("image/")) return undefined;

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > 3_000_000) return undefined;

    return {
      type: "image" as const,
      data: arrayBufferToBase64(buffer),
      mimeType,
    };
  } catch {
    return undefined;
  }
}

async function xhsToolResult(url: string, comments: number) {
  const note = await readXhsNote(url, comments);
  const imageBlocks = (
    await Promise.all(note.images.slice(0, 9).map((imageUrl) => fetchImageBlock(imageUrl)))
  ).filter((block): block is NonNullable<typeof block> => Boolean(block));

  return {
    content: [
      { type: "text" as const, text: JSON.stringify(note, null, 2) },
      ...imageBlocks,
    ],
    structuredContent: note,
  };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "safe-url-reader-mcp",
    version: "1.5.0",
  });

  server.registerTool(
    "read_url",
    {
      title: "读取公开 URL",
      description:
        "默认用于读取用户分享/粘贴的公开 HTTP(S) URL。服务端会自动按域名分流：xiaohongshu.com / xhslink.com 永远使用专用小红书匿名 SSR 解析，不登录、不使用 Cookie、不走通用抓取；其他公网 URL 使用轻量直接 GET + 正文提取，不执行 JavaScript、不发送 Cookie/Authorization。本工具绝不会自动调用 Jina；即使普通读取失败，也只有用户明确要求使用 Jina 时才应改用 read_url_with_jina。除非用户明确要求诊断，否则普通 URL 读取优先使用本工具。",
      inputSchema: z.object({
        url: z.string().url().describe("需要读取的公开 HTTP(S) URL"),
        comments: z
          .number()
          .int()
          .min(0)
          .max(5)
          .default(0)
          .describe("仅小红书链接生效；返回公开页首屏评论数量，默认 0，最多 5"),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(50000)
          .default(20000)
          .describe("非小红书网页最多返回的正文字数，默认 20000，最大 50000"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ url, comments, max_chars }) => {
      try {
        if (isXhsUrl(url)) {
          return await xhsToolResult(url, comments);
        }

        const result = await readGenericUrl(url, max_chars);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取失败";
        return {
          isError: true,
          content: [{ type: "text" as const, text: message }],
        };
      }
    },
  );

  server.registerTool(
    "read_url_with_jina",
    {
      title: "使用 Jina Reader 读取公开 URL（仅显式调用）",
      description:
        "仅当用户明确说“使用 Jina”“用 Jina Reader / Jina MCP”或明确点名 read_url_with_jina 时才调用。不得作为 read_url 失败后的自动 fallback，也不得因为普通网页读取失败而自行调用。服务端会在请求 Jina 之前硬性拒绝 xiaohongshu.com、xhslink.com 及其所有子域名，因此小红书 URL 永远不会发送给 Jina。该工具会把目标 URL 发送给第三方 Jina Reader 服务进行抓取和正文提取；不发送用户 Cookie 或登录态。",
      inputSchema: z.object({
        url: z.string().url().describe("明确指定要通过 Jina Reader 读取的非小红书 HTTP(S) URL"),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(50000)
          .default(20000)
          .describe("最多返回的正文字数，默认 20000，最大 50000"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ url, max_chars }) => {
      try {
        const result = await readUrlWithJina(url, max_chars);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Jina Reader 读取失败";
        return {
          isError: true,
          content: [{ type: "text" as const, text: message }],
        };
      }
    },
  );

  server.registerTool(
    "debug_url",
    {
      title: "诊断 URL 连接与超时（仅开发调试）",
      description:
        "仅用于诊断网络连接、超时、HTTP 状态和重定向链。只有当用户明确要求诊断/debug，并且问题属于 timeout、403/429/5xx、重定向或页面完全拿不到时才调用。若小红书页面已经能打开但正文/图片/附件字段异常，应改用 debug_xhs_note。对 xiaohongshu.com / xhslink.com 本工具采用更保守策略：每个重定向跳转只发 1 次 GET，不自动重试，不尝试其他 UA/协议，不下载最终正文，只记录响应头和耗时，避免为了诊断增加不必要请求。普通读取不要调用本工具，应使用 read_url。",
      inputSchema: z.object({
        url: z.string().url().describe("需要诊断连接/超时问题的公开 HTTP(S) URL"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ url }) => {
      try {
        const result = await debugUrlConnection(url);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "连接诊断失败";
        return {
          isError: true,
          content: [{ type: "text" as const, text: message }],
        };
      }
    },
  );

  server.registerTool(
    "read_xhs_note",
    {
      title: "读取小红书公开笔记（兼容工具）",
      description:
        "兼容旧调用的小红书专用读取工具。普通情况下优先使用 read_url；当用户明确要求调用 read_xhs_note 时使用本工具。读取 xhslink.com / xiaohongshu.com 公开笔记，返回标题、正文、作者、图片、附件元数据和可选少量评论；只读，不登录，不使用 Cookie。",
      inputSchema: z.object({
        url: z.string().url().describe("小红书短链或普通笔记链接"),
        comments: z
          .number()
          .int()
          .min(0)
          .max(5)
          .default(0)
          .describe("返回公开页面中已有的评论数量，默认 0，最多 5"),
      }),
      outputSchema: noteOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ url, comments }) => {
      try {
        return await xhsToolResult(url, comments);
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取失败";
        return {
          isError: true,
          content: [{ type: "text" as const, text: message }],
        };
      }
    },
  );

  server.registerTool(
    "debug_xhs_note",
    {
      title: "诊断小红书页面内容结构（仅开发调试）",
      description:
        "仅用于诊断小红书页面内容结构变化，例如正文、图片、附件或 SSR 字段缺失/位置变化。只有当用户明确要求诊断/debug，且小红书页面已经能够成功连接但内容解析异常时才调用。若问题是 timeout、403/429/5xx、重定向或页面完全拿不到，应先用 debug_url。普通读取不要调用本工具，应使用 read_url。该工具会返回较多页面结构字段；只读，不登录，不使用 Cookie。",
      inputSchema: z.object({
        url: z.string().url().describe("仅在小红书页面内容结构异常时传入的笔记链接"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ url }) => {
      try {
        const result = await debugXhsNote(url);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "诊断失败";
        return {
          isError: true,
          content: [{ type: "text" as const, text: message }],
        };
      }
    },
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

export default createWorker(mcpHandler);
