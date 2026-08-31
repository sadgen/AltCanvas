# Agent 接续工作日志

供接续开发的 AI agent（Codex 等）快速恢复上下文。新会话开工前先读本文件与
`docs/canvas-design.md`（验收基线）。每次会话结束时在文末追加新小节。

## 2026-08-30 会话（ZCode 接续 Codex 中断点）

### 起点

- 分支 `feat/reader-ux-fixes`，上一会话 Codex 因额度中断，约 3400 行改动
  全部未提交（Canvas C1/C2/C3/C5、安全模块、调试设施、6 套测试）。
- 自动化状态良好：`npm test` 全过、服务可启动；审计账本记录至"第二轮验收"。
- 注意：该分支目前只有本地提交，尚未推送远程。

### 本次修改（8 个提交）

| 提交 | 内容 |
| --- | --- |
| `c17faec` | feat(logging): run-logged 包装器 + dev-logger 诊断设施 |
| `415ec45` | feat(security): security/oidc/stream 模块抽离、服务端 AI provider、BFF 核心更新 |
| `f1c9ceb` | feat(canvas): SQLite canvas store + owner-only canvas API |
| `5e71ad2` | feat(canvas): 空间画板 UI + dev-server 接线 |
| `f65ea17` | docs: canvas 设计基线、human-in-loop 指南、AGENTS.md |
| `cb13b64` | build: docker 部署、env 配置、package 脚本 |
| `d292f58` | fix(canvas): 补实现 `restoreCanvasAnnotationToPdf`（Codex 的中断点，详见下） |
| `b6399e5` | docs: 审计账本记录第三轮验收 |

**Codex 中断点详情**：审计账本、服务端 `PATCH /canvas/nodes/:id/source`
（`replaceNodeSource`）、"原注已删"卡片的 ↺ 按钮 UI、canvas-ui 测试断言都已完成，
唯独前端处理函数缺失，点击报 `restoreCanvasAnnotationToPdf is not defined`。
本次补齐：快照重建高亮批注（`reader._annotationManager.addAnnotation`）→ 等待
`clientAnnotationIdMap` 出现新 server key → source PATCH 重绑 → `forgetDeletedAnnotation`
清除徽标 → 重渲染。

### 验收状态

- `npm test` 6 套全过（BFF 单元、BFF 流程、AI 边界、Canvas 存储/API、UI 结构、开发日志）。
- 三轮人工实机验收均通过（详见 `docs/canvas-design.md` 审计账本）：
  1. 05:13 UTC：HTTPS 主流程、Ctrl+Z 服务端持久化。
  2. 05:29 / 06:11 UTC：跨文献跳转竞态关闭、导入画板布局竞态关闭、导出与历史面板通过。
  3. 06:25 UTC：批注恢复链路闭合，provenance 记录 `node.source_relinked`，日志零错误。

### 待办（按优先级）

1. **C5 AI 端到端验收**（被配置阻塞）：`.env` 未配置 `AI_BASE_URL` / `AI_MODEL` /
   `AI_API_KEY`。配置后重启服务：画板多选卡片 → AI 合成/翻译，验证紫色 `ai_output`
   卡片、自动溯源连线、provenance 中的 AI 事件。未配置时 AI 功能保持禁用是预期行为。
2. **C2 移动端可访问性验收**：手机或窄窗口验证画板平移/缩放、卡片拖动、底部工具栏、
   移动端 reader/canvas 双栏切换。
3. 后续增强（非阻塞）：C1 端到端浏览器测试补充；C3 导出包完整性签名。
   C4（多人协作）明确延期，不实施。

### 接续上下文（架构要点）

- **Reader 集成**：同源 iframe；host 经 `contentWindow.createReader(...)` 创建实例
  （`currentReaderInstance`）。程序化创建批注用
  `reader._annotationManager.addAnnotation({ type, color, position, sortIndex, text, pageLabel })`；
  持久化经 `onSaveAnnotations=handleSaveAnnotations` 写回 Altero，
  clientId→serverKey 映射存于 `clientAnnotationIdMap`，服务端条目在 `currentAnnotationsMap`。
- **Canvas 并发模型**：所有写请求要求 `If-Match: W/"<version>"`；428=缺头，
  412=版本冲突。响应带新 ETag。
- **Source 快照结构**：`{ libraryType, libraryId, itemKey, attachmentKey,
  annotationKey, annotationVersion, pageLabel, position, quoteSnapshot }`，存
  `source_refs` 表，前端镜像 `canvasSources` Map；重绑产生新 source ref 并记
  `node.source_relinked` 审计事件。
