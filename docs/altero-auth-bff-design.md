# AltCanvas × Altero 认证与 BFF 实施方案

状态：BFF 客户端主体已实现，等待 Altero 端联调与生产验收
适用范围：自建 AltCanvas 前端、自建 Altero 服务、Zotero 兼容 API 与 PDF Reader

> **状态：已归档（superseded）。** 本方案描述的 Altero/Zotero 集成已于 M4 移除，仅作历史记录；当前架构见 docs/m4-native-library-manager.md 与 docs/handoff.md。归档实现见 git 标签 archive/last-altero-compatible。

## 1. 结论

采用 **OpenID Connect / OAuth 2.0 Authorization Code + PKCE + AltCanvas BFF**。

- 用户只在 Altero 的授权页面输入用户名和密码。
- AltCanvas 浏览器端不接收、不保存密码、永久 API Key、access token 或 refresh token。
- AltCanvas BFF（Backend for Frontend）负责回调、换取令牌、刷新令牌和代理 API。
- 浏览器只持有一个不可被 JavaScript 读取的会话 Cookie。
- 现有 `Zotero-API-Key` 保留给兼容客户端或人工生成的专用 Key，不作为 AltCanvas 登录后的凭据下发。

不采用以下流程：

```text
浏览器提交 Altero 用户名/密码 -> 返回用户永久 API Key -> localStorage/sessionStorage
```

该流程会让 AltCanvas 接触用户密码，并把长期高权限凭据暴露给前端。任何 XSS、恶意扩展、调试日志或浏览器存储泄漏都可能导致整个文库长期失陷。

## 2. 目标架构

```text
浏览器（AltCanvas UI）
  │  仅发送同源请求；只保存 HttpOnly 会话 Cookie
  ▼
AltCanvas BFF
  ├─ 登录状态、state/nonce、PKCE verifier
  ├─ 服务端保存 access/refresh token
  ├─ /api/* 代理 Zotero 兼容 API
  └─ /files/* 代理 PDF，保留 Range/206
  │
  ▼
Altero
  ├─ OIDC/OAuth 授权服务
  ├─ 用户认证与授权同意
  ├─ 短期 access token / 轮换 refresh token
  └─ Zotero 兼容资源 API
```

推荐生产环境使用同一个站点：

```text
https://canvas.example.com/          AltCanvas 静态页面
https://canvas.example.com/auth/*    BFF 登录接口
https://canvas.example.com/api/*     BFF API 代理
https://canvas.example.com/files/*   BFF 文件代理
https://altero.example.com/oauth/*   Altero 授权服务
```

## 3. 登录流程

### 3.1 开始登录

浏览器导航到：

```http
GET /auth/login?return_to=/
```

BFF 执行以下操作：

1. 生成高熵 `state`、`nonce`、PKCE `code_verifier`。
2. 保存这些值及安全校验后的站内 `return_to`，有效期 10 分钟。
3. 生成 `S256 code_challenge`。
4. 以顶层页面跳转到 Altero：

```http
GET https://altero.example.com/oauth/authorize
  ?response_type=code
  &client_id=altcanvas
  &redirect_uri=https%3A%2F%2Fcanvas.example.com%2Fauth%2Fcallback
  &scope=openid%20profile%20library.read%20library.write%20annotations.read%20annotations.write%20files.read
  &state=<random>
  &nonce=<random>
  &code_challenge=<S256>
  &code_challenge_method=S256
```

用户名、密码和多因素认证只发生在 Altero 页面。

### 3.2 回调与建会话

Altero 登录成功后重定向：

```http
GET /auth/callback?code=<one-time-code>&state=<state>
```

BFF 必须：

1. 常量时间比较 `state`，并拒绝过期或已使用记录。
2. 在服务端使用 `code_verifier` 调用 Altero `/oauth/token`。
3. 校验 OIDC ID Token 的签名、`iss`、`aud`、`exp` 和 `nonce`。
4. 创建新的服务器端会话；登录时轮换会话 ID，防止 session fixation。
5. 删除一次性的 state/nonce/PKCE 数据。
6. 设置 Cookie 后用 `303 See Other` 跳回已校验的 `return_to`。

Cookie 推荐：

```http
Set-Cookie: __Host-altcanvas_session=<opaque-random-id>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800
Cache-Control: no-store
```

`__Host-` Cookie 不得设置 `Domain`，必须使用 HTTPS 和 `Path=/`。会话 ID 至少使用 128 bit CSPRNG 随机值；数据库只保存其哈希值。

### 3.3 使用和退出

