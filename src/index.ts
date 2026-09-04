import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

import { createWorker } from "./worker";
import { debugXhsNote, readXhsNote } from "./xhs";

const attachmentSchema = z.object({
  name: z.string(),
  url: z.string().url().optional(),
  id: z.string().optional(),
  type: z.string().optional(),
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
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
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
    version: "1.2.0",
  });

  server.registerTool(
    "read_xhs_note",
    {
      title: "读取小红书公开笔记",
      description:
        "读取 xhslink.com 短链或 xiaohongshu.com 普通笔记链接，返回标题、正文、作者、图片、公开页面可见附件信息，以及可选的最多 5 条公开页首屏评论。图片会尽量以内联图片内容返回给模型。只读，不登录，也不使用 Cookie。",
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
      title: "诊断小红书公开页面结构",
      description:
        "临时诊断工具：读取公开笔记页面，只返回与 image/img/url/file/attach/download/resource/document/media/cover 相关的字段路径和值预览，用于适配页面结构。只读，不登录，不使用 Cookie。",
      inputSchema: z.object({
        url: z.string().url().describe("需要诊断的小红书笔记链接"),
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
