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
- 注意：公网反代生产环境运行的代码此前曾落后于本分支（16:58 的
  报错文案与本地代码不一致可证），服务重启后已与本地同步。
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

## 2026-08-31 会话（Codex：全文理解卡片空白与并发复审）

- 审计真实全文理解节点尺寸后确认：证据引用长度差异会让同列卡片高度相差约 150px，
  原先按每行最高卡片统一推进后续卡片，造成较短卡片下方出现大块画布空白。
- 全文理解布局改为连续分栏紧凑排布：列规格相同的章节、概念、论点层沿各自列底继续，
  不再被相邻高卡片强制留白；列规格变化时仍安全开启新层，避免重叠。
- 复核浏览器日志发现证据转批注仍可能与正在执行的布局保存竞争节点版本；转换前现在会
  取消待保存布局并等待进行中的保存结束，再读取最新节点版本，避免重复 412 冲突。
- 修复 BFF 单元测试受开发 `.env` 的 `ALLOW_PRIVATE_HOSTS` 污染问题：SSRF 用例显式在
  禁止私网的条件下执行，并在完成后恢复原环境。
- `npm test` 六套全过，`git diff --check` 通过。待页面刷新后人工复验当前视觉布局；
  已生成的旧画板保留用户手工位置，新布局应用于下一次“理解全文”生成。

### 浏览器内存溢出加固

- 浏览器 OOM 通常无法在崩溃前写入 `.debug/browser.log`；代码复审确认全文提取此前会先
  读取全部 PDF 页，再由服务端检查 600,000 字符/请求体上限，超大文档会在拒绝前制造
  不必要的字符层对象、字符串与 JSON 副本。
- 客户端现在逐页累计字符数和 UTF-8 请求体估算，达到 600,000 字符或约 700 KiB 时立即
  停止继续读取并给出明确错误，服务端 768 KiB 限制仍作为第二道边界。
- 批量证据转换的 PDF 字符层缓存改为最多保留最近 2 页，避免多张跨页证据卡片将大型
  `chars` 坐标数组同时留在浏览器堆中。

## 2026-08-31 会话（Codex：主题研究工作台实施方案）

- 新增 `docs/topic-research-workspace-design.md`，确定 Altero 继续作为报告、PDF、
  Collection、标签和正式批注的唯一事实来源；现有 Canvas `workspace` 直接升级为研究
  主题，报告通过多对多成员关系进入多个主题，`board` 保持主题内具体分析空间语义。
- 方案覆盖 Altero 批量入库与 AltCanvas 快速导入两条路径、研究收件箱、Collection
  `inbound` / `confirm_both` 绑定、标签写回边界、AI 多主题分类、基础全文分析复用、
  跨报告证据关系、可逆聚合收缩，以及 Canvas-first 的局部预览/PDF 浮层/完整阅读三级交互。
- 当前已确认 Collection/条目读取、通用条目写转发和 PDF 读取路径；完整 PDF 附件上传及
  增量 `since` 语义尚未针对 Altero 验证，列为 T0 兼容性闸门。未通过前不开放伪成功的
  Canvas 文件上传，首个可用切片优先实现“Altero 批量加入 → AltCanvas 增量收件箱 →
  人工批量加入多个主题”。
- README 与 Canvas 设计基线已链接该方案；本会话仅新增/更新设计文档，未修改运行代码。

## 2026-08-31 会话（Antigravity：T0 探针与 Schema v3 完整加固）

- **T0 Altero 兼容性探针重写与加固** ([`scripts/probe-altero.mjs`](file:///home/sadgen/Projects/AltCanvas/scripts/probe-altero.mjs))：
  - 增强为包含跨页分页遍历（start=0 与 start=2 数据不重叠）与严格 `since` 对比验证（验证增量过滤与版本头）。
  - 支持 `PROBE_ACTIVE_WRITE=true` 完整生命周期测试（临时条目创建、标签修改、版本冲突 412 拦截、附件创建与上传握手探测、清理）。
  - 默认只读模式将写/上传标记为 `DEFERRED`（不误判为 `SUPPORTED`）；发现 `FAILED`/`UNSUPPORTED` 时自动设置非零退出码。
  - 探针输出全面脱敏服务地址与用户 ID。
- **收件箱安全与输入规范化** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `POST /canvas/inbox/entries` 逐条通过 `validateLibraryAccess` 校验当前会话文库权限，限制批量上限（500 条）与各字段字符/数组长度，彻底阻断越权伪造 `libraryId` 漏洞。
- **实体乐观并发版本控制** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs) & [`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `topic_documents` 与 `collection_bindings` 新增单调递增 `version` 列。
  - HTTP `PATCH` 与 `DELETE` 接口强制要求 `If-Match` 请求头（缺省返回 428 Precondition Required，冲突返回 412 Precondition Failed），写成功时返回新 `ETag`。
- **真实 v2 → v3 迁移与并发测试** ([`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs))：
  - 构造真实 Schema v2 数据库（含画板、节点、边、AI 配置），验证升级至 v3 后的数据保真与主题能力。
  - 增加越权 403、字段超限 400、If-Match 428/412 并发冲突全流程测试。
  - 6 套测试套件（`npm test`）全过，`git diff --check` 通过。

## 2026-08-31 会话（复审修复：探针附件协议口径、安全清理、重复 POST 幂等与真实 v2 测试夹具）