- **状态徽标**：`knownDeletedAnnotationKeys` / `sourceFreshnessMap` 派生
  "原注已删 / 原文已更"；`forgetDeletedAnnotation` 负责清除。
- **测试**：`npm test`，全部无外部依赖（Node 22 内置 `node:sqlite`，有
  ExperimentalWarning 属预期）。
- **日志**：`.debug/dev.log` 与 `.debug/browser.log`（run-logged + dev-logger，
  2 MiB 轮转）；诊断规范见 `AGENTS.md` 与 `docs/human-in-loop-debugging.md`。
- **已知良性噪音**：`server.clientError "write EPIPE"` 为页面刷新导致的客户端断开，
  无需处理。

### 工作方式

- UI 验收按 `docs/human-in-loop-debugging.md`：agent 管开发服务与日志，人做 UI
  操作；给最短复验步骤，以"完成 / 已复现 / 看日志"作为查日志的交接信号。
- 完成验收后更新 `docs/canvas-design.md` 审计账本，并在本文件追加会话记录。

## 2026-08-30 会话（Codex 读取 handoff 后接续）

### 已完成

- 复核 06:25 UTC 后的日志：没有新增浏览器运行时、Reader、Fetch 或 Canvas 错误。
- 审计 `restoreCanvasAnnotationToPdf`，补上 PDF 批注已经创建后 source PATCH 因并发
  卡片编辑返回 412 的安全重载/重试；只在来源仍为旧 source ref 时重试，避免覆盖
  已由其他操作完成的重绑。
- 重绑后清理前端旧 source 缓存、标记新来源 intact，并补齐历史面板的
  `node.source_relinked` 中文名称。
- 增加来源重绑 API 的成功、陈旧版本 412、group library 越权 403、快照保留测试，
  以及 PDF 来源卡片可编辑和恢复并发分支的 UI 结构断言。
- `npm test` 六套全过；`git diff --check` 通过。

### 当前状态与下一步

- 待人工最小复验：编辑 PDF 来源卡片后刷新确认持久化；删除其 PDF 原批注，再点 ↺
  恢复并确认“原注已删”消失、PDF 中出现新批注。
- C5 仍被配置阻塞：`AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY` 当前均未设置。
- 随后执行 C2 窄窗口/手机实机验收。C4 继续延期。

### 编辑焦点缺陷

- 人工复验发现 PDF 来源卡片进入编辑后必须按住输入框才能持续输入。日志无异常；根因是
  卡片容器的冒泡 click 处理在 input/textarea 获得焦点后再次调用 `element.focus()`。
- 卡片选择处理现已豁免 button、input、textarea、select 和 contenteditable，表单控件
  不再被父卡片夺走焦点，并增加 UI 结构回归断言。待刷新页面后实机复验。

### 用户个人 AI 配置

- 设置面板新增兼容接口地址、模型名称、API Key、“保存并测试”和“清除个人配置”。
- 初版 `POST/DELETE /canvas/ai/config` 将个人配置写入服务端登录会话；Key 不进入
  浏览器 storage、不在 GET/POST 响应中返回。该存储方式随后已被下方“真正持久化”
  方案取代。
- 用户端点仍经过 HTTPS、私网/DNS、账号密码 URL 和 query 清理等 SSRF 边界；本地
  Ollama 必须由管理员显式允许私网及 HTTP，用户不能自行放宽安全策略。
- AI 测试和生成均优先使用当前用户的个人配置，清除后回退 `.env` 管理员默认。
- 开发服务已重启，健康探测返回 200；六套自动化测试全过。待真实模型实机验收。

### AI 连接测试首轮诊断

- 日志显示首次保存先因服务重启后的旧登录会话失效返回 401；重新登录后，用户填写的
  HTTP 端点被默认安全策略拒绝，但校验异常被通用 Canvas handler 错误映射成 500，
  前端只显示“Canvas request failed”。
- AI 地址格式、HTTPS、私网/DNS 等配置校验现统一使用 `TypeError`，由 API 映射为
  400 并向设置界面返回脱敏后的具体原因。HTTP 本地模型仍必须由管理员通过
  `ALLOW_INSECURE_AI`，私网地址同时通过 `ALLOW_PRIVATE_AI_HOSTS` 显式放行。

### AI 高频流程减弹窗

