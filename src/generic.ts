export interface GenericReadResult {
  finalUrl: string;
  title: string;
  content: string;
  contentType: string;
  truncated: boolean;
}

export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;

function isSameOrSubdomain(hostname: string, baseDomain: string): boolean {
  return hostname === baseDomain || hostname.endsWith(`.${baseDomain}`);
}

export function isXhsUrl(inputUrl: string): boolean {
  try {
    const host = new URL(inputUrl).hostname.toLowerCase().replace(/\.$/, "");
    return isSameOrSubdomain(host, "xiaohongshu.com") || isSameOrSubdomain(host, "xhslink.com");
  } catch {
    return false;
  }
}

function parseIpv4(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
  return nums;
}

function isBlockedIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isBlockedIpv6(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host.includes(":")) return false;
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    /^fe[89ab]/.test(host) ||
    host.startsWith("ff") ||
    host.startsWith("2001:db8:")
  );
}

function assertPublicUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("只支持 HTTP/HTTPS URL");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "localhost.localdomain" ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  ) {
    throw new Error("出于安全原因，不能访问本机、内网或云元数据地址");
  }

  const ipv4 = parseIpv4(host);
  if ((ipv4 && isBlockedIpv4(ipv4)) || isBlockedIpv6(host)) {
    throw new Error("出于安全原因，不能访问本机、内网或保留 IP 地址");
  }
}

async function readBodyWithLimit(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new Error("页面响应过大，已拒绝读取（上限 5 MB）");
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("页面响应过大，已停止读取（上限 5 MB）");
    }
    chunks.push(value);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
  };
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function stripTags(input: string): string {
  return decodeEntities(input.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function htmlToMarkdown(html: string): { title: string; markdown: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? stripTags(titleMatch[1] ?? "") : "";

  let cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|svg|canvas|noscript|template|form|iframe)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, "");

  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(cleaned)?.[1];
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(cleaned)?.[1];
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(cleaned)?.[1];
  cleaned = article ?? main ?? body ?? cleaned;

  cleaned = cleaned
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code: string) => `\n\n\`\`\`\n${stripTags(code)}\n\`\`\`\n\n`)
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_m, v: string) => `\n# ${stripTags(v)}\n`)
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_m, v: string) => `\n## ${stripTags(v)}\n`)
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (_m, v: string) => `\n### ${stripTags(v)}\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, v: string) => `\n- ${stripTags(v)}`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|blockquote)>/gi, "\n\n")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const text = stripTags(label);
      return text ? `[${text}](${href})` : href;
    });

  const markdown = decodeEntities(cleaned.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, markdown };
}

async function fetchPublicPage(
  inputUrl: string,
  fetcher: Fetcher,
): Promise<{ response: Response; finalUrl: string }> {
  let current: URL;
  try {
    current = new URL(inputUrl);
  } catch {
    throw new Error("链接格式无效");
  }

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    assertPublicUrl(current);
    const response = await fetcher(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1",
        "user-agent": DESKTOP_USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("重定向缺少目标地址");
      if (redirectCount === MAX_REDIRECTS) throw new Error("重定向次数过多");
      current = new URL(location, current);
      continue;
    }

    if (!response.ok) throw new Error(`网页请求失败（HTTP ${response.status}）`);
    return { response, finalUrl: current.toString() };
  }

  throw new Error("重定向次数过多");
}

export async function readGenericUrl(
  inputUrl: string,
  maxChars = 20_000,
  fetcher: Fetcher = (input, init) => fetch(input, init),
): Promise<GenericReadResult> {
  const { response, finalUrl } = await fetchPublicPage(inputUrl, fetcher);
  const rawContentType = response.headers.get("content-type") ?? "";
  const contentType = rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const allowed = new Set([
    "text/html",
    "application/xhtml+xml",
    "text/plain",
    "application/json",
    "application/ld+json",
  ]);
  if (!allowed.has(contentType)) {
    throw new Error(`暂不读取此内容类型：${contentType || "unknown"}`);
  }

  const bytes = await readBodyWithLimit(response);
  const text = new TextDecoder().decode(bytes);

  let title = "";
  let content = "";
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    const parsed = htmlToMarkdown(text);
    title = parsed.title;
    content = parsed.markdown;
  } else if (contentType.includes("json")) {
    try {
      content = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      content = text;
    }
  } else {
    content = text;
  }

  const limit = Math.max(1_000, Math.min(50_000, Math.trunc(maxChars)));
  const truncated = content.length > limit;
  if (truncated) content = `${content.slice(0, limit)}\n\n[内容已截断]`;

  return {
    finalUrl,
    title,
    content,
    contentType,
    truncated,
  };
}