- **探针附件协议与完整上传边界清晰化** ([`scripts/probe-altero.mjs`](file:///home/sadgen/Projects/AltCanvas/scripts/probe-altero.mjs))：
  - 将授权握手结果定性为 `HANDSHAKE_SUPPORTED`，显式将实际文件存储传输与回读标记为 `DEFERRED`（不夸大为完整闭环）。
  - 增加 `PROBE_STRICT=true` / `REQUIRE_T0_COMPLETE=true` 发布闸门模式：未完成真实写入与上传验证或存在 DEFERRED 项时非零退出；只读模式打印明确闸门未闭合警示。
- **安全版本化清理与失败阻断** ([`scripts/probe-altero.mjs`](file:///home/sadgen/Projects/AltCanvas/scripts/probe-altero.mjs))：
  - 创建与修改临时条目/附件时跟踪 `latestItemVersion` 与 `latestAttachmentVersion`。
  - DELETE 请求携带 `If-Unmodified-Since-Version` 版本头并检查 HTTP 状态码；删除失败记为 `FAILED`，输出脱敏 key 并让探针退出非零状态。
- **重复 POST 幂等防越过 ETag 机制** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs) & [`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs))：
  - `addTopicDocument` 与 `addCollectionBinding` 在遇到已存在的活跃记录时，直接返回现有实体，不执行 UPDATE 覆写 status/origin/attachment/version，彻底消除重复 POST 冲掉 PATCH 结果的隐患。
  - 恢复软删除条目时单调递增 `version`。
  - 补充 Store 层与 HTTP API 层的重复 POST 幂等性与 ETag 保持测试。
- **项目真实 Schema v2 迁移与全实体数据保真测试** ([`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs))：
  - 将测试夹具修正为真实 v1+v2 DDL（`viewport_x/y/zoom`、`node_type`、`source_refs`、`edges`、`ai_settings`、`provenance_events`）。
  - 插入代表性数据并验证升至 v3 后画板视口、节点、来源引用、边、AI 配置与审计事件 100% 保真读取。
- **全套验证通过**：
  - `npm test` 6 套测试全过，`git diff --check` 通过。

## 2026-08-31 会话（P2 后续跟进：Collection 写入验证、Creators/Tags 结构规范化与 AI 密钥保真解密）

- **探针 Collection 写入与成员关系回读** ([`scripts/probe-altero.mjs`](file:///home/sadgen/Projects/AltCanvas/scripts/probe-altero.mjs))：
  - 探针将标签修改与 Collection 关联拆开独立断言（`Tag & Metadata Mutation` 与 `Collection Item Association`）。
  - 主动写模式下将临时条目关联至探测到的集合，并通过 `/items/:key` 实体直读结合 `/collections/:key/items` 列表双重核验成员关系，杜绝超大集合前 50 条分页截断导致的假阴性。
- **收件箱 Creator 与 Tag 输入白名单规范化** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `inboxEntryInput` 严格过滤 Creator 对象字段（仅保留 `creatorType`、`firstName`、`lastName`、`name` 并在 64/200 字符内），剥离任意未授权嵌套字段。
  - Tag 对象形式提取 `tag` 字符串并实施 200 字符上限，统一输出为规范字符串数组。
- **真实 AI 密钥加解密保真与审计事件断言** ([`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs))：
  - v2 迁移夹具生成真实的 AES-256-GCM 加密载荷并写入 `ai-settings.key`，断言升至 v3 后明文 API Key 成功解密且与原值完全一致。
  - 增加历史 `provenance_events` 数据保真断言及 Creator/Tag 过滤测试。
- **全套测试通过**：
  - `npm test` 6 套全过，`git diff --check` 通过。

## 2026-08-31 会话（T1 复审加固：大文库多页扫描、事务级失败阻断、复合游标分页与跨文库打开）

- **大文库多页分页遍历与检查点增量拉取** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs) & [`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - `fetchAllUpstreamItems` 分页遍历上游全部条目（支持 `start=0, 100, 200...` 与 `Total-Results` 计算），彻底杜绝超过 100 条时静默漏项。
  - 前端以用户与文库身份持久化 `scanCheckpoint`（`Last-Modified-Version`），在触发增量扫描时回传 `since`，保证增量机制真实闭环。
- **失败版本推进阻断与事务原子性** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - 上游返回非 2xx 或非法 JSON 时立即返回 502 并中断同步，绝不推进 `lastLibraryVersion`。
  - Collection 绑定同步在 `inbound` 模式下将主题文献关联与版本推进包在同一 SQLite 事务中，杜绝部分写入产生版本偏差。
- **复合游标 `(updated_at, id)` 稳定分页与元数据统计** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs) & [`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `listInboxEntries` 升级为 `(updated_at, id)` 复合游标，解决同批次相同毫秒时间戳跳过记录的缺陷。
  - 增加 `countInboxEntries`，`GET /canvas/inbox` 响应返回 `meta: { unreadCount, totalCount, nextCursor }`。
  - 前端收件箱未读徽标依据全量真实 unreadCount 渲染，并支持“加载更多”游标分页。
- **跨文库与按需文献打开** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - 主题文献“打开阅读”严格匹配 `(libraryType, libraryId, itemKey)`；在当前本地缓存不存在或属于组文库时，自动按需从 BFF 获取条目并打开，消除 key 碰撞与打不开问题。
- **收件箱搜索覆盖发表年份** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - 前端收件箱检索条件补齐对 `entry.year` 的匹配。
- **全套回归测试** ([`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs))：
  - 增加 150 条跨页多分页扫描、同时间戳复合游标分页、上游 500 异常版本不推进隔离测试。
  - `npm test` 6 套全过，`git diff --check` 通过。

## 2026-08-31 会话（T1 深度加固：消除 1000 条硬上限、canvasFetch meta 透传、请求体校验、无结果翻页与全量集合加载）

- **解除 1000 条截断上限并保留熔断防错位** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `fetchAllUpstreamItems` 移除单次 1000 条硬截断限制，支持完整拉取超大文库全部增量页；若遭遇极端异常且无法拉取完整文库时显式抛错中断，绝不静默推进最新 `lastModifiedVersion`。
  - 回归测试覆盖 1150 条跨 12 页完整遍历断言。
- **扫描接口输入校验与请求体边界保护** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `POST /canvas/inbox/scan` 增加严格类型检查：强制校验 `body` 为合法对象、规范化 `libraryType`、校验 `libraryId` 长度、强制 `since` 为非负安全整数，非法输入返回 400。
- **canvasFetch 响应元数据透传与收件箱游标翻页** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - `canvasFetch` 增强支持 `includeMeta: true` 选项，解决此前被统一解构为 `payload.data` 导致 `meta.nextCursor` 与 `meta.unreadCount` 丢失的根因。
  - 收件箱支持真实游标分页，“加载更多”功能完全正常工作。
- **搜索无匹配时的跨页翻页能力** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - 当当前页搜索结果为空但存在 `nextCursor` 时，依然渲染“加载更多”按钮，允许用户继续翻页检索后续批次的文献。
- **Collection 绑定选择器全量加载** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - `loadAlteroCollectionsForBinding` 改为循环分页拉取用户在 Altero 中的全部 Collections，不再受单页 100 条限制截断。
- **全套验证通过**：
  - `npm test` 6 套测试全过，`git diff --check` 通过。

## 2026-08-31 会话（T1 终审加固：上游流截断/304/死循环熔断、流式内存降载与 Collection 分页保护）

- **上游分页协议边界与流式熔断** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - 针对跨页重复 key（分页重叠/死循环）、`Total-Results` 未达即空流（提前截断）、后续页意外 304 及无总数时耗尽安全页数四类异常，`fetchAllUpstreamItems` 均严格即时抛错并返回 502，绝不推进检查点。
  - 自动化回归测试真实构造第 2 页空流（100 条后接空）、第 2 页 304、跨页重复 key、无总数耗尽 3 页安全上限进行断言。
- **流式按页入库与内存零聚合** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `fetchAllUpstreamItems` 支持 `onPage` 回调流式模式；`POST /canvas/inbox/scan` 与 `POST /canvas/collection-bindings/:id/sync` 在每页抓取后即时入库并逐页执行事务，彻底消除 Node.js 内存堆中全量大数组与响应体聚合。
- **前端 Collection 分页防死循环与安全边界** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - `loadAlteroCollectionsForBinding` 修复 `Total-Results` 缺失时被 `Number(null) === 0` 误判提前终止的问题，增加 `seenKeys` 严格重复检测、提前截断校验与最大 50 页安全保护，遇到异常时显式在 UI 中报错提示，绝不静默返回残缺集合列表。
  - 补充第 1 页 100 条且无 `Total-Results`、第 2 页 1 条（共 101 条）的跨页拉取测试。
- **全套验证通过**：
  - `npm test` 6 套测试全过，`git diff --check` 通过。

## 2026-08-31 会话（T2 阶段：AI 分类建议与文档基础分析跨主题复用）

- **Schema v4 数据模型升级与基础分析缓存表** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs))：
  - 新增 `document_analyses` 表与 `(owner_key, library_type, library_id, attachment_key, model, prompt_version)` 联合唯一索引。
  - Store 提供 `getDocumentAnalysis`、`saveDocumentAnalysis` 与 `projectDocumentAnalysisToBoard` 方法，支持将结构化分析图实例化为不同主题的独立画板卡片与连线。
- **文档基础分析跨主题缓存复用** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs) & [`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - `POST /canvas/boards/:id/ai/document-map` 优先检查 `document_analyses` 缓存：若存在相同文献与模型的 `ready` 分析记录，直接投影并返回 `{ ...data, cached: true }`，完全跳过大模型调用；未命中则生成分析并缓存。
  - 前端在复用现有分析时给出明确提示 `✨ 已直接复用现有全文分析图谱`。
- **元数据级 AI 多主题分类服务接口** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `POST /canvas/inbox/classify`：基于文献标题、作者、年份、摘要、标签与主题的研究问题、纳入/排除规则进行结构化评估，返回置信度（0.0~1.0）与推荐理由。
- **收件箱 AI 建议与一键采纳 UI** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - 收件箱新增“✨ AI 智能分类”按钮与加载状态。
  - 文献卡片展示 AI 推荐主题徽标（包含置信度百分比与理由 tooltip），并提供快捷“采纳”按钮。
  - 底部工具栏新增“✨ 采纳 AI 建议”，支持一键批量归类高置信度（≥70%）推荐项。
- **全套自动化测试与验证** ([`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs) & [`test/canvas-ui.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas-ui.test.mjs))：
  - 补充 Schema v4 迁移与 `document_analyses` 增删查改测试。
  - 补充跨主题二次请求同一 PDF 基础分析 0 AI 调用且节点完全隔离的断言。
  - 补充 `POST /canvas/inbox/classify` 接口与 UI 元素断言。
  - `npm test` 6 套测试套件全部通过，`git diff --check` 通过。

## 2026-08-31 会话（T2 终审加固：版本失效缓存核验、全量文献直接检索、幻觉主题过滤与轻量预检）

- **PDF 附件版本更新与缓存失效核验** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs), [`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs) & [`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - 前端 `generateCurrentPdfUnderstandingCanvas` 发起请求时如实携带 Altero PDF 附件真实版本 `attachmentVersion`。
  - `document_analyses` 联合唯一索引通过 Schema 迁移升级为 `COALESCE(attachment_version, 0)` 组合索引，服务端 `getDocumentAnalysis` 与 `saveDocumentAnalysis` 严格按附件版本隔离缓存；当 PDF 附件版本更新时，自动绕过陈旧缓存并重新调用 AI 生成最新全文分析。
  - 回归测试真实覆盖 `document: { ... attachmentVersion: 2 }` 时触发重新分析断言。
- **分类接口全量文献直接检索、严格请求体验证与理由长度收敛** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `POST /canvas/inbox/classify` 严格校验 `body.entryIds` 格式与上限，直接按 ID 检索 `store.getInboxEntry`，彻底解除 100 条前置截断限制，支持对收件箱任意深度的文献发起智能分类。
  - 严格通过合法工作区列表过滤 AI 返回的主题，彻底剥离模型幻觉虚构的无效 `workspaceId`；推荐理由统一截取在 30 字符以内。
- **轻量预检与浏览器开销降载** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs) & [`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - `generateCurrentPdfUnderstandingCanvas` 在解析多页 PDF 前先行发起 `checkOnly: true` 轻量预检；若已存在分析缓存，直接由服务端完成画板投影，浏览器不再执行冗余的多页文本提取与上传。
- **多主题批量采纳增量重试保护** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - `acceptAllAiSuggestions` 按主题处理成功后，仅从该条文献的推荐列表中剔除对应成功的 `workspaceId`；出现部分主题失败时，保留未完成的主题推荐项供用户重试，并在 UI 中明确提示成功与失败计数。
- **全套验证通过**：
  - `npm test` 6 套测试全过，`git diff --check` 通过。

### 里程碑状态

| 里程碑 | 状态 | 说明 |
|---|---|---|
| Schema v5 数据模型 | **完成** | SQLite topic_documents, collection_bindings, inbox_entries, jobs, document_analyses, document_metas |
| T0 兼容性探针框架 | **就绪** | 增量 since、分页遍历、生命周期与版本化安全清理 |
| T0 真实 PDF 上传/回读实机闸门 | `IN_PROGRESS` | 等待专用存储适配探针闭环，Canvas PDF 拖入保持关闭 |
| T1 主题工作台与研究收件箱 | **PASS (关闭)** | 增量扫描、研究收件箱、批量多主题归类、Collection 绑定与全屏视图 |
| T2 AI 主题分类与分析复用 | **PASS (关闭)** | 元数据 AI 分类建议、一键采纳、轻量预检、附件版本化缓存与跨主题零开销投影 |
| 研报易读中文名与元数据识别 | **PASS (关闭)** | AI 提取机构/研报主标题/年份、SQLite document_metas、文库/收件箱易读中文名渲染与手动编辑 |
| T3 跨报告观点关联与渐进展开 | **就绪 (待启动)** | 下一阶段目标 |

## 2026-08-31 会话（研报易读中文名与智能元数据提取及审计加固）

- **Schema v5 数据模型与附件版本化缓存** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs))：
  - 新增 `document_metas` 表（`owner_key`, `library_type`, `library_id`, `item_key`, `attachment_key`, `attachment_version`, `clean_title`, `institution`, `report_title`, `subtitle`, `year`, `summary`, `source`）。
  - `inbox_entries` 增加 `clean_title` 与 `institution` 列。
  - Store 提供 `saveDocumentMeta`、`getDocumentMeta`、`listDocumentMetas`，支持 attachmentKey / attachmentVersion 关联并在保存时同步更新收件箱缓存。
