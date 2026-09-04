type JsonRecord = Record<string, unknown>;

export interface XhsComment {
  author: string;
  content: string;
  likes: number;
}

export interface XhsAttachment {
  name: string;
  url?: string;
  id?: string;
  type?: string;
}

export interface XhsNote {
  title: string;
  content: string;
  author: string;
  images: string[];
  attachments: XhsAttachment[];
  comments: XhsComment[];
}

export interface XhsDebugEntry {
  path: string;
  key: string;
  preview: string;
}

export interface XhsDebugResult {
  finalUrl: string;
  htmlLength: number;
  stateTopLevelKeys: string[];
  noteDataKeys: string[];
  detailMapKeys: string[];
  matches: XhsDebugEntry[];
}

export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const XHS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

function normalizeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("http://")) return `https://${value.slice("http://".length)}`;
  return value.startsWith("https://") ? value : undefined;
}

function collectHttpsUrls(value: unknown, result: string[] = []): string[] {
  const normalized = normalizeUrl(value);
  if (normalized) {
    result.push(normalized);
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectHttpsUrls(item, result);
    return result;
  }
  const obj = record(value);
  if (obj) {
    for (const child of Object.values(obj)) collectHttpsUrls(child, result);
  }
  return result;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function imageUrlsFromList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const urls: string[] = [];
  for (const item of value) {
    const image = record(item);
    const preferred = normalizeUrl(
      image?.urlSizeLarge ?? image?.urlDefault ?? image?.url ?? image?.urlPre ?? image?.traceId,
    );
    if (preferred) {
      urls.push(preferred);
      continue;
    }
    const nestedUrls = unique(collectHttpsUrls(item));
    if (nestedUrls.length > 0) urls.push(nestedUrls[0]!);
  }
  return unique(urls);
}

function attachmentFromRecord(value: unknown): XhsAttachment | undefined {
  const obj = record(value);
  if (!obj) return undefined;

  const name = text(
    obj.fileName ?? obj.filename ?? obj.name ?? obj.title ?? obj.resourceName,
  );
  const type = text(obj.fileType ?? obj.type ?? obj.mimeType ?? obj.resourceType);
  const id = text(obj.fileId ?? obj.id ?? obj.resourceId ?? obj.attachmentId);

  const directUrl = normalizeUrl(
    obj.downloadUrl ?? obj.fileUrl ?? obj.resourceUrl ?? obj.url,
  );
  const discoveredUrl = directUrl ?? unique(collectHttpsUrls(obj))[0];

  const documentLike = /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|md|epub|lua)(?:$|[?#])/i;
  const looksLikeAttachment =
    Boolean(name || id || type) &&
    (Boolean(directUrl) || Boolean(id) || documentLike.test(discoveredUrl ?? ""));

  if (!looksLikeAttachment) return undefined;

  let finalName = name;
  if (!finalName && discoveredUrl) {
    try {
      finalName = decodeURIComponent(new URL(discoveredUrl).pathname.split("/").pop() ?? "");
    } catch {}
  }

  return {
    name: finalName || "附件",
    ...(discoveredUrl ? { url: discoveredUrl } : {}),
    ...(id ? { id } : {}),
    ...(type ? { type } : {}),
  };
}

function findAttachments(root: unknown): XhsAttachment[] {
  const found: XhsAttachment[] = [];
  const seen = new Set<unknown>();

  function visit(value: unknown, path: string[]): void {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item, path);
      return;
    }

    const obj = record(value)!;
    const pathText = path.join(".").toLowerCase();
    if (/(attachment|document|download|filelist|notefile|resource)/.test(pathText)) {
      const candidate = attachmentFromRecord(obj);
      if (candidate) found.push(candidate);
    }

    for (const [key, child] of Object.entries(obj)) {
      visit(child, [...path, key]);
    }
  }

  visit(root, []);

  const deduped = new Map<string, XhsAttachment>();
  for (const item of found) {
    const key = item.url ?? item.id ?? `${item.name}|${item.type ?? ""}`;
    if (!deduped.has(key)) deduped.set(key, item);
  }
  return [...deduped.values()].slice(0, 10);
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

