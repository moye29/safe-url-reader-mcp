import { isXhsUrl, type Fetcher } from "./generic";

const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export interface UrlDebugHop {
  url: string;
  elapsedMs: number;
  status?: number;
  location?: string;
  contentType?: string;
  error?: string;
}

export interface UrlDebugResult {
  inputUrl: string;
  isXhs: boolean;
  requestPolicy: string;
  hops: UrlDebugHop[];
  outcome: "response_received" | "timeout_or_network_error" | "http_error" | "redirect_error";
  finalUrl?: string;
  note: string;
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

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

export async function debugUrlConnection(
  inputUrl: string,
  fetcher: Fetcher = (input, init) => fetch(input, init),
): Promise<UrlDebugResult> {
  let current: URL;
  try {
    current = new URL(inputUrl);
  } catch {
    throw new Error("链接格式无效");
  }

  const xhs = isXhsUrl(inputUrl);
  const hops: UrlDebugHop[] = [];

  // XHS safety rule: one request per redirect hop, never retry with another UA/protocol,
  // never download the final response body. This keeps diagnostics no more aggressive
  // than a normal anonymous page request.
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    assertPublicUrl(current);
    const started = performance.now();
    let response: Response;
    try {
      response = await fetcher(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1",
          "user-agent": DESKTOP_USER_AGENT,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "network error";
      hops.push({ url: current.toString(), elapsedMs: elapsed(started), error: message });
      return {
        inputUrl,
        isXhs: xhs,
        requestPolicy: xhs
          ? "XHS-safe: single GET per redirect hop; no retries; no alternate UA/protocol; final body not downloaded"
          : "single GET per redirect hop; no retries; final body not downloaded",
        hops,
        outcome: "timeout_or_network_error",
        finalUrl: current.toString(),
        note: "诊断只检查到响应头；为减少额外请求和流量，不下载最终正文。",
      };
    }

    const hop: UrlDebugHop = {
      url: current.toString(),
      elapsedMs: elapsed(started),
      status: response.status,
      contentType: response.headers.get("content-type") ?? undefined,
    };

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? undefined;
      hop.location = location;
      hops.push(hop);
      await response.body?.cancel().catch(() => undefined);
      if (!location || redirectCount === MAX_REDIRECTS) {
        return {
          inputUrl,
          isXhs: xhs,
          requestPolicy: xhs
            ? "XHS-safe: single GET per redirect hop; no retries; no alternate UA/protocol; final body not downloaded"
            : "single GET per redirect hop; no retries; final body not downloaded",
          hops,
          outcome: "redirect_error",
          finalUrl: current.toString(),
          note: location ? "重定向次数过多。" : "重定向响应缺少 Location。",
        };
      }
      current = new URL(location, current);
      continue;
    }

    hops.push(hop);
    await response.body?.cancel().catch(() => undefined);
    return {
      inputUrl,
      isXhs: xhs,
      requestPolicy: xhs
        ? "XHS-safe: single GET per redirect hop; no retries; no alternate UA/protocol; final body not downloaded"
        : "single GET per redirect hop; no retries; final body not downloaded",
      hops,
      outcome: response.ok ? "response_received" : "http_error",
      finalUrl: current.toString(),
      note: response.ok
        ? "已拿到响应头；诊断到此停止，不额外下载正文。"
        : `已拿到服务器响应，但 HTTP 状态为 ${response.status}。`,
    };
  }

  throw new Error("重定向次数过多");
}
