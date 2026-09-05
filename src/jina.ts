import { isXhsUrl, type Fetcher } from "./generic";

export interface JinaReadResult {
  finalUrl: string;
  title: string;
  content: string;
  source: "jina";
  truncated: boolean;
}

const JINA_READER_BASE = "https://r.jina.ai/";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function assertAllowedTarget(inputUrl: string): URL {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    throw new Error("链接格式无效");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("只支持 HTTP/HTTPS URL");
  }

  if (isXhsUrl(inputUrl)) {
    throw new Error("小红书 URL 禁止通过 Jina 读取，请使用 read_url / read_xhs_note");
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "169.254.169.254"
  ) {
    throw new Error("出于安全原因，不能通过 Jina 读取本机、内网或云元数据地址");
  }

  return url;
}

async function readTextWithLimit(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("Jina 返回内容过大，已拒绝读取（上限 5 MB）");
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Jina 返回内容过大，已停止读取（上限 5 MB）");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function readUrlWithJina(
  inputUrl: string,
  maxChars = 20_000,
  fetcher: Fetcher = (input, init) => fetch(input, init),
): Promise<JinaReadResult> {
  const target = assertAllowedTarget(inputUrl);
  const readerUrl = `${JINA_READER_BASE}${target.toString()}`;

  const response = await fetcher(readerUrl, {
    method: "GET",
    redirect: "follow",
    headers: {
      accept: "application/json",
      DNT: "1",
      "X-Timeout": "20",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Jina Reader 请求失败（HTTP ${response.status}）`);
  }

  const raw = await readTextWithLimit(response);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("Jina Reader 返回了无法解析的响应");
  }

  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const data = root.data && typeof root.data === "object"
    ? (root.data as Record<string, unknown>)
    : root;

  const title = typeof data.title === "string" ? data.title : "";
  const finalUrl = typeof data.url === "string" ? data.url : target.toString();
  let content = typeof data.content === "string" ? data.content : "";
  if (!content) throw new Error("Jina Reader 未返回可读正文");

  const limit = Math.max(1_000, Math.min(50_000, Math.trunc(maxChars)));
  const truncated = content.length > limit;
  if (truncated) content = `${content.slice(0, limit)}\n\n[内容已截断]`;

  return {
    finalUrl,
    title,
    content,
    source: "jina",
    truncated,
  };
}