- **AI 提取接口版本化缓存失效与 PATCH 真正部分更新** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `POST /canvas/documents/extract-metadata`：接收前 1~2 页文本、原标题/文件名及附件版本，当检测到附件 key 或附件版本变更时自动失效旧缓存并重新执行 AI 提取。
  - `PATCH /canvas/documents/metadata`：实施真正的增量部分更新（Partial Update），未传字段默认保留已有属性，彻底杜绝手动修改标题时副标题等既有字段被置空的问题。
- **前端文库栏、复合键隔离、生命周期缓存清理与收件箱检索支持** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - 前端引入 `docMetaKey(libraryType, libraryId, itemKey)` 复合键缓存映射，彻底隔离用户文库与群组文库同名 itemKey。
  - 文库加载（`loadCollectionsAndLibrary`）、退出登录（`handleLogout`）及保存新配置时显式调用 `documentMetas.clear()` 清理内存缓存，杜绝跨账号/跨文库状态残留。
  - 收件箱渲染列表统一使用复合键索引检索易读标题与机构。
  - 编辑弹窗补充“细分方向 / 副标题”输入框，支持完整元数据微调。
  - 收件箱搜索增加对 `cleanTitle` 与 `institution` 的全文检索匹配。
- **全套自动化测试加固** ([`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs) & [`test/canvas-ui.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas-ui.test.mjs))：
  - 覆盖 Schema v5 迁移、跨文库 itemKey 隔离、PATCH 部分更新字段保留、附件版本更新缓存失效，以及 UI DOM/方法结构断言。
  - 补充收件箱复合键渲染与 `documentMetas.clear()` 生命周期断言。
  - `npm test` 6 套测试全过，`git diff --check` 通过。验收状态标记为 **PASS（闭环完成）**。