前端通过以下同源接口获得最小身份信息：

```http
GET /auth/session
```

示例响应：

```json
{
  "authenticated": true,
  "user": {
    "id": "stable-altero-subject",
    "displayName": "Researcher"
  },
  "scopes": ["library.read", "annotations.read", "annotations.write", "files.read"]
}
```

不要返回 access token、refresh token、API Key、邮箱或不必要的账户字段。

退出使用 POST：

```http
POST /auth/logout
```

BFF 撤销 refresh token（若 Altero 支持）、删除服务端会话并清除 Cookie。所有带副作用的 Cookie 认证请求均需 CSRF 防护。

## 4. Altero 需要提供的认证接口

最低接口集合：

| 接口 | 用途 |
| --- | --- |
| `GET /.well-known/openid-configuration` | OIDC 服务发现 |
| `GET /oauth/authorize` | 登录和授权，签发一次性 code |
| `POST /oauth/token` | code 换 token、refresh token 轮换 |
| `POST /oauth/revoke` | 撤销 refresh/access token |
| `GET /oauth/userinfo` | 可选，返回受 scope 限制的身份信息 |
| `GET /.well-known/jwks.json` | 发布 ID Token 签名公钥 |

注册 AltCanvas 为 confidential web client：

```text
client_id: altcanvas
redirect_uri: https://canvas.example.com/auth/callback
grant_types: authorization_code, refresh_token
token_endpoint_auth_method: client_secret_basic 或 private_key_jwt
PKCE: S256 必须
```

生产环境优先 `private_key_jwt`；若先使用 client secret，必须仅保存在 BFF 的 secret manager 或运行时环境，不得进入 Git、浏览器 bundle 或日志。

## 5. Token 与权限模型

### 5.1 建议时效

| 凭据 | 建议寿命 | 规则 |
| --- | ---: | --- |
| Authorization code | 60 秒 | 一次性使用，绑定 client、redirect URI 与 PKCE |
| Access token | 10–15 分钟 | 最小 scope，不写浏览器存储 |
| Refresh token | 30 天绝对寿命 | 每次使用时轮换；检测重复使用后撤销整个 token family |
| AltCanvas 会话 | 8 小时空闲 / 30 天绝对上限 | 登录、提权和敏感资料变更后轮换 |

### 5.2 Scope

建议拆分：

```text
openid
profile
library.read
library.write
annotations.read
annotations.write
files.read
groups.read
```

初始版本只申请实际使用的 scope。删除条目、账户管理、API Key 管理等高风险权限不授予 AltCanvas。

### 5.3 Token 形态

资源 API access token 推荐使用短期 JWT 或 opaque token；refresh token 推荐 opaque 随机值，并只以哈希形式存储。若使用 JWT，资源服务器必须严格校验签名算法、issuer、audience、有效期和 scope，不能只解码不验签。

Altero 的 Zotero 兼容 API 可在迁移期同时接受：

```http
Zotero-API-Key: <legacy-dedicated-key>
Authorization: Bearer <oauth-access-token>
```

两种凭据进入同一授权层，但 OAuth token 的权限由 scope 和用户授权共同限制。禁止提供“列出或返回用户现有永久 Key”的 OAuth 接口。

## 6. AltCanvas BFF 接口

### 6.1 认证路由

```text
GET  /auth/login
GET  /auth/callback
GET  /auth/session
POST /auth/logout
```

### 6.2 API 代理

前端把现有跨域 Altero 请求改为同源请求：

```text
原：GET https://altero.example.com/users/<id>/items
新：GET /api/users/<id>/items
```

BFF 从服务器端会话取得 access token，自动刷新后转发：

```http
Authorization: Bearer <short-lived-token>
Zotero-API-Version: 3
```

BFF 应使用明确的路由 allowlist，不能接受任意上游 URL，以免形成 SSRF 或开放代理。建议允许的资源前缀：

```text
/users/<authorized-user-id>/collections
/users/<authorized-user-id>/items
/groups/<authorized-group-id>/collections
/groups/<authorized-group-id>/items
```

不要直接信任 URL 中的 user/group ID；必须与当前 token 的 subject、membership 和 scope 再次校验。

### 6.3 PDF 文件代理

前端使用同源 URL：

```text
/files/users/<user-id>/items/<attachment-key>
```

BFF 只允许访问当前用户有权读取且 MIME 类型符合预期的附件。转发并正确处理：