- 真实模型翻译已由用户确认成功，最新日志未见 AI 请求异常。
- 画板工具栏新增“中译”和“总结”一键操作：使用当前选择直接生成，不打开 AI
  模态框；“更多 AI”保留对比、问答和自定义指令入口。
- 成功生成、保存个人 AI 配置及清除配置不再弹 Toast，改用画板状态文字和新生成
  卡片反馈；错误仍保留显式提示。AI 请求增加前端 in-flight 锁，防止连续点击重复生成。

### AI 配置改为真正持久化

- 用户指出登录会话并不等同于个人设置：缺少 `SESSION_SECRET` 时重启即丢失，即便
  会话可恢复，退出登录也会删除配置。个人 AI 配置因此从 session 迁移到 Canvas DB。
- 新增 schema v2 `ai_settings`，以 Canvas `owner_key` 隔离；Base URL/Model 持久化，
  API Key 使用 AES-256-GCM 加密。加密主密钥首次启动时自动生成到数据库同目录的
  `ai-settings.key`（0600），该目录已被 Git 忽略；也可由管理员提供
  `AI_SETTINGS_SECRET` 或 `AI_SETTINGS_KEY_FILE`。
- GET/POST/DELETE 配置、连接测试和生成全部改为读取 owner 级设置；无个人设置时
  仍回退 `.env`。增加明文不落库、owner 隔离和数据库重开后恢复测试。

### AI 隐私加固

- 上游非 2xx 响应不再把任意 `error.message` 返回浏览器或写入调试日志，只保留
  HTTP 状态及满足严格字符白名单的短错误码；新增恶意错误正文不泄露回归测试。
- Canvas 数据目录启动时强制 0700，SQLite/WAL/SHM 与 `ai-settings.key` 强制 0600。
- 设置面板提示局域网 HTTP 会明文传输内容与凭据；AI 面板明确披露只发送当前选中
  卡片的标题、正文、引用快照与自定义指令，不自动发送整篇 PDF。
- `.env.example` 增加可选 `AI_SETTINGS_SECRET`，便于将加密主密钥与数据备份分离。

### C5 改为阅读驱动（待实机验收）

- C5 的主验收已从“选中卡片后生成另一张卡片”调整为两条文档工作流；原卡片 AI
  保留为次级工具，详见 `docs/canvas-design.md` 的 C5 章节。
- 新 PDF 高亮保存成功后可自动调用 `/canvas/ai/translate`，把译文写回同一 Reader
  标注 comment，并由既有 Altero PATCH 链路持久化；设置中可关闭，已有 comment 不覆盖，
  成功不弹 Toast。
- 画板工具栏新增“理解全文”：客户端用 PDF.js `getPageData` 逐页提取文本，调用
  `/canvas/boards/:id/ai/document-map`。服务端按页段并发生成阅读笔记，再合成为概览、
  章节、概念、论点/证据和关系；所有 node/source/edge 在一个 SQLite 事务内写入。
- 全文节点携带文献、附件和页码范围 source ref，可从卡片跳回 PDF；provenance 只记录
  模型、文档 key、页数和结构计数，不记录 PDF 正文或模型响应。
- 默认安全上限为请求体 768 KiB、可提取正文 600,000 字符、每块约 30,000 字符；
  超限会明确拒绝，不以“全文”名义静默截断。对应环境变量已写入 `.env.example`。
- 自动化已补充接口、事务化理解图、来源引用及 UI 结构断言；仍需真实模型和 Reader
  实机验证“高亮 → comment 中译 → 刷新保留”与“理解全文 → 多节点画板 → 页码跳转”。

## 2026-08-30 会话（ZCode 审计 Codex 新增功能）

### 审计结论

- 服务端（`ai_settings` 加密存储、AI config 端点、document-map、SSRF 边界、
  权限隔离、文件权限）、前端（设置面板、恢复 412 重试、焦点修复、证据高亮）
  与六套测试逐一复核：`npm test` 全过，vendor reader 内部 API 调用
  （`navigate`/`getPageData`/`setAnnotations`/`_annotationManager` 路径）均与
  `vendor/reader/build/web` 实际构建产物核对无误；`setAnnotations` 不触发保存
  管线，紫色证据高亮不会污染正式批注。
- `.debug` 日志复核：15:14 的 AI config 500（TypeError 误映射）已由 Codex 的
  400 修复消解；16:58–16:59 两次 document-map 502（"原文引用无法核验"）来自
  生产部署的旧版本。

### 审计修复（本会话提交）