function parseStateFromHtml(html: string): unknown {
  const marker = /window\.__INITIAL_STATE__\s*=\s*/.exec(html);
  if (!marker) throw new Error("页面中没有找到 __INITIAL_STATE__");
  const start = marker.index + marker[0].length;
  const end = html.indexOf("</script>", start);
  if (end === -1) throw new Error("__INITIAL_STATE__ 脚本不完整");
  const rawState = html.slice(start, end).trim().replace(/;\s*$/, "");
  return JSON.parse(replaceUndefinedTokens(rawState)) as unknown;
}

export function parsePublicNoteHtml(html: string, _commentLimit: number): XhsNote {
  const state = parseStateFromHtml(html);
  const detailMap = record(nested(state, ["note", "noteDetailMap"]));
  const firstDetail = detailMap
    ? record(detailMap[Object.keys(detailMap)[0] ?? ""])
    : undefined;
  const primaryNote = record(nested(state, ["noteData", "data", "noteData"]));
  const detailNote = record(firstDetail?.note);
  const preloadImages = nested(state, ["noteData", "normalNotePreloadData", "imagesList"]);
  const note = primaryNote ?? detailNote;
  if (!note) throw new Error("公开页面中没有找到笔记数据");

  const user = record(primaryNote?.user) ?? record(detailNote?.user) ?? record(note.user);
  const images = unique([
    ...imageUrlsFromList(primaryNote?.imageList),
    ...imageUrlsFromList(detailNote?.imageList),
    ...imageUrlsFromList(preloadImages),
  ]);

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

  const attachments = findAttachments(state);

  return {
    title: text(primaryNote?.title ?? detailNote?.title, "(无标题)"),
    content: text(primaryNote?.desc ?? detailNote?.desc),
    author: text(user?.nickName ?? user?.nickname, "未知用户"),
    images,
    attachments,
    comments,
  };
}

async function fetchPublicHtml(
  inputUrl: string,
  fetcher: Fetcher,
): Promise<{ html: string; finalUrl: string }> {
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

    return { html: await response.text(), finalUrl: currentUrl.toString() };
  }

  throw new Error("短链跳转次数过多");
}

export async function readXhsNote(
  inputUrl: string,
  commentLimit = 0,
  fetcher: Fetcher = (input, init) => fetch(input, init),
): Promise<XhsNote> {
  const { html } = await fetchPublicHtml(inputUrl, fetcher);
  return parsePublicNoteHtml(html, commentLimit);
}

function previewValue(value: unknown): string {
  try {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    if (!raw) return String(value);
    return raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
  } catch {
    return "[unserializable]";
  }
}

export async function debugXhsNote(
  inputUrl: string,
  fetcher: Fetcher = (input, init) => fetch(input, init),
): Promise<XhsDebugResult> {
  const { html, finalUrl } = await fetchPublicHtml(inputUrl, fetcher);
  const state = parseStateFromHtml(html);
  const matches: XhsDebugEntry[] = [];
  const seen = new Set<unknown>();
  const interesting = /(image|img|url|file|attach|download|resource|document|media|cover)/i;

  function visit(value: unknown, path: string[]): void {
    if (matches.length >= 200) return;
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (index >= 20) break;
        visit(value[index], [...path, `[${index}]`]);
      }
      return;
    }

    const obj = record(value)!;
    for (const [key, child] of Object.entries(obj)) {
      const nextPath = [...path, key];
      if (interesting.test(key) || interesting.test(nextPath.join("."))) {
        matches.push({
          path: nextPath.join("."),
          key,
          preview: previewValue(child),
        });
        if (matches.length >= 200) return;
      }
      visit(child, nextPath);
    }
  }

  visit(state, []);

  const stateObj = record(state);
  const noteData = record(nested(state, ["noteData", "data", "noteData"]));
  const detailMap = record(nested(state, ["note", "noteDetailMap"]));

  return {
    finalUrl,
    htmlLength: html.length,
    stateTopLevelKeys: Object.keys(stateObj ?? {}).slice(0, 100),
    noteDataKeys: Object.keys(noteData ?? {}).slice(0, 100),
    detailMapKeys: Object.keys(detailMap ?? {}).slice(0, 100),
    matches,
  };
}
