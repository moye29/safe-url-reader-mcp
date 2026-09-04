# 小红书只读远程 MCP（Cloudflare Workers）

这是一个可部署到 Cloudflare Workers 的远程 MCP 服务。它只有一个工具：`read_xhs_note`。

它会读取小红书公开笔记页面中的 `window.__INITIAL_STATE__`，返回：

- 标题 `title`
- 正文 `content`
- 作者 `author`
- 图片链接 `images`
- 可选的公开页首屏评论 `comments`（默认 0，最多 5 条）

支持：

- `https://xhslink.com/...` 短链
- `https://www.xiaohongshu.com/explore/...` 等普通笔记链接
- Streamable HTTP MCP，端点固定为 `/mcp`
- 简单的 Bearer Token 鉴权

## 它明确不会做什么

- 不登录小红书
- 不使用、保存或转发 Cookie
- 不发布笔记
- 不点赞、收藏或发表评论
- 不抓评论分页或子评论
- 不调用单独的评论接口；评论只来自笔记公开 HTML 中已经存在的数据
- 不下载或转码图片；只返回公开状态里的 HTTPS 图片链接

## 工作方式

1. Worker 收到带 Bearer Token 的 MCP 请求。
2. 工具只接受 HTTPS 的 `xhslink.com` 和 `xiaohongshu.com` 链接。
3. 遇到短链时逐跳检查重定向目标，最多 5 次。
4. 请求公开 HTML，不发送 Cookie。
5. 优先提取 `window.__INITIAL_STATE__`，兼容原项目使用的两种笔记数据路径。
6. `comments=0` 时不返回评论；设置为 1–5 时，只截取 HTML 已带的前几条顶层评论。

## 完全不会部署的人：全程点网页的部署方法

需要一个免费的 GitHub 账号和一个免费的 Cloudflare 账号。Cloudflare Workers 是按请求启动的 Serverless 服务，不存在 Render 免费实例那种空闲休眠后等待唤醒的问题。

### 第 1 步：把代码放进 GitHub

1. 登录 GitHub，点右上角 `+`，再点 `New repository`。
2. Repository name 填 `xhs-read-mcp`，Public 或 Private 都可以。
3. 点 `Create repository`。
4. 在空仓库页面点 `uploading an existing file`。
5. 上传本项目这些内容：`src`、`test`、`package.json`、`package-lock.json`、`tsconfig.json`、`vitest.config.ts`、`wrangler.jsonc`、`.gitignore`、`.dev.vars.example` 和 `README.md`。
6. 不要上传 `node_modules`、`dist`、`work`、`.dev.vars`，也不要上传任何真实 Token。
7. 点页面底部 `Commit changes`。

### 第 2 步：在 Cloudflare 导入仓库

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 左侧进入 `Workers & Pages`。
3. 点 `Create application`。
4. 在 `Import a repository` 旁点 `Get started`。
5. 第一次使用时按提示连接 GitHub，只授权刚创建的仓库即可。
6. 选择 `xhs-read-mcp` 仓库。
7. Worker 名称必须填 `xhs-read-mcp`，与 `wrangler.jsonc` 中的 `name` 完全一致。
8. Production branch 选 `main`。
9. Root directory 留空。
10. Build command 留空。
11. Deploy command 保持默认 `npx wrangler deploy`。
12. 点 `Save and Deploy`，等待显示成功。

首次部署后服务已有地址，但因为还没设置 Token，访问 `/mcp` 会返回 500。这是故意的“未配置就拒绝工作”，继续下一步即可。

### 第 3 步：添加 Bearer Token

1. 在 Cloudflare 的 `Workers & Pages` 中点刚创建的 `xhs-read-mcp`。
2. 进入 `Settings`。
3. 找到 `Variables and Secrets`，点 `Add`。
4. 类型选 `Secret`。
5. Variable name 填：`MCP_BEARER_TOKEN`
6. Value 填一个只属于你的长随机字符串，建议至少 32 个随机字符。不要用示例值，也不要把它提交到 GitHub。
7. 点 `Deploy`。

部署完成后，Cloudflare 会显示类似下面的地址：

```text
https://xhs-read-mcp.<你的 workers.dev 子域>.workers.dev
```

MCP 地址是在末尾加 `/mcp`：

```text
https://xhs-read-mcp.<你的 workers.dev 子域>.workers.dev/mcp
```

### 第 4 步：连接 MCP 客户端

