type JsonRecord = Record<string, unknown>;

export interface XhsComment {
  author: string;
  content: string;
  likes: number;
}

export interface XhsNote {
  title: string;
  content: string;
  author: string;
  images: string[];
  comments: XhsComment[];
}

export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const XHS_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function assertAllowedUrl(url: URL): void {
  const allowedHosts = new Set([
    "xhslink.com",
    "www.xhslink.com",
    "xiaohongshu.com",
    "www.xiaohongshu.com",
  ]);

  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error("只支持 HTTPS 的 xhslink.com 或 xiaohongshu.com 链接");
  }
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function nested(root: unknown, keys: string[]): unknown {
  let value = root;
  for (const key of keys) {
    value = record(value)?.[key];
  }
  return value;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("//")) return `https:${value}`;
  return value.startsWith("https://") ? value : undefined;
}

function replaceUndefinedTokens(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }

    if (source.startsWith("undefined", index)) {
      const before = source[index - 1] ?? "";
      const after = source[index + "undefined".length] ?? "";
      if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) {
        result += "null";
        index += "undefined".length - 1;
        continue;
      }
    }

    result += character;
  }

  return result;
}

export function parsePublicNoteHtml(html: string, _commentLimit: number): XhsNote {
  const marker = /window\.__INITIAL_STATE__\s*=\s*/.exec(html);
  if (!marker) throw new Error("页面中没有找到 __INITIAL_STATE__");

  const start = marker.index + marker[0].length;
  const end = html.indexOf("</script>", start);
  if (end === -1) throw new Error("__INITIAL_STATE__ 脚本不完整");

  const rawState = html.slice(start, end).trim().replace(/;\s*$/, "");
  const state = JSON.parse(replaceUndefinedTokens(rawState)) as unknown;
  const detailMap = record(nested(state, ["note", "noteDetailMap"]));
  const firstDetail = detailMap
    ? record(detailMap[Object.keys(detailMap)[0] ?? ""])
    : undefined;
  const note =
    record(nested(state, ["noteData", "data", "noteData"])) ??
    record(firstDetail?.note);
  if (!note) throw new Error("公开页面中没有找到笔记数据");

  const user = record(note.user);
  const imageList = Array.isArray(note.imageList) ? note.imageList : [];
  const images = imageList
    .map((item) => {
      const image = record(item);
      return normalizeImageUrl(image?.url ?? image?.urlDefault ?? image?.urlPre);
    })
    .filter((url): url is string => Boolean(url));
  const directCommentData = record(
    nested(state, ["noteData", "data", "commentData"]),
  );
  const detailComments = firstDetail?.comments;
  const nestedDetailComments = record(detailComments)?.comments;
  let rawComments: unknown[] = [];
  if (Array.isArray(directCommentData?.comments)) {
    rawComments = directCommentData.comments;
  } else if (Array.isArray(detailComments)) {
    rawComments = detailComments;
  } else if (Array.isArray(nestedDetailComments)) {
    rawComments = nestedDetailComments;
  }
  const commentLimit = Math.max(0, Math.min(5, Math.trunc(_commentLimit)));
  const comments = rawComments.slice(0, commentLimit).map((value) => {
    const comment = record(value);
    const commentUser = record(comment?.user) ?? record(comment?.userInfo);
    const likeCount = Number(comment?.likeCount ?? 0);

    return {
      author: text(commentUser?.nickName ?? commentUser?.nickname, "匿名"),
      content: text(comment?.content),
      likes: Number.isFinite(likeCount) ? likeCount : 0,
    };
  });

  return {
    title: text(note.title, "(无标题)"),
    content: text(note.desc),
    author: text(user?.nickName ?? user?.nickname, "未知用户"),
    images,
    comments,
  };
}

export async function readXhsNote(
  inputUrl: string,
  commentLimit = 0,
  fetcher: Fetcher = (input, init) => fetch(input, init),
): Promise<XhsNote> {
  let currentUrl: URL;
  try {
    currentUrl = new URL(inputUrl);
  } catch {
    throw new Error("链接格式无效");
  }

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    assertAllowedUrl(currentUrl);
    const response = await fetcher(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": XHS_USER_AGENT,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("短链跳转缺少目标地址");
      if (redirectCount === 5) throw new Error("短链跳转次数过多");
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!response.ok) {
      throw new Error(`公开页面请求失败（HTTP ${response.status}）`);
    }

    return parsePublicNoteHtml(await response.text(), commentLimit);
  }

  throw new Error("短链跳转次数过多");
}