## 2026-08-31 会话（T2 终审加固：Schema v6 索引重建迁移、严格无版本缓存隔离与多主题部分失败重试保留）

- **Schema v6 复合版本索引重建迁移与真实 v5→v6 测试** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs) & [`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs))：
  - 新增独立 Schema v6 迁移，安全执行 `DROP INDEX IF EXISTS` 并以 `(owner_key, library_type, library_id, attachment_key, COALESCE(attachment_version, 0), model, prompt_version)` 重建唯一索引。
  - 构造真实 Schema v5 历史数据库，验证升级至 v6 后复合索引正确生效并支持多版本隔离。
- **严格可靠版本匹配、无版本读取缓存未命中与重复保存安全** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs))：
  - `getDocumentAnalysis` 实施严格版本控制：当 `attachmentVersion` 为空或非有效正整数时直接判定为缓存未命中返回 `null`，强制重新分析，消除内容更新后的错位投影。
  - `saveDocumentAnalysis` 在保存时直接在 DB 中精确匹配对应 `COALESCE(attachment_version, 0)` 已有记录，实现幂等更新，彻底解决无版本分析二次保存触发唯一索引冲突问题。
  - 补充测试覆盖无版本分析连续多次保存与更新。
- **多主题批量采纳部分失败增量重试保留与前端生产函数直接行为测试** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html) & [`test/canvas-ui.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas-ui.test.mjs))：
  - `acceptAllAiSuggestions` 在处理多主题批量归类时，按主题逐一处理；仅在对应主题归类成功后才从该文献的建议列表中剔除该主题项；若部分主题失败，未完成的主题推荐项完好保留在内存中供用户随时一键重试。
  - 测试套件直接提取并执行 `index.html` 中的生产 `acceptAllAiSuggestions` 函数，模拟“主题 A 成功、主题 B 失败”断言未成功项精准保留。