- 请求头：`Range`、`If-Range`、`If-None-Match`。
- 响应状态：`200`、`206`、`304`、`416`。
- 响应头：`Content-Type`、`Content-Length`、`Content-Range`、`Accept-Ranges`、`ETag`、`Last-Modified`、`Content-Disposition`。
- 使用流式管道，不把整份 PDF 读入 BFF 或浏览器内存后再复制。
- 对文件大小、并发、速率和超时设置限制；客户端断开时取消上游请求。

文件响应建议使用：

```http
Cache-Control: private, no-store
X-Content-Type-Options: nosniff
Content-Security-Policy: sandbox
```

不要在 URL、查询参数、`Referer`、下载文件名或错误页面中包含 token、API Key、用户名或内部存储路径。

## 7. 服务端数据模型

可以从以下最小表开始；字段名可按 Altero/BFF 技术栈调整。

```text
oauth_clients
  id, client_id, secret_hash/public_key, redirect_uris, allowed_scopes,
  created_at, disabled_at

oauth_authorization_codes
  id, code_hash, client_id, user_id, redirect_uri, scopes,
  code_challenge, nonce, expires_at, consumed_at

oauth_refresh_tokens
  id, token_hash, family_id, parent_id, client_id, user_id, scopes,
  expires_at, rotated_at, revoked_at

altcanvas_sessions
  id, session_hash, user_id, access_token_encrypted,
  refresh_token_encrypted, scopes, idle_expires_at, absolute_expires_at,
  created_at, last_seen_at, revoked_at

auth_transactions
  id, state_hash, nonce, pkce_verifier_encrypted, return_to,
  expires_at, consumed_at
```

数据库泄漏防护：

- 可查找的 bearer 值只保存密码学哈希。
- BFF 必须取回使用的上游 token 使用 envelope encryption，密钥不与数据库同存。
- 日志和错误追踪对 `Authorization`、Cookie、code、token、密码、API Key 做默认脱敏。
- 审计日志记录事件、actor、时间、结果和粗粒度资源类型，不记录文献标题、标注正文或 PDF 内容。

## 8. Web 安全基线

### 8.1 CSRF 与跨站边界

- `SameSite=Lax` 是第一层，不是唯一一层。
- `POST/PUT/PATCH/DELETE` 校验 CSRF token 或严格校验 `Origin`/`Sec-Fetch-Site`。
- 登录回调严格校验 `state`；OIDC 同时校验 `nonce`。
- `return_to` 只允许站内相对路径，禁止任意 URL 重定向。
- BFF 和 UI 同源时无需向浏览器开放 Altero CORS；Altero OAuth 页面只允许已注册 redirect URI。

### 8.2 XSS 与浏览器策略

- 所有不可信字段使用文本节点或上下文安全转义，不使用未净化的 `innerHTML`。
- 配置严格 CSP，优先将内联脚本迁移到独立文件后去掉 `unsafe-inline`。
- 建议响应头：`frame-ancestors 'none'`、`base-uri 'none'`、`object-src 'none'`、`Referrer-Policy: no-referrer`、`Permissions-Policy` 最小化。
- 第三方依赖固定版本并定期审计；不要从运行时 CDN 注入可执行代码。

### 8.3 密码与账户

- Altero 密码使用 Argon2id（参数按服务器性能校准）及唯一 salt 哈希。
- 登录、验证码、重置密码和 token 端点均限速；错误消息不暴露账号是否存在。
- 支持 TOTP/WebAuthn；敏感操作要求近期重新认证。
- 用户停用、密码重置或安全事件发生时，可撤销全部 refresh token 和 AltCanvas 会话。

## 9. 隐私规则

- 只收集完成同步、阅读和标注所需的数据。
- 默认不记录查询字符串、请求体、PDF 内容、文献标题、笔记和标注正文。
- 指标使用聚合数据，不把稳定用户 ID 发送给第三方分析服务。
- 明确会话、审计日志、备份和已删除数据的保留周期。
- 开发和测试使用专用账号及非敏感资料；禁止把真实 host、IP、用户名、item key 或响应体提交到公开仓库。
- 密钥轮换、备份加密、恢复演练与访问审计应作为上线条件。

## 10. 当前 AltCanvas 的迁移步骤

