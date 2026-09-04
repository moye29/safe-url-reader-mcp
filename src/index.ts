import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

import { createWorker } from "./worker";
import { readXhsNote } from "./xhs";

const noteOutputSchema = z.object({
  title: z.string(),
  content: z.string(),
  author: z.string(),
  images: z.array(z.string().url()),
  comments: z.array(
    z.object({
      author: z.string(),
      content: z.string(),
      likes: z.number(),
    }),
  ),
});

function createServer(): McpServer {
  const server = new McpServer({
    name: "xhs-read-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "read_xhs_note",
    {
      title: "读取小红书公开笔记",
      description:
        "读取 xhslink.com 短链或 xiaohongshu.com 普通笔记链接，返回标题、正文、作者、图片链接，以及可选的最多 5 条公开页首屏评论。只读，不登录，也不使用 Cookie。",
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
        return {
          content: [{ type: "text", text: JSON.stringify(note, null, 2) }],
          structuredContent: note,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取失败";
        return {
          isError: true,
          content: [{ type: "text", text: message }],
        };
      }
    },
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

export default createWorker(mcpHandler);