- **全套验证通过**：
  - `npm test` 6 套测试全过，`git diff --check` 通过。

## 2026-08-31 会话（AI 自动提炼主题体系与收件箱 1-Click 阅读加固）

- **AI 自动提炼核心研究主题体系与归类闭环** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs) & [`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - 新增 `POST /canvas/inbox/generate-topics` 服务端接口：接收待分析文献集合，由 AI 自动提炼 3~6 个高度聚焦、非重叠的核心研究主题体系（严格限制数量防止碎片化），自动生成主题名称、研究问题、纳入与排除规则，并在 SQLite 中自动创建主题工作区。
  - 自动运行新主题下的文献智能归类与置信度推荐，实现“无需手动建主题，一键提炼体系 + 智能推荐分拣”。
  - 收件箱新增“✨ AI 提炼主题”按钮；在无任何主题时点击“✨ AI 智能分类”会自动联动触发主题提炼。
- **收件箱 1-Click 打开阅读与 PDF 状态明确化** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - 收件箱文献卡片新增“📖 阅读”操作按钮并支持直接点击标题打开阅读，自动关闭弹窗并无缝载入中心 PDF 阅读器。
  - 优化 PDF 阅读器占位态与错误呈现：条目未关联 PDF 或加载异常时，在阅读器中心渲染清晰的状态卡片与原因指引，彻底消除无错误提示的黑屏/空白感。
- **自动化测试覆盖** ([`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs) & [`test/canvas-ui.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas-ui.test.mjs))：
  - 增加 `POST /canvas/inbox/generate-topics` 主题生成、去重与文献推荐断言。
  - 增加收件箱“✨ AI 提炼主题”与“📖 阅读”UI 结构断言。
  - `npm test` 6 套测试全过，`git diff --check` 通过。

## 2026-08-31 会话（T3 阶段：跨报告观点关联与渐进展开及终审加固）

- **Schema v9 知识索引模型、inbox 附件版本持久化、真实 v7→v9 迁移保真与主键级精准回填** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs) & [`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs))：
  - 新增 `knowledge_units` 表（记录研报标题、页码范围、精确 `evidence_page`、逐字引用及位置）。
  - Schema 迁移在 v8/v9 中就地更新 `knowledge_units.evidence_page`（按图谱结构声明顺序以主键 `WHERE id = ?` 精准回填，消除同名标题覆盖歧义），升级 `knowledge_relations` 为带 `ON DELETE CASCADE` 的级联外键，并为 `inbox_entries` 增加 `attachment_version` 持久化列。测试套件添加了包含多条同名章节/论点在内的真实 v7→v9 升级保真断言。
