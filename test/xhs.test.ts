import { describe, expect, it } from "vitest";

import { parsePublicNoteHtml, readXhsNote } from "../src/xhs";

describe("public Xiaohongshu page parsing", () => {
  it("returns the requested note fields from __INITIAL_STATE__", () => {
    const html = `<!doctype html><script>
      window.__INITIAL_STATE__ = ${JSON.stringify({
        noteData: {
          data: {
            noteData: {
              title: "周末散步",
              desc: "今天去了公园。",
              user: { nickName: "小明" },
              imageList: [
                { urlDefault: "//sns-img.example/one.jpg" },
                { url: "https://sns-img.example/two.jpg" },
              ],
            },
          },
        },
      })};
    </script>`;

    expect(parsePublicNoteHtml(html, 0)).toEqual({
      title: "周末散步",
      content: "今天去了公园。",
      author: "小明",
      images: [
        "https://sns-img.example/one.jpg",
        "https://sns-img.example/two.jpg",
      ],
      attachments: [],
      comments: [],
    });
  });

  it("merges richer detailMap images and discovers attachment metadata", () => {
    const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({
      noteData: {
        data: {
          noteData: {
            title: "轻量数据",
            desc: "正文",
            user: { nickName: "作者" },
          },
        },
      },
      note: {
        noteDetailMap: {
          abc: {
            note: {
              title: "完整数据",
              imageList: [
                {
                  infoList: [
                    { imageScene: "WB_DFT", url: "https://sns-img.example/detail.jpg" },
                  ],
                },
              ],
              attachmentList: [
                {
                  fileName: "demo.docx",
                  downloadUrl: "https://files.example/demo.docx",
                  fileId: "file-1",
                },
              ],
            },
          },
        },
      },
    })}</script>`;

    const note = parsePublicNoteHtml(html, 0);
    expect(note.title).toBe("轻量数据");
    expect(note.images).toEqual(["https://sns-img.example/detail.jpg"]);
    expect(note.attachments).toEqual([
      {
        name: "demo.docx",
        url: "https://files.example/demo.docx",
        id: "file-1",
      },
    ]);
  });

  it("supports noteDetailMap and returns at most five embedded top-level comments", () => {
    const comments = Array.from({ length: 7 }, (_, index) => ({
      content: `评论 ${index + 1}`,
      likeCount: index,
      userInfo: { nickname: `用户 ${index + 1}` },
    }));
    const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({
      note: {
        noteDetailMap: {
          abc: {
            note: {
              title: "另一种页面结构",
              desc: "正文",
              user: { nickname: "作者" },
              imageList: [],
            },
            comments,
          },
        },
      },
    })}</script>`;

    const note = parsePublicNoteHtml(html, 5);

    expect(note.comments).toHaveLength(5);
    expect(note.comments[0]).toEqual({
      author: "用户 1",
      content: "评论 1",
      likes: 0,
    });
    expect(note.comments[4]?.content).toBe("评论 5");
  });

  it("follows an xhslink.com redirect only to an allowed Xiaohongshu host", async () => {
    const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({
      noteData: {
        data: {
          noteData: {
            title: "短链笔记",
            desc: "正文",
            user: { nickName: "作者" },
            imageList: [],
          },
        },
      },
    })}</script>`;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://xhslink.com/a/test") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://www.xiaohongshu.com/explore/abc" },
        });
      }
      expect(url).toBe("https://www.xiaohongshu.com/explore/abc");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).has("cookie")).toBe(false);
      return new Response(html);
    };

    await expect(
      readXhsNote("https://xhslink.com/a/test", 0, fetcher),
    ).resolves.toMatchObject({ title: "短链笔记" });
  });

  it("converts JavaScript undefined tokens without changing text inside strings", () => {
    const html = `<script>window.__INITIAL_STATE__={"noteData":{"data":{"noteData":{"title":"undefined 保留","desc":"正文","user":{"nickName":"作者"},"imageList":[],"extra":undefined}}}}</script>`;

    expect(parsePublicNoteHtml(html, 0).title).toBe("undefined 保留");
  });
});