截至 2026-08-27 的仓库状态：

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| A：BFF 骨架 | 基本完成 | 会话、认证路由、API/File allowlist 代理已实现；会话可使用 `SESSION_SECRET` 加密持久化 |
| B：OAuth/OIDC | AltCanvas 侧完成，Altero 侧待联调 | 已实现 discovery、PKCE、JWKS、ID Token/nonce 校验、token refresh；Altero 必须提供本文定义的端点与 claims |
| C：前端切换 | 基本完成 | 生产默认只走 Cookie/BFF；PDF.js 通过同源 `/files/*` 执行 Range 请求；手工 Key 仅保留在开发模式 |
| D：上线验证 | 进行中 | 单元、模拟 OIDC/BFF 全流程、静态路由、CSRF、refresh/revoke、PDF Range 和容器构建检查已通过；真实节点的 code replay、大文件和停用用户测试仍待执行 |

实现并不代表已经满足第 11 节的生产验收标准；真实 Altero 节点和生产反向代理环境仍需完成阶段 D。

### 阶段 A：BFF 骨架

1. 将当前只提供静态文件的开发服务器扩展或替换为正式 BFF。
2. 实现服务器端会话存储与 `/auth/session`、`/auth/logout`。
3. 建立严格的 `/api/*` 和 `/files/*` allowlist 代理。
4. 保持现有手工 API Key 模式仅用于本地开发，并在 UI 中明确标记为临时兼容模式。

### 阶段 B：Altero OAuth/OIDC

1. 实现 discovery、authorize、token、JWKS、revoke。
2. 实现 Authorization Code、PKCE S256、refresh token rotation 和 reuse detection。
3. 将 OAuth subject 映射到 Altero 用户与其 Zotero `userID`；前端不再手工输入 user ID。
4. 资源 API 接受并校验 Bearer token scope。

### 阶段 C：前端切换

1. 设置按钮中的 API 地址、用户 ID 和 API Key 输入改为“登录 Altero / 退出登录”。
2. 删除 `sessionStorage.altcanvas_key`、`localStorage.altcanvas_api` 和 `localStorage.altcanvas_user_id` 的生产路径。
3. 所有 API 调用改为 `/api/*`，使用 Cookie 的同源 `fetch`。
4. Reader 从 `/files/*` URL 流式加载 PDF，不再先下载完整 `ArrayBuffer`。
5. 遇到 `401` 时进入统一重新登录流程；`403` 显示缺少权限，不自动扩大 scope。

### 阶段 D：上线验证

- 授权 code 重放、state/nonce/PKCE 错误均被拒绝。
- refresh token 被重复使用时整个 family 被撤销。
- XSS 无法读取会话 Cookie 或任何 Altero token。
- CSRF、开放重定向、SSRF、越权 user/group ID 测试通过。
- PDF Range 请求正确返回 206；大文件不造成服务内存线性增长。
- 退出、密码重置、用户停用和管理员撤销能使现有会话失效。
- 日志、前端存储、URL、Git 历史和错误上报中均无凭据及私人文献数据。

## 11. 最小验收标准

只有同时满足以下条件，才应移除手工 Key 兼容入口：

1. AltCanvas 从未接收用户密码。
2. 浏览器开发者工具中找不到 access token、refresh token 或永久 API Key。
3. 用户能登录、刷新页面、自动续期、退出并撤销会话。
4. 文库读取、标注写入和 PDF Range 读取均通过 BFF 完成。
5. 每个请求按 subject、library membership 和 scope 做服务端授权。
6. 安全测试与隐私日志检查通过，并有可执行的密钥轮换和事故响应流程。

## 12. 标准依据

- OAuth 2.0 Security Best Current Practice: <https://www.rfc-editor.org/info/rfc9700/>
- OAuth 2.0 for Browser-Based Applications: <https://www.rfc-editor.org/info/rfc10017/>
- Proof Key for Code Exchange (PKCE): <https://www.rfc-editor.org/info/rfc7636/>
- OpenID Connect Core 1.0: <https://openid.net/specs/openid-connect-core-1_0-final.html>
- Zotero Web API authentication: <https://www.zotero.org/support/dev/web_api/v3/basics>
- Zotero OAuth flow: <https://www.zotero.org/support/dev/web_api/v3/oauth>

## 13. 实施前仍需确定

开始编码前需要确定以下信息：

- Altero 后端源码所在目录与语言/框架。
- AltCanvas BFF 使用同一进程、独立服务还是反向代理后置服务。
- 生产域名与 TLS/反向代理拓扑。
- 会话存储（单机数据库或 Redis）及服务端密钥管理方式。
- 个人库、群组库和管理员账户的精确授权规则。
- 是否需要保留第三方 Zotero 客户端使用的长期专用 API Key。

这些选择会影响代码结构和部署配置，但不改变核心原则：密码只交给 Altero，长期凭据只留在服务端，浏览器只持有受保护的会话 Cookie。