- **真实同步/归类接入附件更新、分析状态失效与附件提取** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs) & [`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `normalizeZoteroItemToInboxEntry` 与 `inboxEntryInput` 完整提取并持久化 `attachmentKey` 与 `attachmentVersion`。
  - Collection 同步（`/collection-bindings/:id/sync`）与收件箱批量归类（`/inbox/batch-action`）全面接入 `syncTopicDocumentAttachment`；当检测到 PDF 附件发生变更或重新归类时，原子更新 `attachment_key` / `attachment_version`，并将旧的 `analysis_status` 自动重置为 `stale`（需重新分析），彻底杜绝新附件继续显示 ready 或绑定旧附件。
  - `listTopicKnowledgeUnits` 严格绑定 `(td.attachment_key IS NULL OR ku.attachment_key = td.attachment_key)`，自动排除旧附件历史分析。
- **展开接口真实单元强校验、focalUnit 严格校验、同报告伪关系拦截与审计级收起防护** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `/expand-related` 强制以 `unitId` 从 DB 查询且校验属于当前主题，彻底拦截伪造载荷，并在 provenance 事件中记录展开节点清单。
  - `/related-knowledge` 严格校验 `focalUnitId` 与 `focalDocument` 的所属关系与一致性，不符时直接以 400 阻断；在候选召回与关系保存两道防线彻底过滤同一文献内的伪“跨报告”关系。
  - `/collapse-related` 依靠 provenance 历史审计事件严格校验被删除节点必须为由 `/expand-related` 从该焦点节点实际展开生成的外部卡片，`focalNodeId` 必填，杜绝误删普通 AI 卡片、手写卡片或独立卡片。
- **证据页码保真与 PDF 原文精准定位** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs) & [`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - 知识单元索引完整记录 `evidencePage`，展开生成卡片时 `pageLabel` 精确指向逐字证据实际所在页。
- **自动化测试全覆盖** ([`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs) & [`test/canvas-ui.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas-ui.test.mjs))：
  - 覆盖真实 v7→v9 迁移关系保留与多同名标题精准回填、分析刷新外键安全、活跃主题文献更换附件旧分析失效与 analysis_status 标记 stale、组文库三元组隔离召回、伪造知识单元拦截、未连接卡片防收起、focalUnit 不符 400 拦截、同报告伪跨报告严格拦截、证据页码精准传递。
  - `npm test` 6 套测试全过，`git diff --check` 通过。

### 里程碑状态

| 里程碑 | 状态 | 说明 |
|---|---|---|
| Schema v11 数据模型 | **完成** | SQLite topic_documents, collection_bindings, inbox_entries (含 attachment_version 与 doi), jobs (含 payload_json), document_analyses, document_metas (含 doi), knowledge_units, knowledge_relations, edges (含 origin 与 projection_key) |
| T0 兼容性探针框架 | **就绪** | 增量 since、分页遍历、生命周期与版本化安全清理 |
| T0 真实 PDF 上传/回读实机闸门 | `IN_PROGRESS` | 等待专用存储适配探针闭环，Canvas PDF 拖入保持关闭 |
| T1 主题工作台与研究收件箱 | **PASS (关闭)** | 增量扫描、研究收件箱、批量多主题归类、Collection 绑定与全屏视图 |
| T2 AI 主题分类与体系提炼 | **PASS (关闭)** | AI 自动提炼 3~6 个核心主题体系、分类建议、一键采纳与分析跨主题复用 |
| 研报易读中文名与元数据识别 | **PASS (关闭)** | AI 提取机构/研报主标题/年份、SQLite document_metas、文库/收件箱易读中文名渲染与手动编辑 |
| T3 跨报告观点关联与渐进展开 | **PASS (关闭)** | 知识单元索引、跨报告关系发现（支持/冲突/拓展/情境差异）、安全渐进展开、真实单元核验与精确页码定位 |
| T4 Canvas 快速导入与 PDF 浮层 | `IN_PROGRESS` | 导入任务持久化/恢复重试机制、多源去重与逐跳重定向安全防护已闭环；等待 T0 真实 PDF 上传/远端 Altero 附件写入探针通过后关闭 |
| 全文理解画板上下文增强 | **PASS (关闭)** | 两阶段解耦架构，全局基础分析无板级偏向，Stage 2 专属关系推理排除自身节点并保护人工边，同文献重复分析原地更新防重叠 |
| 卡片紧凑高度与尺寸自适应 | **PASS (关闭)** | 服务端与前端估算基底紧凑化，双击 resize-handle 触发真实内容高度测量（`autoFitCanvasNodeHeight`）并持久化保存 |
| T5 可逆 AI 收缩 | `就绪 (待启动)` | 下一阶段目标 |

## 2026-09-01 会话（Edge 所有权生命周期隔离、内部人工边保护、冲突迁移 Manual 优先与 Schema v11 约束）

- **Edge 数据模型升级 Schema v11 与所有权隔离** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs) & [`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `edges` 表重构升级为 Schema v11，严格带入 SQLite `CHECK (origin IN ('manual', 'document_map_internal', 'document_map_context', 't3_expand', 'ai_synthesis'))` 约束与 `EDGE_ORIGINS` 白名单校验；
  - 覆盖所有 AI 写入路径：`createAiSynthesisNode` 标记为 `ai_synthesis`，`/expand-related` 标记为 `t3_expand`，document map 分别标记 `document_map_internal` 与 `document_map_context`；
  - **内部与外部人工边绝对保护**：重复理解时仅清理 `origin = 'document_map_internal'` 且匹配当前 `projection_key` 的内部 AI 边，用户手工在文档卡片之间建立的内部连线完整保留；遇到同签名关系时，严格保护 `manual` 边的 label、version 与 origin，禁止 AI 静默覆盖。
- **外部边迁移冲突 Manual-Wins 优先策略与完整行为级测试** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs) & [`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs))：
  - 当缩减旧节点触发外部边重定向迁移至 Overview 时，若目标位置已存在同签名边，实行 **Manual 绝对优先**：若迁移边为 `manual` 则自动替换/删除已有 AI 边，保留人工边的 ID、label、version（递增）并记录 `edge.retargeted` 审计事件；
  - 构造真实“旧 AI 卡片缩减软删除 + 内部人工边保护 + 迁移冲突 manual 获胜”场景进行行为级断言；
  - 包含真实的 Schema v10 → v11 存量数据库迁移断言（历史边自动继承 `origin: 'manual'`）。
