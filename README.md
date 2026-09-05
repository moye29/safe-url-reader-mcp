# Safe URL Reader MCP

一个部署在 Cloudflare Workers 上的只读远程 MCP，用于读取公开 URL，并对特定高风控站点使用更保守的专用策略。

当前策略：

- 小红书 `xiaohongshu.com` / `xhslink.com`：走专用匿名 SSR 解析，不登录、不使用 Cookie，不自动重试。
- 其他公网 HTTP(S) URL：走轻量直接 GET + 正文提取，不执行 JavaScript，不发送 Cookie 或 Authorization。
- 统一入口：`read_url`。
- 诊断工具：`debug_url`（连接/超时）与 `debug_xhs_note`（小红书页面结构）。

## MCP 工具

### `read_url`
默认读取入口。服务端自动按域名分流。

参数：

- `url`：公开 HTTP(S) URL
- `comments`：仅小红书生效，默认 0，最多 5 条公开页首屏评论
- `max_chars`：仅普通网页生效，默认 20000，最大 50000

### `read_xhs_note`
保留的兼容工具。普通情况下优先使用 `read_url`。

### `debug_url`
仅在用户明确要求诊断连接、超时、HTTP 状态或重定向时使用。

对于小红书采用保守诊断策略：

- 不自动 retry
- 不尝试切换 UA
- 不自动切换 HTTP/HTTPS
- 每个重定向节点只请求一次
- 只记录请求链与响应头信息，不额外抓取正文

### `debug_xhs_note`
仅在用户明确要求诊断小红书页面结构时使用，用于排查正文、图片、附件等 SSR 字段变化。

## 安全策略

通用 URL Reader 包含以下限制：

- 只允许 HTTP / HTTPS
- 拒绝 localhost、常见私网 IP、link-local、云 metadata、保留地址
- 每次重定向都重新校验目标 URL
- 最多 5 次重定向
- 普通网页请求默认 15 秒超时
- 最大响应体 5 MB，并在流式读取过程中执行上限
- 仅读取 HTML、XHTML、纯文本和 JSON
- 不支持 POST / PUT / DELETE
- 不发送 Cookie
- 不发送 Authorization
- 不执行页面 JavaScript

小红书额外采用低频、匿名、无 Cookie 的专用解析路径。

## 自动化测试与 CI

运行：

```bash
npm test
npm run typecheck
```

当前自动化测试覆盖：

- 通用 HTML 正文读取与小红书域名识别
- localhost、私网、link-local、IPv6 loopback 等 SSRF 拦截
- 重定向目标重新校验，避免跳转到受限地址
- 5 MB 响应上限与不支持的 Content-Type 拒绝
- `debug_url` 只检查响应信息、不读取最终正文
- `debug_url` 重定向逐跳单次请求
- 小红书 `debug_url` 不 retry、不切换 UA/协议
- 小红书 SSR 数据、图片等原有解析能力
- MCP 工具列表与 Worker `/mcp` 边界行为

GitHub Actions 会在 `main` push 和 Pull Request 时自动执行：

```text
npm ci
npm test
npm run typecheck
```

## Cloudflare Worker 与命名兼容

GitHub 仓库及 npm package 已统一为 `safe-url-reader-mcp` / `safe-url-reader-mcp-worker`。

`wrangler.jsonc` 中当前线上 Worker 名仍有意保留为：

```text
xhs-read-mcp
```

这是为了保持现有 `workers.dev` 地址和已配置的 MCP 客户端兼容。只改 GitHub 仓库名不需要修改 ChatGPT 中现有的服务器 URL。

`package-lock.json` 应与 `package.json` 的 package 名称和版本保持同步；它不决定 Cloudflare Worker 地址。

MCP 端点固定为：

```text
/mcp
```

## 本地开发

```bash
npm install
npm test
npm run typecheck
npm run dev
```

部署：

```bash
npm run deploy
```

## 设计原则

这个项目的重点不是最大化抓取能力，而是：

1. 默认只读
2. 尽量少请求
3. 不携带登录态
4. 对高风控站点使用单独策略
5. 对通用 URL 做必要 SSRF 与资源限制
6. 页面无法安全、稳定读取时宁可失败，不自动升级到 Playwright、登录态或高频重试

## 小红书支持范围

当前小红书解析会从公开页面 SSR 状态中提取：

- 标题
- 正文
- 作者
- 图片
- 公开页面可见附件元数据
- 可选少量首屏评论

不会：

- 登录
- 使用或保存 Cookie
- 发布、点赞、收藏、评论
- 自动抓评论分页
- 使用 Playwright
- 为了绕过限制进行高频重试

## 项目来源说明

小红书解析思路参考了 `usubamayoi/xhs-read-mcp` 对公开 HTML / `__INITIAL_STATE__` 的处理方式，但当前 Cloudflare Worker 版本为独立实现，并已扩展为通用 Safe URL Reader。