客户端必须支持 Streamable HTTP 和自定义请求头。通用配置形状如下；把 URL 和 Token 换成自己的：

```json
{
  "mcpServers": {
    "xhs-read": {
      "url": "https://xhs-read-mcp.<你的 workers.dev 子域>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <你的 Token>"
      }
    }
  }
}
```

不同客户端放置配置的页面或文件不同，但 `url` 和 `Authorization` 的值不变。若客户端只支持旧 SSE、不能添加 Header，就无法直接连接这个服务。

## 工具参数

工具名：`read_xhs_note`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `url` | string | 是 | xhslink.com 短链或 xiaohongshu.com 普通笔记链接 |
| `comments` | integer | 否 | 默认 `0`，允许 `0` 到 `5` |

不看评论：

```json
{
  "url": "https://www.xiaohongshu.com/explore/笔记ID"
}
```

返回最多 5 条公开页已有评论：

```json
{
  "url": "https://xhslink.com/你的短链",
  "comments": 5
}
```

## 本地测试与命令行部署（可选）

电脑已经安装 Node.js 20 或更高版本时：

```bash
npm install
copy .dev.vars.example .dev.vars
npm test
npm run typecheck
npm run dev
```

先编辑 `.dev.vars`，换掉示例 Token。本地 MCP 地址通常是 `http://localhost:8787/mcp`，以终端显示为准。

命令行部署：

```bash
npx wrangler login
npx wrangler secret put MCP_BEARER_TOKEN
npm run deploy
```

`wrangler secret put` 会提示你输入 Token，输入内容不会写进仓库。

## 常见问题

### 返回 401 Unauthorized

客户端没有发送 `Authorization: Bearer <Token>`，或 Token 与 Cloudflare Secret 不一致。注意 `Bearer` 后面有一个空格。

### 返回 500：Server authentication is not configured

Cloudflare 中还没有名为 `MCP_BEARER_TOKEN` 的运行时 Secret，或 Secret 尚未随新版本部署。回到 `Settings > Variables and Secrets` 添加并点 `Deploy`。

### 提示没有找到 `__INITIAL_STATE__` 或笔记数据

可能原因：笔记已删除、不是公开笔记、触发了站点风控，或小红书调整了页面结构。这个项目不会用登录、Cookie 或绕过风控的方式补救。

### 短链打不开

服务只允许短链最终跳到受支持的小红书 HTTPS 域名。跳到其他域名会被拒绝，这是防止任意网址请求的安全限制。

### 为什么不返回图片文件

Cloudflare 版本返回图片 URL，避免下载、转码和 Base64 放大带来的 Worker CPU 与内存开销，也更适合免费额度。

## 免费额度与稳定性

Cloudflare Workers 免费计划目前提供每日请求额度，Worker 没有“休眠实例”。但小红书仍可能对数据中心 IP 限流或改变公开页面结构，因此不能保证每条笔记始终可解析。请低频、自用，并遵守网站规则与适用法律。

这个 Worker 不缓存笔记，也不保存读取结果。每次工具调用会实时请求一次公开页面；短链会额外产生重定向请求。

## 安全说明

- Token 只应放在 Cloudflare Secret 和受信任的 MCP 客户端中。
- 不要把 `.dev.vars`、截图中的 Token 或客户端配置提交到公开仓库。
- Token 泄露时，在 Cloudflare 中修改 `MCP_BEARER_TOKEN` 并重新部署。
- 简单 Bearer Token 适合个人使用；多人、细粒度权限或公开服务应改用 OAuth。

## 与原项目的关系

本项目参考了 [usubamayoi/xhs-read-mcp](https://github.com/usubamayoi/xhs-read-mcp) 的公开 HTML / `__INITIAL_STATE__` 解析思路及两种数据路径，并保留“不登录、不用 Cookie”的方向。

原项目示例依赖 Node.js 的 curl、文件系统和 Sharp，不能直接运行在 Cloudflare Workers；同时其仓库当前未提供明确开源许可证。因此这里没有逐行复制源码，而是按相同公开数据结构独立实现 Worker 版本，并将图片处理改成返回 URL。

## 开发验证

```bash
npm test
npm run typecheck
npm run build
```

测试覆盖 Bearer 鉴权、未配置时失败关闭、Streamable HTTP 初始化、工具只读标注、参数默认值与上限、两种 `__INITIAL_STATE__` 路径、短链跳转、评论上限和 `undefined` token 兼容。