- **全文理解两阶段解耦架构（Base Analysis vs. Board Contextual Inference）** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs) & [`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs))：
  - **Stage 1（纯净基础分析）**：AI 全文分块阅读与综合摘要 Prompt 仅输入 PDF 正文笔记，不掺入任何画板已有卡片；产出的 topic-agnostic base graph 存入全局 `document_analyses` 缓存（`promptVersion = 'altcanvas-document-map-v2'`），彻底杜绝全局缓存携带首个画板的语义偏向；
  - **Stage 2（画板级专属关系推理与同报告自关联排除）**：无论是新生成分析还是跨主题缓存命中，Stage 2 严格过滤掉当前被分析文献自己的所有节点（`focalSourceRefs`），仅针对真正的外部已有卡片进行轻量关系推理，彻底杜绝同报告伪跨卡片关系；
  - **画板边落库幂等去重**：向 SQLite `edges` 表插入 Stage 2 关系前执行全库签名去重（`(board, source, target, relation)`），重复理解同一文献不会累积重复外部关系边；
  - 前端 `index.html` 针对 `cached && !alreadyOnBoard` 自动发起免提取正文的缓存投影调用，针对 `cached && alreadyOnBoard` 触发分析刷新。
- **导入任务文库身份持久化与进程级安全恢复** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs) & [`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs))：
  - 入队时将服务端确认的 `libraryType: 'user'` 与 `libraryId: actor.session.userId` 写入 `payload`；
  - `executeImportJob` 严格校验 payload 中的文库身份，缺失时抛出异常并标记 `failed`，禁止回退到错误的文库 `'0'`；
  - 启动时通过 `recoverQueuedAndRunningJobs` 自动拉起冷启动未完任务，基于 Job ID 生成确定性 `IMP_<hash>` 保持重试幂等；`updateJobState` 支持显式 `errorCode: null` 清除错误。
