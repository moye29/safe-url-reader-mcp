import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

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

function createServer(): McpServer {
  const server = new McpServer({
    name: "xhs-read-mcp",
    version: "1.3.1",
  });

  server.registerTool(
    "read_xhs_note",
    {
      title: "读取小红书公开笔记",
      description:
        "默认用于读取用户分享的小红书链接。读取 xhslink.com 短链或 xiaohongshu.com 普通笔记链接，返回标题、正文、作者、图片、公开页面可见附件元数据，以及可选的最多 5 条公开页首屏评论。图片会尽量以内联图片内容返回给模型。只读，不登录，也不使用 Cookie。用户只提供或分享小红书链接时，应优先调用本工具。",
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
      title: "诊断小红书公开页面结构（仅开发调试）",
      description:
        "仅用于开发调试页面结构。除非用户明确要求“诊断”“调试”“debug”或明确点名 debug_xhs_note，否则绝对不要调用本工具。尤其当用户只是分享/粘贴一个小红书链接、要求读取/总结/查看内容时，不要调用本工具，应调用 read_xhs_note。该工具会读取公开笔记页面并返回较多结构字段，仅用于排查页面改版；只读，不登录，不使用 Cookie。",
      inputSchema: z.object({
        url: z.string().url().describe("仅在用户明确要求诊断/调试时传入的小红书笔记链接"),
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