- document-map 引用核验失败不再废弃整图：完全无法匹配的模型引用降级为无引用
  卡片（保留页码范围，`quoteSnapshot=null`，前端不显示原文定位按钮），设计文档
  同步改口径；语料句子 shingle 索引改为每次请求只构建一次（此前每张卡片全库
  重复扫描）。回归测试覆盖"改写引用→语义修复"与"虚构引用→降级"两条路径。
- 注意：`altcanvas.622276.xyz:8443` 生产环境运行的代码落后于本分支（16:58 的
  报错文案与本地代码不一致可证），需要重新部署后才能验收本轮修复。
- 待人工复验：真实模型重跑一次"理解全文"，确认不再 502、无引用卡片正常显示。

## 2026-08-30 会话二（ZCode：按用户要求调整证据策略）

- 用户要求理解全文的每张卡片都必须有原文出处并可高亮定位；自动加正式批注仅作为
  高亮不可行时的兜底（经分析不实现：高亮失败只剩"该页无文本层"一种情形，此时
  批注同样没有坐标可锚定，反而会污染文库）。
- 证据核验改为三级保真：逐字核验 → 语义最近句修复 → 杜撰引用在声称页码范围内
  确定性选取真实原句作锚点；仅当整篇无可用文本层时才允许无引用。前端点击链路
  （字符层矩形还原 → 紫色会话级高亮 → Reader 搜索兜底 → 页码跳转）不变。
- 回归测试覆盖虚构引用锚定到声称页范围；设计文档 C5 口径同步更新。

## 2026-08-30 会话三（ZCode：证据转正式批注）

- 按用户要求新增"证据 → 正式批注"：单卡"转批注"按钮 + 工具栏"🔖 证据转批注"
  批量转换。复用既有链路组合，无新服务端接口：字符层定位矩形 → reader 批注管理器
  `addAnnotation`（走 handleSaveAnnotations 持久化，comment 前缀阻断划线自动中译）
  → source PATCH 重绑到批注 key（provenance `node.source_relinked`，412 重试同恢复
  流程）。转换后页脚显示"已转批注 ✓"。
- 批量转换按卡片顺序执行并缓存 getPageData；无法定位的引用记失败不创建空批注。
- 待人工复验：单卡转换、批量转换、转换后批注在 PDF/文库中真实存在、刷新后"已转
  批注 ✓"状态保留、批注删除后卡片来源状态正常感知。

## 2026-08-30 会话四（ZCode：修复面板分割线拖拽粘连）

- 根因：分割线拖拽使用 `pointerdown` 启动，但监听的是 `window` 的 `mousemove/mouseup` 且未调用 `setPointerCapture`。当指针滑入 Reader iframe（或窗口外）松开鼠标时，`mouseup` 事件被 iframe 截获而无法通知到顶层 window，导致松开鼠标后分割线依然跟随指针移动。
- 修复：升级为标准 Pointer Capture 机制（`divider.setPointerCapture(pointerId)` + `pointermove/pointerup/pointercancel/blur` 清理），主键约束（`e.button === 0`），并在结束时释放 capture 与事件监听。

## 2026-08-30 会话五（ZCode：卡片内容自适应尺寸与滚轮交互优化）

- **卡片自适应尺寸与非重叠排版**：
  - 全文概览卡片加大至宽度 640px，高度根据内容行数自适应（320–540px）。
  - 单卡独占一行的分类（如只有 1 个章节或 1 个概念）自动使用 620px 宽卡片；2 卡行使用 460px；3 卡行使用 380px（原 320px）。
  - 高度根据文本字符数与证据引用动态计算行高（260–480px），避免大多数卡片出现多余滚动条，同时保留极端超长文本的内部滚动。
  - 动态计算每行实际最大高度并自上而下递推排列，彻底避免卡片纵向重叠。
  - 手写卡片与导入标注默认尺寸同步提升为自适应。
- **滚轮缩放与滚动交互标准对齐**：
  - `Ctrl / Cmd + 滚轮`（或触控板双指捏合）：缩放画布并以鼠标指针为锚点。
  - 鼠标悬停在卡片内容滚动区域（`.canvas-node-body`）上方时：优先顺畅滚动卡片内部文字，不截获滚轮事件。
  - 在画布空白处滚动：直接平移/滚动作业画布（支持 `Shift + 滚轮` 水平平移）。
- **批量转批注防 412 竞态加固**：
  - 批量转换前取消待触发的布局定时器，且每张卡片转换取最新的内存版本，消除 412 报错。