- **SSRF 真实连接固定 IP 防御（彻底封堵 DNS Rebinding 与移除未固定 fallback）** ([`server/import-resolver.mjs`](file:///home/sadgen/Projects/AltCanvas/server/import-resolver.mjs) & [`test/bff.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/bff.test.mjs))：
  - 移除了所有未固定 IP 的 fallback 分支，`safeFetchText` 仅允许直连经 `validateExternalUrl` 验证的公网 IP 列表，逐个尝试直连失败则明确报错；
  - 严格保持 TLS SNI 和证书校验为原始 `hostname`；逐跳重定向严格重复 DNS 校验与固定连接；测试通过 `transportFn` 注入隔离，绝不降级至常规公网请求。
- **DOI 全链路持久化与多源检索** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs) & [`server/import-resolver.mjs`](file:///home/sadgen/Projects/AltCanvas/server/import-resolver.mjs))：
  - `inbox_entries` 与 `document_metas` 的读写与 row 映射完整覆盖 `doi` 列；`findDuplicateCandidates` 基于 `doi` 列实现精确去重匹配。
- **自动化测试全覆盖** ([`test/bff.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/bff.test.mjs), [`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs), [`test/canvas-ui.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas-ui.test.mjs))：
  - 覆盖 v10→v11 真实存量数据库升级断言、内部与外部人工边保护断言、冲突迁移 manual 优先断言、缩减旧节点外部边迁移至 Overview 与自环消除断言、冷启动无 Session 任务恢复与文库 ID 保真断言、全局分析无 existing 关系断言、Stage 2 画板专属关系生成与同一画板连续理解外部边不增加断言、免 pages 缓存跨板投影断言、DOI 列落库与多源去重断言、`autoFitCanvasNodeHeight` 真实函数 DOM 测量调整断言；
  - `npm test` 六套测试全部通过，`git diff --check` 通过。

## 2026-09-01 会话（T4 阶段：Canvas 快速导入与 PDF 引用浮层核验）

- **SSRF 安全防护与 DOI/arXiv/URL 元数据解析** ([`server/import-resolver.mjs`](file:///home/sadgen/Projects/AltCanvas/server/import-resolver.mjs))：
  - `validateExternalUrl` 严格限制只允许 `http:` / `https:` 协议，禁止内嵌账号密码，通过真实 DNS 解析彻底拦截所有私网 IPv4/IPv6、回环地址（127.0.0.1、::1、localhost）与内部域名（.local、.internal、.lan）。
  - 支持标准 DOI 解析（Crossref CSL-JSON）、arXiv 论文编号解析（Atom XML + PDF 候选链接识别）及通用学术期刊网页元数据提取（`<meta name="citation_...">`）。
  - `findDuplicateCandidates` 结合 DOI 与标题模糊匹配进行全库去重检测，标明重复来源。
- **可恢复导入任务 API 体系** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - 新增 `POST /canvas/imports/resolve`：安全校验输入并返回解析结果与去重候选；
  - 新增 `POST /canvas/imports`：使用 SQLite `jobs` 表（`job_type: 'import_document'`）创建可恢复任务，持久化生成 `inbox_entries`（`detected_from: 'import'`）并可选原子绑定当前主题 `topic_documents`；
  - 新增 `GET /canvas/imports/:id` 与 `POST /canvas/imports/:id/retry`：提供任务状态查询与失败幂等重试机制。
- **Canvas 原位证据核验浮层与快速导入前端交互** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
  - 画板卡片提供 `[🔍 核验]` 按钮，原位唤起 `#canvas-evidence-popover` 浮层，展示规范研报中文名、页码标签及逐字证据，支持 `[完整阅读 ↗]` 平滑切入中央 Reader 精准高亮，支持按 `Esc` 快速退出；
  - 画板与收件箱顶栏提供 `[📥 快速导入]` 按钮，支持输入 DOI/URL 在线解析并给出去重警告，一键导入至当前主题或收件箱。
- **自动化测试全覆盖** ([`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs) & [`test/canvas-ui.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas-ui.test.mjs))：
  - 覆盖私网 IP / localhost / 伪协议 SSRF 拒绝测试；
  - 覆盖 DOI、arXiv 及学术网页元数据解析单元测试；
  - 覆盖全库重复文献模糊检测测试；
  - 覆盖 `/canvas/imports/resolve`、`/canvas/imports`、状态查询与 job 重试 HTTP API 测试；
  - 覆盖浮层与导入模态框 DOM 结构与函数绑定断言；
  - `npm test` 6 套测试全过，`git diff --check` 通过。

## 2026-09-01 会话（AI 分类同步生成中文名与左侧双 Tab 主题 PDF 导航）

- AI 收件箱分类与 AI 自动提炼主题的单次模型响应现在同时包含 `documentMetadata`；服务端在
  同一请求内保存规范中文名、机构、中文主标题、年份与摘要，不再为中文名额外发起第二次
  模型调用。手工编辑且 `source=manual` 的元数据受保护，不会被后续分类覆盖。
- 两类接口都返回已保存的 `documentMetas`，前端立即写入复合键缓存并刷新收件箱标题；提示
  中分别显示主题推荐数与中文名生成数。
- 左侧研究文库升级为“文库 / 主题分类”两个并列 Tab。主题分类 Tab 与当前 Canvas 主题同步，
  可选择研究主题，并逐条核验父条目的子附件，只显示实际含 `application/pdf` 附件的主题文献；
  点击后直接在中央 Reader 打开。
- 自动化补充单次分类同时持久化中文名、自动建主题同时返回中文名及双 Tab/PDF 筛选结构断言。
  `npm test` 六套全过，`git diff --check` 通过；本地浏览器已验证 Tab 横向布局、切换状态和
  无控制台错误。
- 待用户登录真实 Altero/AI 环境做最小实机验收：选择少量收件箱文献运行 AI 分类，确认中文
  名即时出现；采纳建议后切到左侧“主题分类”，选择主题并打开其中一篇 PDF。
- 用户完成实机操作后检查 `.debug/dev.log` 与 `.debug/browser.log`：未发现新的浏览器运行时错误
  或失败请求；服务端仅有刷新/连接关闭产生的 `ECONNRESET`，不属于功能故障。
- 收件箱弹窗限制在当前视口内，标题、筛选和底部批量操作固定，仅中间文献列表独立纵向滚动；
  移动端改为不超过 `92dvh` 的底部面板。720px 高视口实测面板 688px、滚动区 542px，底部按钮
  始终可见，浏览器告警/错误日志为空。
- 收件箱新增“重新处理”：可把已采纳、暂缓或忽略的条目恢复为“待处理”，重新执行 AI 分类；
  该操作刻意保留现有主题归属，避免误删研究组织结果。真正撤销归类需在主题文献管理中显式
  “移出”。服务端、单条/批量 UI 及“重开后主题成员关系不变”测试均已补齐。
- `npm test` 六套全过，`git diff --check` 通过；8099 本地开发服务已重启并加载最新接口代码。

## 2026-09-01 会话（T3 跨报告关联与附件安全终审加固）

- **子附件异常显式传播与版本中断保护** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `resolveItemAttachment` 移除静默 `try/catch` 与 JSON 空兜底；当上游 Altero `/children` 返回 500/非 200 响应、非法 JSON 或网络错误时，显式抛出异常中断扫描或同步，杜绝静默吞掉异常并错误推进 `Last-Modified-Version`。
- **严格 PDF 附件类型过滤** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `normalizeZoteroItemToInboxEntry` 与 `resolveItemAttachment` 严格限定仅匹配 `application/pdf` 或 `.pdf` 后缀的附件，移除对任意非 PDF 附件（图片、HTML 快照、文档等）的 fallback 绑定，无 PDF 附件时保持 `attachmentKey = null`。
- **focalUnit 限定当前主题活跃单元校验** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `/canvas/workspaces/:id/related-knowledge` 强制通过 `listTopicKnowledgeUnits(actorKey, workspaceId)` 校验 `focalUnitId` 必须属于当前主题且为当前最新活跃分析的知识单元，彻底拦截跨主题越权单元与旧附件陈旧单元（`400 Bad Request`）。
- **收件箱条目输入附件原子对与 Metadata-Only 保真** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
  - `inboxEntryInput` 严格区分“省略字段”（保留 `undefined`，不覆盖已有附件）与“显式解绑”（必须 `attachmentKey` 和 `attachmentVersion` 同时为 `null`）；
  - 严禁单传 `attachmentKey` 或单传 `attachmentVersion` 的不完整组合（直接抛出 `TypeError` 拒绝，返回 400 Bad Request）；
  - 对已有文献执行仅更新标题/标签的 metadata-only upsert 时，`store.upsertInboxEntries` 100% 完整保留原绑定的 `attachmentKey` 和 `attachmentVersion` 原子对。
- **自动化回归测试补齐** ([`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs))：
  - 新增上游 `/children` 返回 500 异常中断测试；
  - 新增上游 `/children` 返回非法 JSON 异常中断测试；
  - 新增仅含非 PDF 附件条目不绑定 `attachmentKey` 隔离测试；
  - 新增跨主题 Workspace `focalUnitId` 拦截测试；
  - 新增已失效/陈旧旧附件分析 `focalUnitId` 拦截测试；
  - 新增已有附件条目在 metadata-only HTTP upsert 期间附件 key/version 完整保持不变测试；
  - 新增不完整单字段附件输入（单传 key 或单传 version）HTTP 400 校验测试；
  - 新增双 null 显式解绑 HTTP upsert 测试。
  - `npm test` 6 套测试全过，`git diff --check` 通过。
