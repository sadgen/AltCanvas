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

## 2026-09-01 会话（Native 架构迁移与 M1 原生 PDF 最小闭环交付）

### 迁移起点与基线建立

1. **安全整理工作区与 .gitignore 排除**：
   - 检查工作区所有未提交改动并核验健康状态；
   - 更新 `.gitignore`，安全排除 `ai-settings.key`、`.mimosa/`、`.zcode/`、`data/`、`.debug/` 等敏感凭据、运行数据库与辅助工具目录；
   - 验证 `npm test` 6 套测试与 `git diff --check` 100% 通过。
2. **基线分支建立**（`codex/pre-native-baseline`）：
   - 将现有主题工作台、收件箱、导入解析、探针加固、UI 改造、自动化测试及交接文档拆分为 6 个清晰可审阅的提交（`39dd9a3`, `9e7fe37`, `f1fb7b6`, `ab13f6c`, `e2206e1`, `c677c29`）。
3. **Native Worktree 建立**：
   - 路径：`/home/sadgen/Projects/AltCanvas-native`；
   - 分支：`codex/native-library-core`；
   - 拥有完全独立的 SQLite 数据库、`data/blobs` 存储目录、AI 密钥与运行日志。

---

### M1 原生数据模型与核心功能实现

#### 1. Schema v10 Native 数据模型 ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas-native/server/canvas-store.mjs))
- **`users`**：本地账号体系（`id`, `username`, `password_hash`, `password_salt`, `role`, `created_at`, `updated_at`），采用 `crypto.scryptSync`（带 16 字节随机盐值）及常量时间对比；
- **`blobs`**：不可变文件哈希存储（`sha256`, `relative_path`, `size_bytes`, `mime_type`, `created_at`, `reference_count`）；
- **`documents`**：原生文献核心实体（`id`, `owner_key`, `item_type`, `title`, `abstract`, `publication_title`, `publisher`, `date`, `year`, `doi`, `isbn`, `url`, `language`, `rights`, `extra_json`, `version`, `created_at`, `updated_at`, `deleted_at`）；
- **`document_creators`**：按顺序持久化作者（`id`, `document_id`, `position`, `creator_type`, `first_name`, `last_name`, `name`）；
- **`attachments`**：文献附件（`id`, `document_id`, `blob_hash`, `mime_type`, `original_filename`, `title`, `source_url`, `size_bytes`, `page_count`, `version`, `created_at`, `updated_at`, `deleted_at`）；
- **`annotations`**：原生批注（`id`, `attachment_id`, `annotation_type`, `page_label`, `position_json`, `quote`, `comment`, `color`, `sort_index`, `version`, `created_at`, `updated_at`, `deleted_at`）；
- **`external_refs`**：外部数据源映射（`id`, `owner_key`, `document_id`, `provider`, `external_library_id`, `external_item_id`, `external_attachment_id`, `external_version`, `source_url`, `imported_at`）；
- **`import_jobs`**：规范化导入任务记录（`id`, `owner_key`, `source_type`, `state`, `total_count`, `completed_count`, `failed_count`, `report_json`, `created_at`, `completed_at`）；
- 全面升级 `source_refs`、`topic_documents`、`inbox_entries`、`document_analyses`、`document_metas` 与 `knowledge_units`，允许 `'native'` 类型的文库及 `'native_upload'` 来源。

#### 2. 原生本地认证模式 ([`server/auth.mjs`](file:///home/sadgen/Projects/AltCanvas-native/server/auth.mjs) & [`scripts/dev-server.mjs`](file:///home/sadgen/Projects/AltCanvas-native/scripts/dev-server.mjs))
- 智能模式切换：`AUTH_MODE=local` 为 Native 默认（未配置 Altero 时自动为 `local`，同时保留 `AUTH_MODE=altero` 兼容模式）；
- 首次管理员初始化：`POST /auth/setup`（仅在全库无用户时允许，创建管理员并签发会话）；
- 本地密码登录：`POST /auth/login`（安全哈希校验，签发 HttpOnly、SameSite=Lax 安全 Cookie）；
- 会话状态感知：`GET /auth/session` 返回 `needsSetup`、`authMode` 与用户信息；
- `POST /auth/logout` 清除会话与 Cookie。

#### 3. 原生 PDF 上传与哈希去重存储 ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas-native/server/canvas-api.mjs))
- `POST /canvas/native/upload`：
  - 流式写入临时目录（`data/tmp/`，0600 权限），内存零聚合；
  - 校验 `%PDF-` 魔法文件头，非 PDF 即刻拦截（400 Bad Request）并清理临时文件；
  - 文件大小上限限制（100 MiB），超限即刻拒绝（413 Payload Too Large）；
  - 流式计算 SHA-256 哈希，相同内容自动复用 Blob 记录并递增引用计数；
  - 新 Blob 原子移动至 `data/blobs/sha256/ab/cd/<hash>.pdf`，严格服务端路径计算；
  - 自动去重检查：同一用户已存在该 PDF 时提示已存在（返回已有文档与附件）；
  - 自动创建 `documents`、`attachments`、`inbox_entries`，并支持可选直接关联至研究主题 `topic_documents`。

## 2026-09-01 会话（M1.5 Native Core Integration 合流与解除 Altero 依赖验收）

### 合流概述与架构统一

在 `codex/pre-native-baseline`（含 T1–T4、Stage 1/2、Edge ownership、SSRF、DOI）与 `codex/native-library-core`（Native 本地认证、PDF 上传、Blob 去重、Range 传输、原生批注）之间完成 **M1.5 Native Core Integration**，合流至 `codex/native-integration`。

### 核心成果与实现要点

1. **Schema v12 谱系汇合与能力探测幂等迁移** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs))：
   - 保留共同历史 v1–v9，保持当前线 v10（jobs.payload_json, DOI）与 v11（Edge ownership CHECK 约束与 projection_key）；
   - Native 核心数据模型（`users`, `blobs`, `documents`, `document_creators`, `attachments`, `annotations`, `external_refs`, `import_jobs`）统一迁入 Schema v12；
   - 引入动态能力探测函数（`ensureCurrentV10Features`、`ensureEdgeV11Features`、`ensureNativeCoreTables`、`ensureNativeLibraryTypeSupport`、`ensureNativeIndexes`），无论是 Fresh DB、Current v11 DB 还是 Native v10 DB，均能在单一事务中安全升级至 v12 并保持幂等；
   - 升级 `source_refs`、`topic_documents`、`inbox_entries`、`document_analyses`、`document_metas` 与 `knowledge_units`，全面支持 `library_type = 'native'` 与 `origin = 'native_upload'`。

2. **后端运行时解耦与统一能力模型** ([`server/auth.mjs`](file:///home/sadgen/Projects/AltCanvas/server/auth.mjs) & [`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
   - 默认认证模式为 Native 本地认证（未配置 `AUTH_MODE` 时默认为 `local`，显式 `AUTH_MODE=altero` 时启用 Altero 兼容）；
   - 会话统一返回 `capabilities` 对象（`nativeUpload: true`, `collections: isAltero`, `upstreamSync: isAltero`, `externalLibrary: isAltero`）；
   - 清除所有无条件 Altero 请求，Altero 扫描与 Collection 同步在 Native 模式下安全降级与拦截，不产生任何网络异常。

3. **前端工作流统一** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
   - 提供标准化的 `openDocument(identity)` 统一入口，支持按 `libraryType`（`native` vs `user`/`group`）分派至 Native 或 Altero 适配链路；
   - 保留 `resetCurrentDocumentState()` 原子状态重置，在切换文献或加载失败时彻底清理 reader、批注、缓存与 UI 状态；
   - 同一 Native 文献可关联至多个研究主题，底层 PDF Blob 零冗余；AI 全文分析结果在不同主题画板间实现零大模型调用的跨板复用。

4. **全套 7 套自动化测试通过**：
   - BFF Unit Tests（通过）；
   - BFF Flow Integration Tests（通过）；
   - Server-side AI Provider Security Tests（通过）；
   - Canvas Persistence & API Tests（含 Fresh/Current-v11/Native-v10/Idempotency 四大谱系迁移测试，通过）；
   - Canvas UI Structure Tests（通过）；
   - Dev Logger Tests（通过）；
   - Native M1 Minimal Loop & Audit Regression Tests（含多主题关联与全文分析跨板复用断言，通过）。
   - `git diff --check` 100% 通过。

### 里程碑最新状态表

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M1.5 Native Core Integration | **PASS (完成)** | Schema v12 谱系汇合、Native 为默认核心、Altero 解耦为可选 Provider、7 套测试全过 |
| Schema v12 数据模型 | **完成** | 涵盖 users, blobs, documents, attachments, annotations, topic_documents, inbox_entries, jobs, analyses, metas, knowledge_units/relations, edges (origin/projection_key) |
| Native 本地认证与会话 | **PASS (关闭)** | 默认 local 模式，管理员首次 setup，密码登录，capabilities 能力驱动 |
| Native PDF 上传与哈希去重 | **PASS (关闭)** | 流式上传、%PDF- 校验、100MB 限制、SHA-256 去重与安全事务写入 |
| Native HTTP Range 服务与 Reader | **PASS (关闭)** | 200/206/304/416 范围读取、原生批注 CRUD/412 冲突/软删除恢复 |
| 全文理解画板上下文增强 | **PASS (关闭)** | Stage 1 基础分析全局缓存，Stage 2 画板关系推理，Native 文献跨主题零调用复用 |
| T1 主题工作台与研究收件箱 | **PASS (关闭)** | 增量扫描、研究收件箱、多主题归类、Collection 绑定与全屏视图 |
| T2 AI 主题分类与体系提炼 | **PASS (关闭)** | AI 自动提炼核心主题体系、分类建议、一键采纳与分析跨主题复用 |
| 研报易读中文名与元数据识别 | **PASS (关闭)** | AI 提取机构/研报主标题/年份、document_metas、易读中文名渲染与编辑 |
| T3 跨报告观点关联与渐进展开 | **PASS (关闭)** | 知识单元索引、跨报告关系发现、安全渐进展开、真实单元核验与精确页码定位 |
| T4 Canvas 快速导入与 PDF 浮层 | **PASS (关闭)** | 导入任务持久化/恢复重试机制、多源去重与逐跳重定向 SSRF 安全防护 |
| M2 统一 Native 导入管线 | `就绪 (待启动)` | 下一阶段目标：统一快速导入与多源文档至 Native documents/attachments |
| M4 Altero/Zotero 一次性迁移器 | `就绪 (待启动)` | 历史 Altero 数据至 Native 本地文库的幂等无损迁移 |


#### 4. 原生 HTTP Range PDF 文件流服务 ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas-native/server/canvas-api.mjs))
- `GET /canvas/native/attachments/:id/file` 与 `HEAD /canvas/native/attachments/:id/file`：
  - 严格所有权核验（`owner_key` 隔离，跨用户访问返回 404）；
  - 完整内容：`200 OK`，附带 `Content-Length`, `Accept-Ranges: bytes`, `ETag: W/"<sha256>"`, `Content-Type: application/pdf`；
  - 缓存协商：`If-None-Match` 命中即刻返回 `304 Not Modified`；
  - 范围读取：正确解析 `bytes=start-end`, `bytes=start-`, `bytes=-suffix`，返回 `206 Partial Content` 与精确的 `Content-Range: bytes start-end/total`；
  - 越界范围拦截：返回 `416 Range Not Satisfiable` 与 `Content-Range: bytes */total`。

#### 5. 原生批注持久化与 Reader 闭环 ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas-native/server/canvas-api.mjs) & [`index.html`](file:///home/sadgen/Projects/AltCanvas-native/index.html))
- 批注接口体系：
  - `GET /canvas/native/attachments/:id/annotations`：拉取批注列表；
  - `POST /canvas/native/attachments/:id/annotations`：创建高亮批注；
  - `PATCH /canvas/native/annotations/:id`：修改批注/评论/颜色，强制 `If-Match: W/"<version>"` 乐观并发控制（冲突返回 412）；
  - `DELETE /canvas/native/annotations/:id`：软删除批注，强制 `If-Match`；
  - `POST /canvas/native/annotations/:id/restore`：恢复批注。
- Reader 前端无缝适配：
  - 原生 PDF 直接使用 `/canvas/native/attachments/:id/file` 供 Reader 渲染；
  - 批注增删改查透明路由至 Native 批注 API；
  - 支持划线自动 AI 翻译写回 comment；
  - 支持 Canvas 证据卡片原位跳转与“证据转正式批注”；
  - 支持基于原生 PDF 的“理解全文”AI 图谱生成（`/canvas/boards/:id/ai/document-map`），图谱节点直接锚定原生文献与页码。

---

### M1 验收与测试结果

#### 自动化测试覆盖 ([`test/native-m1.test.mjs`](file:///home/sadgen/Projects/AltCanvas-native/test/native-m1.test.mjs))
- ✅ 1. 无 Altero 环境变量时默认启动为 `AUTH_MODE=local`；
- ✅ 2. [P0 回归] `AUTH_MODE=altero` 模式下直接请求 `/auth/setup` 与 `POST /auth/login` 严格被 403 阻断（`local_auth_disabled`）；
- ✅ 3. 空库检测 `needsSetup: true`，弱密码拦截，首个管理员创建成功，二次 Setup 400 阻断；
- ✅ 4. 密码错误 401 拦截，正确密码登录成功，会话 Cookie 签发，登出使会话失效；
- ✅ 5. 非 PDF 文件上传拦截（400 Bad Request），合法 PDF 流式上传并入库；
- ✅ 6. 校验 `data/blobs/sha256/` 目录结构与 0600 文件权限，字节逐位比对完全一致；
- ✅ 7. [P1 回归] 同一用户重复上传相同 PDF，去重且绝不虚增 `reference_count`（保持精准为 1）；
- ✅ 8. [P1 回归] `updateDocument` 更新作者列表成功（彻底修复 `docId` 未定义引用异常）；
- ✅ 9. [P1 回归] 删除文献/附件原子扣减对应 Blob 的 `reference_count`；
- ✅ 10. HTTP Range 测试：200 全量流、HEAD 零 body、304 If-None-Match、206 `bytes=0-100`、206 `bytes=100-`、206 `bytes=-50` 后缀、416 越界 Range；
- ✅ 11. 跨用户数据隔离：User B 访问 User A 的文档、附件文件、批注均严格返回 404；
- ✅ 12. 原生批注生命周期：创建、读取、PATCH 428/412 并发控制、修改成功、DELETE、[P2 回归] RESTORE 强制校验 If-Match（缺失返回 428，陈旧返回 412）；
- ✅ 13. [P0 回归] `openItem` 与 `initReaderEngine` 彻底消除对 `libraryApiPrefix` 的无条件前置调用，仅在 Zotero/Altero 路径计算代理前缀，Native 模式完全不调用 `libraryApiPrefix`，彻底阻断 P0 打开报错；
- ✅ 14. [P0 回归] `openNativeDocument` 修正为调用 `openItem`，构造标准原生文献与附件嵌套结构（`children: [attData]`），上传成功与查重命中后均可无缝直接进入中央 Reader；
- ✅ 15. [P1 回归] `reloadAndSyncReaderAnnotations` 请求失败时抛错保留当前批注状态（绝不误清空），并增加 `currentAttachment` 切换竞态保护（防止旧批注写回新文献 Reader）；
- ✅ 16. [P1 回归] `importNativeUploadedDocument` 在重复上传命中查重时幂等执行目标主题关联，支持多主题跨上传归类，并在响应中返回 `topicDocument`；
- ✅ 17. [P2 回归] `streamUploadToFile` 安全解码 `x-filename`（防畸变编码崩溃），并在 `safeWrite` 背压等待触发 `close` 时明确 reject，杜绝写入提前终止被误判为成功；
- ✅ 18. [P1 回归] `streamUploadToFile` 引入显式 `--boundary--` 关闭状态机解析与 64KB 字段上限，在 EOF 时强制校验 `sawClosingBoundary === true`，彻底拦截缺少最终关闭符、残缺 Header 或未闭合字段的各类截断请求（返回 400 Bad Request 并清理临时文件）；
- ✅ 19. [P1 回归] `openItem` 统一通过 `resetCurrentDocumentState()` 在失败或无附件时原子重置 `currentDocumentLibrary`、`currentItem`、`currentAttachment`、批注映射及侧栏状态，杜绝跨文献残留混合；
- ✅ 20. [P1 回归] 上传事务失败补偿：若因非法主题或其他 DB 异常导致事务失败，自动回滚并删除新移动的 Blob 文件，杜绝孤儿文件残留；
- ✅ 21. 全文 AI 图谱（`document-map`）基于原生 PDF 成功生成并实例化画板节点；
- ✅ 22. 数据库关闭并重开后，用户、文献、附件、Blob、批注数据 100% 保真恢复。

**完整测试套件运行**：
`npm test`（7 套测试全部通过）：
- `test/bff.test.mjs` - PASS
- `test/bff-flow.test.mjs` - PASS
- `test/ai-provider.test.mjs` - PASS
- `test/canvas.test.mjs` - PASS
- `test/canvas-ui.test.mjs` - PASS
- `test/dev-logger.test.mjs` - PASS
- `test/native-m1.test.mjs` - PASS
- `git diff --check` - PASS

## 2026-09-02 会话（M2 统一 Native 导入管线实施）

### M2 原生导入管线成果

1. **规范化输入对象模型与多级去重链** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs))：
   - 实现 `importNativeDocument`，接收多源标准化元数据对象（`sourceType`, `title`, `abstract`, `creators`, `year`, `doi`, `url`, `isbn`, `arxivId`, `attachment`, `externalRefs`, `targetWorkspaceId`）；
   - **严格去重优先级链**：
     1. PDF SHA-256 Blob 哈希匹配；
     2. 规范化 DOI（大小写无关、前缀过滤）精确匹配；
     3. `external_refs` 外部提供方（DOI, arXiv, Semantic Scholar 等）精确匹配；
     4. ISBN / arXiv ID 精确匹配；
     5. 标题 + 年份模糊候选匹配。
   - **模糊匹配确认策略**：模糊匹配**绝不静默合并**，返回 `outcome: 'requires_confirmation'` 与候选列表，必须由前端或调用方显式传递 `confirmFuzzy: true` 后才创建新条目。
   - **精确命中属性回填**：精确命中已有文献时，新导入的信息仅回填既有文档缺失的 `doi`, `isbn`, `url`, `abstract`, `year`, `creators` 等字段，既有非空属性保持稳定。

2. **外部标识映射与收件箱/主题自动关联** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs))：
   - 自动在 `external_refs` 表中为导入条目建立跨源映射记录，以 `(owner_key, provider, COALESCE(external_library_id, ''), external_item_id)` 形成联合唯一身份，支持用户文库与群组文库相同条目 key 的严格跨库隔离；
   - 精确命中多条冲突标识时（例如 DOI 指向 Doc A，外部 Ref 指向 Doc B）拒绝静默合并，返回 `conflicting_identities`；
   - 自动生成对应 `inbox_entries`（`detected_from = 'import:<sourceType>'`, `library_type = 'native'`, `library_id = 'local'`）；
   - 提供 `targetWorkspaceId` 时原子创建 `topic_documents`（`status = 'accepted'`, `origin = 'canvas_import'`）。

3. **批量导入与任务系统（`import_jobs`）整合** ([`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs) & [`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
   - 新增 `POST /canvas/imports/native`：单篇文献导入，支持安全两阶段 PDF 下载（SSRF 防御、临时文件、0600 权限、SHA-256 去重与失败清理补偿）及 409 确认闭环；
   - 新增 `POST /canvas/imports/native/batch`：支持至多 100 条批量导入任务，前置校验全部条目结构避免遗留孤儿 pending 任务；
   - 批量任务状态流转严格遵循 `pending` → `running`（逐项追加报告和计数） → `finalizeImportJob`（`completed` / `completed_with_errors` / `cancelled`）；
   - 新增 `GET /canvas/import-jobs/:id`、`POST /canvas/import-jobs/:id/cancel` 及 `GET /canvas/import-jobs` 列表接口。

4. **前端快速导入交互对接** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
   - 快速导入模态框全面切换至 `/canvas/imports/native`；
   - 支持遇到 409 `duplicate_confirmation_required` 时的浏览器确认弹窗交互；
   - 导入后自动触发 Native 文库与收件箱的视图刷新。

5. **自动化测试** ([`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs))：
   - 包含 DOI 重用与回填测试、external_refs 重用测试、arXiv ID 匹配测试、模糊候选拦截与 confirmFuzzy 测试；
   - 包含单条与批量导入 HTTP API 测试、部分失败状态 `completed_with_errors` 报告测试、取消任务测试及任务列表测试。
   - `npm test` 7 套测试全过，`git diff --check` 通过。

---

### 里程碑状态

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M1 原生 PDF 基础单文献闭环 | **PASS (完成)** | 独立 local 认证、原生流式上传、去重、Range 文件流服务、Reader 批注持久化、全文理解与证据转批注 |
| M1.5 Native Core Integration | **PASS (关闭)** | 主线与 Native 核心全量合流，Schema v12 双谱系幂等迁移，Native 确立为默认核心，Altero 降级为可选 Provider |
| M2 统一导入管线 | **PASS (完成)** | 规范化多源导入（DOI/arXiv/URL/PDF/RIS/BibTeX/批量）、优先级去重链、模糊防静默合并、import_jobs 逐项报告与 Native 写入 |
| M3.0 登录后应用初始化修复 | **PASS (关闭)** | 消除页面刷新依赖，统一 initializeAuthenticatedApp 入口与并发锁，全面清除遗留 OIDC 文案 |
| M3.1 Translation Server 安全适配层 | **PASS (关闭)** | 仅服务端配置、loopback/unix/SSRF 远程门控、无重定向、全链路三层超时生命周期、Keep-Alive 连接复用、双向 DNS 固定、集合上限与纯解析 DTO |
| M3.2 统一解析与导入工作流 | **PASS (完成)** | 格式自动探测、Translation Server 管道打通（BibTeX/RIS）、M2 执行器全链路复用、前端快速导入多模态解析 |
| M4 Altero/Zotero 外部迁移器 | `就绪 (待启动)` | 幂等一次性迁移 |
| M5 AltCanvas Capture 浏览器扩展 | `PENDING` | 独立扩展仓库 |
| M6 默认解除 Altero 依赖 | `PENDING` | 默认部署全面切换为 Native |

## 2026-09-02 会话（M2 终审 P1 整改：任务状态机、外部引用文库维度、冲突闭环、PDF 管线与前端修复）

### 修复清单

1. **[P1] 批量任务真实状态机**：批量入口改用 `updateImportJob`（`import_jobs` 表）在启动时置 `running`；`appendImportJobItemReport` 仅累计报告与计数、保持 `running`；全部处理完由 `finalizeImportJob` 统一落 `completed` / `completed_with_errors` 并记录 `completedAt`。
2. **[P1] external_refs 写入文库维度**：`getExternalRef` 升级为 `(owner, provider, COALESCE(external_library_id,''), external_item_id)` 联合身份；`importNativeDocument` 回填阶段传入 `externalLibraryId`，群组文库引用可持久化并在后续导入正确复用。
3. **[P1] 冲突 HTTP 闭环**：单篇接口对 `conflicting_identities` 返回 `409 identity_conflict` + 结构化冲突文献列表；批量报告持久化 `conflicts` / `candidates` 字段。
4. **[P1] PDF 下载失败语义**：显式 `body.pdfUrl` 失败直接失败（`pdf_download_failed`）；解析器推导 pdfUrl 失败降级为仅元数据导入并返回显式 `warning`。
5. **[P1] 孤儿 Blob 消除**：PDF 下载至 `tmp` 后延迟到 DB 写入确认才移动至永久 Blob 目录；`requires_confirmation` / `conflicting_identities` / 异常路径统一清理临时文件。
6. **[P1] Native 文库全量分页**：`loadNativeLibrary` 以 `limit=100&offset=` 循环分页拉取全部文献（100 页安全上限），不再静默截断为前 50 篇。
7. **[P1] 证据浮层崩溃修复**：`openQuickEvidencePopover` 移除未定义 `getCachedDocumentMeta`，改用 `documentMetas.get(docMetaKey(...))`，并新增生产行为测试。
8. **[P2]**：`getNativeLibraryItem` 按需加载后写回 `allItems` 缓存；文库条目标题/元数据弹窗/AI 元数据提取的文库解析改为 `isNative → native/local` 优先；批量条目前置校验覆盖 title/abstract/creators/externalRefs 完整合法性；8088 收敛为单一守护实例。

### 测试新增
- 批量状态机：逐项后保持 `running`、`completedAt` 为空、finalize 终态、终态后取消为 no-op；
- 冲突闭环：单篇 409 `identity_conflict`、批量结构化 conflicts 报告；
- PDF 管线：显式失败 502 不建文档、推导降级 201 + warning、SHA-256 二次导入复用；
- 写入路径：群组 external ref 二次导入通过持久化引用复用；
- UI：分页参数断言、`getCachedDocumentMeta` 绝迹断言、证据浮层行为测试。
- `npm test` 7 套全过；`git diff --check` 通过。

---

## 2026-09-02 会话（M2 终审二轮整改：Blob/DB 安全时序、统一批量执行器与前端加固）

### 修复清单

1. **[P1] Blob/DB 提交安全时序**：抽出只读 `precheckNativeDocumentImport`；执行时序改为 解析 → 安全下载 → 去重/冲突预检（零写入）→ 排他原子提升文件至内容寻址路径 → 事务化写库；DB 失败时仅删除本次新建且无库引用的文件；写时决策与预检分叉（并发竞争）同样触发补偿；新增启动时 `recoverBlobConsistency` 双向扫描（悬挂数据库附件软删除、幽灵 blob 置零/清除、孤儿文件删除，幂等）。
2. **[P1] 批量统一执行器**：新增 `executeNativeImportItem` 供单篇与批量共用，覆盖解析、PDF 安全下载（显式失败致命/推导降级告警）、哈希去重、冲突/确认、Blob 提升、DB 写入与双向补偿、warning 与结构化报告；批量项现支持 `pdfUrl` 全量 PDF 管线。
3. **[P2] 分页安全上限**：`loadNativeLibrary` 在满页触达 100 页上限时抛错并拒绝用截断结果覆盖 `allItems`（真实 100+100+1 多页测试与上限抛错测试均已覆盖）。
4. **[P2] 主题文献标题**：改为按文献复合身份在 `allItems` 匹配并回退 `documentMetas`，不再依赖 `currentDocumentLibrary`。
5. **[P2] 统一输入规范化器**：`normalizeNativeImportItem` 作为单篇/批量唯一输入契约（字段类型与长度、creators 对象结构、externalRefs provider/ID/库 ID 深度校验），杜绝双契约漂移。
6. **[P2] 单守护收敛**：定位历史 EADDRINUSE 来自重启序列旧实例未退净时的端口抢占；dev-server 新增端口占用优雅退出（exit 0 + 单行日志），实机验证双启动仅剩 1 个 worker。
7. **[P2] 证据浮层**：`getCachedDocumentMeta` 已绝迹并附行为测试；待人工实机点击验证（见下）。

### 测试新增
- 提升失败补偿：500 `blob_persist_failed`、零文档写入、临时文件清理；
- DB 写失败补偿：提升文件被删除、无 blob 行残留；
- 批量 PDF 管线：sha256 命中证明批量真实经过下载+哈希；
- 深度前置校验：creators/externalRefs/title 五类非法输入 400 且零任务残留；
- 一致性扫描：悬挂数据库附件、幽灵 blob、孤儿文件与幂等重扫；
- 分页：201 篇多页全量加载、上限抛错且 `allItems` 不被覆盖。
- `npm test` 7 套全过；`git diff --check` 通过。

### 待人工实机验证（human-in-loop）
1. 刷新 AltCanvas 页面，打开任意含 PDF 来源卡片的画板；
2. 点击卡片上的 [🔍 核验] 打开证据浮层，确认标题/页码/摘录正常显示、无 console 报错；
3. 回复“完成”后由 Agent 复查 `.debug/browser.log` 确认无 `getCachedDocumentMeta` 新错误。

---

### 里程碑状态

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M1 原生 PDF 基础单文献闭环 | **PASS (完成)** | 独立 local 认证、原生流式上传、去重、Range 文件流服务、Reader 批注持久化、全文理解与证据转批注 |
| M1.5 Native Core Integration | **PASS (关闭)** | 主线与 Native 核心全量合流，Schema v12 双谱系幂等迁移，Native 确立为默认核心，Altero 降级为可选 Provider |
| M2 统一导入管线 | **PASS (完成)** | 规范化多源导入、优先级去重链（含文库维度 external_refs）、模糊/冲突防静默合并、PDF 两阶段安全下载、import_jobs 完整状态机与逐项报告 |
---

## 2026-09-02 会话（M2 终审三轮整改：恢复竞态、业务绑定清理、排他提升与契约封堵）

### 修复清单

1. **[P1] 恢复扫描竞态消除**：
   - `recoverBlobConsistency` 不再在 `createCanvasHandler`（每次建处理器）时执行，改为**仅在 dev-server 成功取得监听权后**由主实例执行——竞争实例在 `EADDRINUSE` 优雅退出前绝不触达扫描；
   - 孤儿文件增加 **15 分钟宽限期**（按 mtime）：导入中"已提升未提交"的文件绝不会被并发扫描误删；
   - 确定性交错测试：提升文件 → 并发扫描（零删除）→ DB 写入 → 文件与引用**同时存活**。
   - **重复拉起源根治**：定位到 systemd 用户单元 `altcanvas.service`（`Restart=always, RestartSec=3`，此前累计 2547 次竞争启动）；已停用手工 nohup 实例，由 systemd 独占守护，journal 干净、单实例、零新增端口冲突。
2. **[P1] 恢复悬挂附件的业务层绑定清理（同事务）**：软删除附件时原子清理 `inbox_entries.attachment_key/version` 原子对、`topic_documents.attachment_key/version`，并将绑定该附件的 `ready/running` 分析置 `stale`；行为测试断言收件箱对清空、主题对清空、分析状态 stale。
3. **[P2] 真正排他的原子提升**：`defaultPromoteBlob` 改用 `linkSync`（EEXIST 即并发失败方）+ `EXDEV` 回退 `copyFileSync(COPYFILE_EXCL)`；并发测试断言同一内容两次提升**恰好一次** `newlyCreated: true` 且失败方临时文件被清理。
4. **[P2] 契约旁路封堵**：显式 `pdfUrl` 非 http(s)（`file:`/`ftp:` 等）直接 400；客户端 `resolved` 全量纳入同一规范化器（`abstractNote/sourceType/doi/url/pdfUrl/arxivId` 类型与长度、`pdfUrl` 协议、`creators` 数组）；`year`（含 `resolved.year`）必须为 1400–2200 整数；7 类非法载荷 400 且零文档/零任务残留。

### 测试新增/更新
- 一致性扫描：悬挂数据库附件 + 收件箱/主题绑定清理 + stale 分析 + 新旧孤儿区分（aged 删除 / fresh 宽限保留）+ 幂等终扫；
- 交错安全：promote → scan → DB write 全链路双向存活；
- 排他提升：双提升者单赢家；
- 契约封堵：`file://`/`ftp://` pdfUrl、非法 year（类型/越界）、超长 `resolved.abstractNote`、非法 `resolved.pdfUrl`、批量 file:// 全部 400。
- `npm test` 7 套全过；`git diff --check` 通过。

### 待人工实机验证（human-in-loop，关闭 M2 前置条件）
1. 刷新 AltCanvas 页面，打开含 PDF 来源卡片的画板；
2. 点击卡片上的 **[🔍 核验]** 打开证据浮层，确认标题/页码/摘录正常、无 console 报错；
3. 回复"完成"后由 Agent 复查 `.debug/browser.log` 确认无 `getCachedDocumentMeta` 新错误。

**验收结果（2026-09-03 00:14 UTC 用户完成操作）**：`.debug/browser.log` 该会话仅产生 diagnostics 连接记录、零新增错误；全部 `getCachedDocumentMeta` 报错停留在修复前（2026-09-02T09:25）。证据浮层实机验收 **PASS**。

---

## 2026-09-03 会话（M2 最终关闭）

- 证据浮层人工验收 PASS（见上），M2 全部审计轮次的 P1/P2 均已闭环并附测试；
- 运行守护：`systemctl --user` 单元 `altcanvas.service` 独占管理（`Restart=always, RestartSec=3`），重复拉起源已根治；
- 审计登记的非阻断 P2 技术债同日收紧：`resolved.arXivId` 大小写旁路封堵（两种拼写均纳入长度契约）；`externalRefs` 全字段规范化（`externalAttachmentId` ≤256 字符串、`externalVersion` 非负整数、`sourceUrl` ≤2000 且必须 http(s)，未知键丢弃并输出规范化对象）；新增 5 类非法载荷 400 测试与全字段正向前置持久化断言；
- **M2 统一 Native 导入管线：PASS（关闭）**。下一阶段：M3 Translation Server 集成。

## 2026-09-03 会话（M3.2 统一解析与导入工作流实施）

### 交付内容
1. **输入格式自动探测** ([`server/import-resolver.mjs`](file:///home/sadgen/Projects/AltCanvas/server/import-resolver.mjs))：
   - 实现 `detectInputFormat(input)`：精准识别 `bibtex`（`@type{`）、`ris`（`TY  -`）、`doi`（含裸 DOI 与 DOI 链接）、`arxiv`（含裸编号与链接）、`url` 与 `text`；
   - 增强 `extractArxivId` 支持裸数字编号格式（如 `2301.12345`）。
2. **Translation Server 与统一解析管线贯通** ([`server/import-resolver.mjs`](file:///home/sadgen/Projects/AltCanvas/server/import-resolver.mjs) & [`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
   - `resolveImportInput` 接入 `callTranslationServer`：BibTeX 与 RIS 书目文本直接经 TS 解析为规范化 Native DTO；未配置时返回明确的 `translation_server_unavailable`（503），语法错误返回 `translation_server_error`（400）；
   - `/canvas/imports/resolve` 解除 2KB 截断限制（放宽至 1 MiB 支持大篇幅书目），输入解析后无缝对接 `findDuplicateCandidates` 进行多维去重预检，响应透传 `parsedBy: 'translation_server' | 'native_resolver'`。
3. **M2 统一 Native 导入执行器全链路复用**：
   - `/canvas/imports/native` 与 `/canvas/imports/native/batch` 现支持直接输入 BibTeX / RIS 文本（零前端预解析要求），服务端统一调度 TS 解析、去重预检、PDF 下载、Blob 提升与原子写库；
   - 完整复用 M2 的 SHA-256 / DOI / external_refs / ISBN 去重链、409 身份冲突拦截、409 模糊确认与双向补偿。
4. **前端快速导入多模态解析支持** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
   - 快速导入弹窗切换为多行 `<textarea>`，支持粘贴完整 BibTeX / RIS 内容并保留换行；
   - 解析结果卡片根据 `parsedBy` 自适应渲染紫底 `BIBTEX (TS)` / `RIS (TS)` 徽标；
   - 快捷键支持 `Enter`（单行）与 `Ctrl+Enter` / `Cmd+Enter`（多行）即时触发解析。
5. **测试覆盖** ([`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs))：
   - 包含 7 种输入格式探测单元测试；
   - 包含 BibTeX 与 RIS 的 TS 解析及 DTO 字段断言；
   - 包含 TS 未配置 503 与语法错误 400 测试；
   - 包含 BibTeX 单篇直接导入入库 + 附件创建测试；
   - 包含相同 BibTeX 二次导入 SHA-256 / DOI 优先级去重复用测试；
   - 包含 BibTeX + DOI 混合批量导入与部分失败报告测试。
   - `npm test` 8 套测试全部通过，`git diff --check` 通过。

---

## 2026-09-03 会话（M3.1 终审整改：Keep-Alive 连接复用、目标解析计时器清理与回环字面量统一）

### 修复清单

1. **[P1] Keep-Alive 跨请求连接复用超时修复** ([`server/translation-server.mjs`](file:///home/sadgen/Projects/AltCanvas/server/translation-server.mjs))：
   - 根因：`req.on('socket', sock)` 在复用已有 Keep-Alive socket 时，`sock.connecting === false`，不会再次触发 `connect`/`secureConnect` 事件，导致 `connectTimer` 持续存活而在服务端延迟大于 `connectTimeoutMs` 时错误触发 `connect_timeout`；
   - 修复：在 `req.on('socket')` 中检测 `!sock.connecting`，已连接 socket 立即触发 `connected()`（清除连接计时器并武装响应计时器）；并在响应头回调中幂等调用 `connected()` 兜底；
   - 真实测试：连续发送两个请求至同一服务器，验证第二个请求复用同一 socket，在 `connectTimeout=80ms` < `server delay=250ms` < `responseTimeout=600ms` 下成功完成（耗时 ~250ms）。

2. **[P2] 目标解析 Promise.race 遗留计时器清理**：
   - 根因：`resolveTranslationTarget` 的超时 Promise 创建了 `setTimeout` 但未在成功后清除，导致即时成功的进程仍被挂起等待默认 60s/自定义超时期满；
   - 修复：在 `try...finally` 中显式 `clearTimeout(targetTimer)`；
   - 行为测试：子进程以 `totalTimeoutMs=4000` 执行即时成功的调用，断言子进程在 <1500ms 内立即退出，证明无悬挂定时器。

3. **[P2] 127.0.0.0/8 回环字面量判定统一**：
   - 字面量快速路径支持全部 127.0.0.0/8（如 `127.0.0.2`, `127.250.1.2`）与 `::1`，与 `isLoopbackAddress` 语义完全对齐；
   - 增加 `127.0.0.2` 等字面量无需 `ALLOW_REMOTE_TRANSLATION_SERVER` 的直接 loopback 测试。

4. **里程碑状态更新**：**M3.1 Translation Server 安全适配层：PASS（关闭）**。

---

## 2026-09-03 会话（M3.1 审计整改：真实超时语义与 DNS 固定修复）

### 修复清单（审计两项 P1 + 两项 P2）

1. **[P1] 三层超时语义重写**：
   - 总期限从 `callTranslationServer()` 入口起算，覆盖目标解析（DNS 悬挂实测被总期限切断）、连接、响应头、响应体与解析全过程；
   - 连接计时器在 Socket `connect`/`secureConnect` 后立即清除（实测：服务端延迟 80ms 返回、connectTimeout=20ms、responseTimeout=200ms 场景成功）；
   - 响应计时器在连接建立时武装，覆盖等待响应头与读取响应体（实测：静默服务器触发 `response_timeout`、慢响应体按预算边界成功/截断）；
   - 所有超时路径销毁请求与 Socket；总期限优先级实测高于更长的响应超时。
2. **[P1] DNS 固定彻底修复**（实测发现比审计报告更严重：主机名目标的固定拨号此前从未真正生效——Node 22 以 `all:true` 模式调用自定义 lookup，旧的 `(err, ip, family)` 回调在此模式下静默失效）：
   - 自定义 lookup 同时支持 `all:true`（记录数组）与单地址两种回调模式，且仅返回已验证地址，绝不回落系统 DNS；
   - `allowPrivate` 只决定是否接受私网地址，**不再决定是否解析**：远程目标无论开关均执行 DNS 解析并固定；
   - 解析为零地址即拒绝且不拨号（实测传输零调用）；
   - `localhost` 域名必须解析且全部结果属于 127.0.0.0/8 或 `::1` 后固定（IPv4 优先确定性选择）；IP 字面量直接固定、零 DNS 调用；
   - `allowPrivate=true` 实测仍解析并固定 192.168.x 地址。
3. **[P2] 集合数量上限**：creators ≤100、拒绝无任何姓名字段的空 creator（防止放大为空数据库行）。
4. **[P2] 序列化请求上限**：以最终序列化的 `{input, format}` body 字节为准（真实与注入传输共用），1 MiB input 因 JSON 封套超标实测被拒。

### 新增真实服务器测试（test 10–16）
慢响应成功（审计原始场景）、无响应头 `response_timeout`、慢响应体双向预算边界、DNS 永久悬挂总期限、总期限优先级、DNS 固定全家桶（allowPrivate 固定/零地址拒绝不拨号/localhost 解析验证与真实回环往返/IP 字面量零 DNS）、集合上限与序列化体积门。
`npm test` 8 套 28 个断言组全过；`git diff --check` 通过。

---

## 2026-09-03 会话（M3.1 Translation Server 安全适配层）

### 交付内容 ([`server/translation-server.mjs`](file:///home/sadgen/Projects/AltCanvas/server/translation-server.mjs))
1. **仅服务端配置**：目标地址只来自 `TRANSLATION_SERVER_URL` 环境变量；调用方仅提供输入文本与格式提示，客户端永远无法指定服务器地址；未配置时返回 `{ available: false }`。
2. **目标信任分级**：
   - `unix:///path` Unix Socket 与 loopback（`localhost/127.0.0.1/::1`）为可信默认；
   - 远程目标必须显式 `ALLOW_REMOTE_TRANSLATION_SERVER=true`，并复用共享 SSRF 门（`validateExternalUrl` DNS 解析 + 私网拦截 + 固定 IP 拨号），私网需 `ALLOW_PRIVATE_TRANSLATION_HOSTS`；
   - 拒绝非 http(s)/unix 协议与内嵌凭据。
3. **禁止重定向**：3xx 或携带 `Location` 即抛 `redirect_not_allowed`，传输为单次请求（实测重定向服务器仅收到 1 次请求）。
4. **三层超时**：连接（5s 默认）、响应（30s）、总任务（60s）均可通过环境变量覆盖；注入传输同样受总超时约束（发现并修复了注入路径绕过超时的缺陷）。
5. **体积上限**：请求体 1 MiB（ bibliography 输入）、响应体 2 MiB（真实传输流式拦截 + 返回体事后复检双重保障）。
6. **严格响应模式校验**：`{ ok, sourceType, title, creators[], year, doi/url/isbn/arxivId/abstractNote/pdfUrl }` 逐字段类型/长度/范围校验（year 1400–2200 整数、pdfUrl 必须 http(s)），未知字段剥离；`ok:false` 结构化透传错误。
7. **纯解析无写入**：模块不接触数据库与 Blob；`translationResultToImportItem` 输出直接喂给 `normalizeNativeImportItem`（已导出供契约测试）与 M2 统一执行器。

### 测试（新增第 8 套 `test/translation-server.test.mjs`，接入 npm test）
- 配置禁用默认、loopback/unix/远程门控、私网 DNS 拦截、非法协议/凭据拒绝；
- 重定向单次中止、悬挂传输总超时、请求/响应体积上限；
- 非 2xx / 非 JSON / 六类模式违规 / 未知字段剥离；
- DTO 通过与 M2 执行器完全相同的 `normalizeNativeImportItem` 契约；
- 真实 loopback HTTP 服务器往返 + 重定向服务器单请求中止。
- `npm test` 8 套全过；`git diff --check` 通过。

### 下一步：M3.2 统一解析与导入工作流
用户输入 → 输入类型识别 → Translation Server 解析 → 规范化 Native DTO → 身份冲突与重复预检 → 用户确认 → M2 Native 导入执行器 → 收件箱/主题关联（全部复用 M2 去重链/确认/PDF 下载/Blob 补偿/import_jobs 状态机）。

---

## 2026-09-03 会话（M3.0 登录后应用初始化修复——P1 首要前置项）

### 根因
本地登录成功后 `submitLogin()` 仅执行 `checkSession + loadCollectionsAndLibrary + loadInboxEntries`，未重新调用 `initCanvasWorkspace()`；页面首次打开未登录时画板已被置为"需 OIDC 登录"占位，导致登录后不刷新就看不到主题/画板。

### 修复成果
1. **唯一统一初始化入口 `initializeAuthenticatedApp()`** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
   - 时序：AI 配置 → 主题/画板初始化（内含收件箱加载）→ Native 文库 → 认证/能力 UI；
   - `appInitInFlight` Promise 锁：双击登录、页面恢复、重复调用只会产生一次 `initCanvasWorkspace`，顺序完成后可再次运行（支持重新登录）；
   - 初始化失败保留登录态并以"应用初始化失败"具体提示，绝不呈现为登录/OIDC 问题。
2. **页面启动与本地登录共用该入口**：启动 IIFE 精简为 `checkSession → loadKnownDeletedAnnotations → initializeAuthenticatedApp`；`submitLogin` 本地分支改为 `登录 POST → 会话确认（必须返回 true）→ initializeAuthenticatedApp`，会话确认失败显示"登录会话确认失败"并重开登录框；删除了原先重复的 `loadInboxEntries` 直调。
3. **OIDC 专用文案统一**：`需 OIDC 登录`→`请登录 AltCanvas`；`Canvas 需要 OIDC 登录`→`登录后即可使用研究画板`；`请先使用 OIDC 登录…`→`请先登录 AltCanvas…`；服务端 `OIDC-authenticated session`→`authenticated AltCanvas session`。
4. **Altero OAuth 回跳不受影响**：OAuth 分支仍走完整页面重定向，由启动 IIFE 统一初始化。

### 行为测试（生产行为执行，非仅结构断言）
- 初始化顺序精确断言 `ai-config → canvas-init → library → auth-ui`；并发双调用 `initCanvasWorkspace` 恰好一次；顺序完成后的再次调用完整重跑；
- 初始化失败：`config.mode/user` 保持、toast 含"应用初始化失败"且不含"请登录/重新登录/OIDC"、`app.initialize` 上报；
- 本地登录顺序：`POST /auth/login → close-modal → toast → checkSession → init-app`，零 Altero `/api/*` 请求；会话确认失败不初始化并重开登录框；
- Altero 分支仍重定向 `/auth/login?altero_api=`；
- 启动 IIFE 区域内不得出现绕过统一入口的直调。
- `npm test` 7 套全过；`git diff --check` 通过。

### 人工实机验收（M3.0 关闭闸门）：**PASS（2026-09-03 04:26 UTC）**
实机日志确认：登录操作后仅 `Browser diagnostics connected`；无新增 Canvas 401、无 `app.initialize`/`canvas.initialize` 错误、无 Altero API 误调用、无 OIDC 遗留提示；登录后统一执行 `checkSession() → initializeAuthenticatedApp()`。**M3.0 正式关闭（PASS）**。

---

## 2026-09-02 会话（P1 Native Library Routing & Capability Isolation 修复）

### 修复背景与根因

- 本地账号登录成功后前端提示“当前登录缺少读取文库所需的权限，请退出后重新授权”。
- 根因分析：
  1. `loadCollectionsAndLibrary` 内部使用了未声明的变量 `allLibraryItems`（导致抛出 `ReferenceError: allLibraryItems is not defined`），异常被 `catch` 捕获后控制流错误落入下游 Altero API 加载逻辑；
  2. Altero API 在本地模式下因未启用外部文库返回 403，触发了 Altero 专用的“重新授权”提示；
  3. 收件箱、主题文献和 Canvas 来源跳转在某些未命中缓存的分支也缺少 Native 专用分派，直接调用了 `libraryApiPrefix()`。

### 修复成果与实现要点

1. **统一文库内存状态与 Native 数据映射** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
   - 彻底清除所有 `allLibraryItems` 引用，统一使用 `allItems` 并补充 `libraryType: 'native', libraryId: 'local', isNative: true`；
   - 提取规范转换工具函数 `nativeDocumentToLibraryItem`、`nativeLibraryItemToDocument` 与 `nativeLibraryChildToAttachment`，并在多个视图中复用；
   - 新增 `getNativeLibraryItem(documentId, signal)` 统一 Native 文档缓存获取与按需加载。

2. **彻底隔离 Native 与 Altero 加载分支** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
   - 将文库加载重构为独立函数 `loadNativeLibrary(signal)` 与 `loadExternalLibrary(signal)`；
   - 严格依据 `config.authMode === 'altero' && config.capabilities?.externalLibrary === true` 决定路由，非外部文库模式下执行 `loadNativeLibrary` 且无论成功失败一律直接终止（`return`），严禁落入 Altero；
   - 独立错误呈现 `renderNativeLibraryError`：401 提示“登录会话已过期”，403 提示“无法访问本地文库”，5xx 提示“Native 文库加载失败”，绝不向本地用户展示 Altero 专属的“重新授权”提示。

3. **收件箱、主题文献与 Canvas 跳转 Native 闭环** ([`index.html`](file:///home/sadgen/Projects/AltCanvas/index.html))：
   - `openInboxEntryForReading`、`loadTopicDocuments` 与 `resolveTopicLibraryPdf` 全面通过 `docLib.libraryType === 'native'` 精确分派，Native 模式调用 `getNativeLibraryItem`，严禁传入 `libraryApiPrefix()`；
   - `jumpToSourceAnnotation`、`jumpToDocumentSource` 与 `syncSourceFreshness` 适配 Native 批注检查与文献跳转，零 Altero 网络调用；
   - 升级 `openDocument(identity)` 统一入口，按 `normalizeLibraryContext` 调度 Native 与 Altero。

4. **全套自动化测试覆盖** ([`test/canvas-ui.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas-ui.test.mjs))：
   - 增加 `allLibraryItems` 静态绝迹断言；
   - 增加 Local + `externalLibrary: false` 200 成功与 500 隔离行为测试（断言 Altero API 调用次数为 0，错误提示正确）；
   - 增加 Altero capability 开启时正常代理调用测试；
   - 增加 Native 收件箱缓存命中/未命中直接打开行为测试（断言 `libraryApiPrefix` 0 调用）；
   - 增加 Native 主题 PDF 解析与 Canvas 来源跳转行为测试（断言 0 Altero 调用）。
   - `npm test` 7 套测试全部通过，`git diff --check` 通过。

---

## 2026-09-03 会话（M3.2 终审整改：1 MiB 输入放宽、规范化 DTO 与 ISBN 流转、TS 错误状态码映射与 UI 行为测试）

### 修复清单（审计 3 个 P1 + 1 个 P2）

1. **[P1] 1 MiB 输入放宽与请求体限额扩大** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
   - `FIELD_LIMITS.input` 放宽至 1,048,576 字符（1 MiB）；配置 `MAX_IMPORT_BODY_BYTES = 2 * 1024 * 1024`（2 MiB）覆盖 `/canvas/imports/native`、`/canvas/imports/native/batch`、`/canvas/imports/resolve` 与 `/canvas/imports`；
   - 口径澄清（终审指正）：**"输入字段最多 1 MiB 字符"仅指字段校验上限，且必须在 2 MiB 序列化请求体上限之内**；Translation Server 侧限制的是最终序列化请求体 1 MiB，因此恰好 1 MiB 的原始输入会因 JSON 封套超限触发 413——这是既有安全设计，不承诺完整 1 MiB 原文一定可发送；
   - 解决批量与直接单篇导入中 >2KB BibTeX/RIS 输入被 400 截断拦截的漏洞。

2. **[P1] 统一 DTO 规范化与 ISBN 完整保留** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs) & [`server/canvas-store.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-store.mjs))：
   - 抽取并导出 `normalizeResolvedImportMetadata` 作为权威元数据规范化函数：严格限制字段长度、校验 1400–2200 年份整数、实施 `creators <= 100` 数量上限并要求非空姓名、剥离未授权非法字段；
   - `executeNativeImportItem` 完整接收并流转 `isbn: resolved?.isbn || normalized.isbn || null`，写入 `documents.isbn` 列；
   - 后续重复导入相同 ISBN 书目能够准确触发 `match.strategy === 'isbn'` 优先级复用。

3. **[P1] Translation Server 运行时故障精确状态码映射** ([`server/import-resolver.mjs`](file:///home/sadgen/Projects/AltCanvas/server/import-resolver.mjs) & [`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
   - 在 `resolveImportInput` 与 `executeNativeImportItem` 中彻底消除将 TS 故障静默转换为通用 400 "无法识别输入" 的吞并捕获；
   - 精确映射并透传 HTTP 状态码与错误代码：
     - 超时：`504 Gateway Timeout`（`total_timeout`, `connect_timeout`, `response_timeout`）；
     - 上游/传输/重定向阻断：`502 Bad Gateway`（`upstream_error`, `transport_error`, `redirect_not_allowed`, `forbidden_address`）；
     - TS 未配置：`503 Service Unavailable`（`translation_server_unavailable`）；
     - 语法错误：`400 Bad Request`（`translation_server_error`）；
     - 体积超限：`413 Payload Too Large`（`request_too_large`, `response_too_large`）；
     - 无法识别的纯文本输入：`400 Bad Request`（`unsupported_import_input`）。
   - 批量导入中 `appendImportJobItemReport` 持久化记录 `errorCode: itemErr.code`，使任务报告呈现精确错误分类。

4. **[P2] 前端快速导入交互生产行为测试补齐** ([`test/canvas-ui.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas-ui.test.mjs))：
   - 针对 `index.html` 真实交互逻辑编写运行时测试：
     - 单行文本下按 `Enter` 触发解析并阻止默认换行；
     - 多行文本下按普通 `Enter` 保留换行；
     - 多行文本下按 `Ctrl+Enter` / `Cmd+Enter` 触发解析；
     - 验证 `parsedBy === 'translation_server'` 时自适应渲染紫色 `(TS)` 徽标；
     - 验证 TS 未配置返回 503 时弹出配置提示 toast，语法错误 400 时弹出语法错误 toast；
     - 验证快速导入在提交给 `/canvas/imports/native` 的 payload 中完整保留并携带 `isbn` 字段。

### 测试验证与覆盖 ([`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs))
- 验证 >2KB 长输入在单篇与批量导入均成功入库（解除 2KB 限制）；
- 验证批处理失败项的 report item 正确记录 `errorCode: 'unsupported_import_input'`；
- 验证 TS 返回 ISBN 成功写入 document 并在二次导入时按 ISBN 策略命中复用；
- 验证 `creators > 100` 在写入 DB 前被 400 拦截；
- 验证 504 `total_timeout`、502 `upstream_error`、400 `translation_server_error` 与 400 `unsupported_import_input` 状态码映射；
- **全套 8 套自动化测试通过**：
  - BFF 单元测试 (PASS)
  - BFF 流程测试 (PASS)
  - AI 安全测试 (PASS)
  - Canvas 存储与持久化测试 (PASS)
  - Canvas UI 结构与行为测试 (PASS)
  - 开发日志测试 (PASS)
  - Native M1 最小闭环测试 (PASS)
  - M3.1 Translation Server 适配测试 (PASS)
- `git diff --check` 100% 通过。

### 里程碑状态更新
- **M3.2 统一解析与导入工作流：PASS（正式关闭）**。
- **下一阶段：M3.3 / M4 准备与交接**。

---

## 2026-09-03 会话（M3.2 终审二轮整改：结构化导入 creators 统一契约与 /imports/resolve 状态码旁路封堵）

### 修复清单（终审 2 个 P1 + 1 个 P2 测试口径）

1. **[P1] 纯结构化导入统一 creators 契约** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
   - `executeNativeImportItem` 重构：将 resolver 输出与 top-level 结构化字段**合并为单一最终元数据对象**，无论来源（Translation Server DTO、native resolver、客户端结构化载荷）都**恰好调用一次** `normalizeResolvedImportMetadata()` 后再写库，不再分别规范化后手工拼接；
   - 空白姓名判定收紧为 trim 感知：`{name: "   "}`、`{creatorType: "author"}`（无任何姓名字段）均被拒绝；
   - `normalizeNativeImportItem` 的 creators 路径同步加上 `≤100` 数量上限与非空姓名校验，批量前置校验在建任务前即整体拒绝（400 且零任务残留）。
2. **[P1] `/canvas/imports/resolve` 与旧 `/canvas/imports` 状态码旁路封堵** ([`server/canvas-api.mjs`](file:///home/sadgen/Projects/AltCanvas/server/canvas-api.mjs))：
   - 两处解析 catch 分支统一改为 `const status = Number.isInteger(err.status) ? err.status : 400`，透传 resolver 的权威状态码与 `err.code`；
   - `total_timeout → 504`、`upstream_error → 502`、`translation_server_unavailable → 503`、`request/response_too_large → 413`、语法/不支持输入 `→ 400`，不再统一压成 400。
3. **[P2] UI 错误提示按状态码分支 + 测试口径修正** ([`index.html`](file:////home/sadgen/Projects/AltCanvas/index.html) & [`test/canvas-ui.test.mjs`](file:////home/sadgen/Projects/AltCanvas/test/canvas-ui.test.mjs))：
   - 前端 `resolveQuickImport` catch 按 `err.status`/`err.code` 分支：503 → "解析服务未配置（TRANSLATION_SERVER_URL）"、504/超时类 → "解析服务响应超时"、其余 → 透传服务端消息；
   - UI 测试重写为**分支行为验证**：503/504/400 三组注入完全相同的原始 message、仅状态码不同，断言 toast 分别命中专属文案且不含透传原文——证明分支依据 HTTP 状态而非消息文本（旧测试只比较不同 message，无法发现状态码映射缺陷）。
4. **1 MiB 口径澄清**：上节表述已修正为"序列化请求体上限内、输入字段最多 1 MiB 字符"（TS 侧以最终序列化请求体 1 MiB 为上限，恰好 1 MiB 原文会因 JSON 封套触发 413，属既有安全设计）。

### 测试新增 ([`test/canvas.test.mjs`](file:///home/sadgen/Projects/AltCanvas/test/canvas.test.mjs))
- top-level 101 位 creators → 400（`at most 100 entries`）且文档计数零增长；
- top-level 空白姓名 creator、无姓名字段 creator → 400（`non-blank name`）；
- 合法 top-level creators → 201 且 `document.creators` 逐行持久化（firstName/name 断言）；
- 批量含 101 位 creators 条目 → 400 前置拒绝、import_jobs 计数零增长；
- `/canvas/imports/resolve` 状态码全矩阵：504 `total_timeout`、502 `upstream_error`、413 `response_too_large`、400 `translation_server_error`、400 `unsupported_import_input`（503 已有覆盖）；
- 旧 `/canvas/imports` 入口：TIMEOUT_ERROR → 504 `total_timeout`。

### 里程碑状态
- **M3.2 统一解析与导入工作流：PASS（正式关闭，终审二轮整改完成）**。

---

## 2026-09-03 产品决策（下一阶段：M4 Native 文件与文库管理）

- 用户没有实际 Altero/Zotero 文库或迁移需求，取消外部迁移器计划。
- 完整实施规格见 [`docs/m4-native-library-manager.md`](./m4-native-library-manager.md)，
  接续 Agent 开工前必须全文阅读。
- 产品收敛为“原始文件、文库、研究画板”：真实目录是唯一文件夹，主题是唯一文库
  分类，同一文档可属于多个主题且不复制 PDF。
- 名称模型只有磁盘上的“原始文件名”和 AltCanvas 中的“文库文件名”。用户可显式
  重命名原始文件，系统不得自动改名。
- 相同 SHA-256 默认不加入文库；导入、移动或重命名的目标目录已有不同哈希同名文件时
  阻断，必须由用户输入新的原始文件名后重试，不覆盖、不自动追加 `(2)`。
- 取消独立收件箱和 Collection 绑定；无主题文档由文库“未分类”筛选承接。
- 当前 Schema 为 v12；M4 使用独立 v13，并保持旧 managed Blob 文档可用。

---

## 2026-09-03 会话（M4 Native 文件与文库管理实施）

### 实施概要（分支 `feat/m4-native-library`，5 个提交）

| 提交 | 内容 |
| --- | --- |
| `01656c2` | docs: M4 方案与产品决策 |
| `430b881` | Schema v13 + 统一附件读取抽象 + 路径安全模块（native-fs） |
| `6cf6139` | 增量扫描器（去重/移动识别/missing 状态/离线安全）+ 目录树 API |
| `79ed935` | 显式文件操作（导入落点/重命名/移动/回收/恢复/永久删除）+ 冲突阻断 + file_operations 补偿 |
| `46ea21b` | 前端原始文件视图/文库过滤/双名称 + 收件箱与 Collection 退役（410）+ 文库级 AI 归类 |

### Schema v13（当前版本）

- 新表：`library_roots`（活跃 `(owner_key, absolute_path)` 唯一；服务端
  `NATIVE_LIBRARY_ROOTS` 配置驱动，客户端无法注册路径）、`source_files`
  （活跃 `(owner_key, root_id, relative_path)` 部分唯一；状态机
  `active/duplicate/missing/unreadable/trashed`）、`file_operations`
  （持久化操作日志：`file.import/rename/move/trash/restore/delete_permanent/mkdir`、
  `library.scan/reconcile`，状态 `queued/running/completed/failed/rolled_back`）。
- `attachments` 表按官方流程重建：`blob_hash` 改为可空，新增
  `storage_kind`（`managed_blob | source_file`）与 `source_file_id`，CHECK
  约束保证两种存储互斥且完备。迁移在构造器 `foreign_keys=OFF` 窗口内完成，
  迁移后 `PRAGMA foreign_key_check` 断言零违规；真实 v12 夹具测试证明
  annotations 在重建中幸存（这是最大的技术风险点，已被测试钉死）。
- 遗留收件箱兼容迁移：v13 首次打开时对 native inbox 条目回填空缺文档字段
  （仅 DOI），无文档的孤儿条目写入 `data/m4-inbox-migration-report.json`
  报告，绝不静默删除。真实 DB 已迁移：2 条全部关联、0 孤儿。
- 备份：迁移前 DB（VACUUM INTO）与 blobs 均存于 `backups/`（已 gitignore）。

### 统一附件读取抽象

- `store.getAttachmentContent(actorKey, attachmentId)`：返回
  `managed_blob`（blob 存储）或 `source_file`（文库根目录文件）统一内容描述；
  Reader、Range 服务、批注、全文分析全部经此解析，前端零感知。
- `/canvas/native/attachments/:id/file` 双存储支持：200/206/304/416/HEAD 全保持；
  source_file 通过 `openFileInsideRoot`（O_NOFOLLOW + realpath 越界校验）以 fd
  为 TOCTOU 锚点流式读取。
- `server/native-fs.mjs`：所有磁盘路径的唯一入口——拒绝绝对路径/`..`/NUL/
  反斜杠/隐藏段；`openFileInsideRoot` 拒绝符号链接逃逸；流式 SHA-256；
  扫描遍历不跟随符号链接。

### 扫描器（server/library-scanner.mjs）

- 严格递归收集 PDF（隐藏文件/回收区/符号链接排除；不可读子目录直接中止
  扫描而不是误标 missing）。
- 三阶段：A) 分批异步哈希（size+mtime 未变跳过重哈希，`touchSourceFiles`
  刷新 last_seen 不摇动版本）；B) 仅在完整成功遍历后对账——哈希相同的
  路径迁移识别为移动/外部改名、真缺失标记 missing、missing 恢复 active；
  C) 未占用路径入册：唯一内容创建文档+source_file 附件，同哈希多路径仅
  一个文库身份，其余 `duplicate` 未入库。
- 检查点：扫描完整成功才置 root `last_scan_status=ok`；离线根目录
  （`library_root_unavailable` → HTTP 503）在任何 DB 变更前拦截，零行变更；
  中断扫描由启动恢复标记 failed（`recoverInterruptedFileOperations`）。
- 文件操作均为"先文件系统、后版本守卫 DB 写入"，失败自动补偿回滚；
  崩溃撕裂状态由下一次扫描的哈希对账自愈。

### 导入落点与冲突规则

- M2 执行器 `executeNativeImportItem` 扩展 `fileTarget`（单执行器，未复制
  第二套）：解析→PDF 安全下载→SHA 规则（先于元数据去重链）→目标同名探测→
  排他隐藏暂存落盘（copy+fsync+link）→事务化文档/附件/主题写入→失败补偿。
- 冲突语义严格按方案 §2.3/§2.4：`duplicate_content`（409，不复制不建第二
  文档）、`filename_conflict`（409，不覆盖、不自动"(2)"，UI 弹出改名对话框
  重试）。目录导入无 PDF 时拒绝（422 import_requires_pdf），不静默降级。
- 文库移除（DELETE /canvas/native/documents/:id）软删文档、解绑 source_file
  （扫描器不会自动重新入库）；回收/恢复保留路径、文库名、主题、批注与分析；
  永久删除仅对回收站文件，清除文件+绑定。

### 退役（收件箱/Collection/Altero 运行时）

- 服务端：`/canvas/inbox`（GET/scan/entries/batch-action/classify/
  generate-topics）与 collection-bindings 全部路由返回
  `410 feature_retired`；`importNativeDocument`/`importNativeUploadedDocument`
  不再写 inbox_entries。
- 文库级 AI 取代收件箱 AI：`POST /canvas/native/documents/classify` 与
  `/canvas/native/classify/generate-topics`（幻觉主题过滤、同请求中文名
  元数据等能力原样保留）；前端文库栏"✨ AI 主题归类"一键提炼+采纳≥0.7 建议。
- `findDuplicateCandidates` 增加 native documents 匹配源（targetType=document）。
- 前端：收件箱按钮/徽标/modal、批量主题 modal、Collection 绑定 Tab 全部删除；
  页面不再引用任何退役端点（UI 测试断言其不存在）。
- Altero 归档标签：`archive/last-altero-compatible`（删除运行时前已打）。
  注意：`loadExternalLibrary`、`proxy-api/oidc` 与 `AUTH_MODE=altero` 认证
  路径暂保留（能力门控，M6 默认解除依赖时移除）。

### 前端（M4）

- 文库侧栏第三 Tab"原始文件"：根目录选择、上级/新建目录、递归扫描（轮询
  file-operations 并汇报 新增/重复/移动/缺失/恢复 计数）、分页目录树、
  双名称展示、状态徽标、每行操作（打开/加入文库/重命名/移动/回收/恢复）。
- 文库列表：过滤 chips（全部/未分类/无 PDF/文件缺失/回收站）+ native 条目
  显示原始文件名与状态，内联原始文件操作。
- 快速导入弹窗：新增"归档到文库目录"区块（根目录/子目录/原始文件名/主题
  多选），`filename_conflict` 走改名对话框重试闭环。
- `server/native-file-ops.mjs` 独立模块承载显式文件操作（重命名/移动/回收/
  恢复/永久删除 + 目标探测 + 排他落盘）。

### 自动化测试（9 套，npm test 全绿）

- 新增 `test/native-m4.test.mjs`（接入 npm test）：路径安全/符号链接逃逸/
  fd 哈希、NATIVE_LIBRARY_ROOTS 解析、v13 fresh + 真实 v12→v13（附件重建、
  annotation 幸存、幂等重开）、根目录配置与隔离、统一内容抽象、文件端点
  全矩阵（200/206/304/416/HEAD/404 双存储）、文件操作日志、扫描器 12 组
  （入册/增量免哈希/物理副本单身份/移动识别/缺失恢复/离线零变更/不可读
  文件与目录安全/树分页与穿越拒绝/启动恢复）、文件操作 11 组（导入落点/
  双冲突/改名不动文库名/If-Match 428/412/移动连带批注/回收恢复/解绑重入/
  永久删除/扫描幂等）。
- canvas.test.mjs：退役 API 重写为 410 契约 + native classify/
  generate-topics 覆盖；schema 断言沿 v13 谱系更新。
- canvas-ui.test.mjs：退役元素断言为"必须不存在"；新增 M4 元素与
  `libraryAiClassifyFlow` 生产行为测试。

### 已知风险与后续工作

1. `AUTH_MODE=altero` 与 Altero 代理（proxy-api/oidc/loadExternalLibrary）
   仍保留（能力门控），M6 移除；本机 .env 未设 AUTH_MODE，实际即 local。
2. 收件箱表保留为 deprecated（未删），下个稳定版本再清理；服务启动时
   `loadInboxEntries` 为 no-op。
3. 移动端/窄窗口下"原始文件"面板布局未做专项验收（C2 遗留项同样未验收）。
4. 库级 AI 归类当前为"提炼+自动采纳≥0.7"的批量操作，无逐条确认 UI。
5. `chmod` 后 mtime 未变时扫描不重检可读性（size+mtime 缓存语义），需
   mtime 变化或内容变化才重新判定 unreadable/active。

### 人工实机验收（M4 关闭闸门，待执行）

前置：`systemctl --user restart altcanvas.service` 已完成（v13 已迁移，
服务 healthy）。 humans 操作（每步后无需要求浏览器控制台输出，Agent 会查
`.debug/dev.log` 与 `.debug/browser.log`）：

1. 登录 → 左侧文库栏点"原始文件" Tab：确认根目录"研究文库"出现、列表为
   空（空目录）→ 回复"完成"。
2. 向 `~/Projects/AltCanvas/data/library/` 放入 1-2 个 PDF（可建子目录）→
   点"🔄 递归扫描" → 确认 Toast 报告"新增 N"且文件出现在列表（显示原始
   文件名与"未入库/文库文件名"两行）。
3. 对一个已入库条目点"✏️ 重命名"改为新名字 → 确认磁盘文件名变化而文库
   列表中的文库名不变；打开 PDF 阅读器确认正常渲染与批注。
4. 对同一条目点"🗑 移入回收站"→"回收站"过滤器可见 →"♻️ 恢复"→ 确认
   路径与批注仍在。
5. 文库 Tab：点"未分类"过滤器确认归类关系正确；点"✨ AI 主题归类"（需 AI
   配置）确认主题提炼与建议采纳。
6. 快速导入弹窗：粘贴 DOI/BibTeX → 展开目录区块选择根目录并归档 → 若目标
   同名会弹改名对话框，改新名字后应成功且不产生"(2)"。
7. 完成后回复"完成"，Agent 复查两份日志确认零新增错误、零 Altero 请求。

---

## 2026-09-03 会话（M4 自动化初审 P1 整改，7 项全部闭环）

### P1.1 写入路径逐级符号链接拒绝（含零副作用保证）

- 新增 `ensureVerifiedDirectory(rootReal, rel, {create})`：从根 realpath 起
  逐组件 lstat，任意一级符号链接即拒（`symlink_rejected`），可逐段创建缺失
  目录；`ensureParentInsideRoot`/`assertWrittenInsideRoot` 供写入路径组合使用。
- rename/move/trash/restore/import/mkdir 全部改为：写入前对源与目标父链
  逐级校验 → 写入后 realpath 越界断言 → 断言失败立即补偿（rename back /
  unlink），保证根目录外零副作用。
- 初审发现的缺口（trash 只校验回收区一侧、源路径父级符号链接可把根外文件
  搬进回收区）已修复并有严格断言。

### P1.2 确定性启动恢复（替代一律标 failed）

- `recoverInterruptedFileOperations` 按 operation_type + 磁盘事实对账：
  rename/move（目标在+源失→补完 DB；源在+目标无→rolled_back）、trash、
  restore、import（文件已落盘但无 DB 行→补偿删除；行在→completed）、
  delete_permanent（补 purge）、mkdir（幂等建目录）；library.scan 维持
  failed+root 复位（重扫天然幂等）。11 个撕裂现场场景全部有行为测试。
- restore 在回收区文件缺失时返回 409 `trash_missing`，禁止 bookkeeping-only
  active（不再谎报磁盘状态）。

### P1.3 forceNew 不再绕过内容去重

- fileTarget 导入的 SHA-256 规则（managed blob 与 source_file 两个持有者
  检查）与 `importNativeDocumentToSourceFile` 的内容检查均无视 forceNew；
  forceNew 只作用于模糊元数据匹配。HTTP 测试：forceNew=true 同哈希仍 409
  duplicate_content；无 confirmFuzzy 的同题异容仍 409 duplicate_confirmation。

### P1.4 扫描内容变化联动附件与分析

- 新增 `store.applySourceContentChange`：内容变化时附件 version+1、size
  更新，绑定该附件的 topic_documents 置 `analysis_status='stale'` 且
  attachment_version 跟随新版本；若新哈希已属于其他已入库文档，行降级为
  `duplicate`（documentId/attachmentId 置空、旧附件软删、旧主题绑定清空且
  stale）——绝不形成第二个文库身份。
- 主题归类现在始终绑定活跃 attachment id/version（`addDocumentTopics` 查
  活跃附件；导入落点绑定新附件版本）。

### P1.5 根目录配置移除即停用

- `ensureLibraryRootsFromConfig`：从 `NATIVE_LIBRARY_ROOTS` 移除的根被软删
  停用，`requireLibraryRoot`/tree/scan 一律 404 拒绝；同路径重新配置时原行
  复活（source_files 关联与历史保留）。

### P1.6 Altero/Zotero 彻底移除（不再延期到 M6）

- 删除 `server/oidc.mjs`、`proxy-api.mjs`、`proxy-files.mjs`、
  `scripts/probe-altero.mjs`；`auth.mjs` 重写为 local-only（无 OAuth、无
  AUTH_MODE=altero、logout 不再外呼 revocation）；`session.mjs` 移除 OAuth
  transaction 存储与 accessToken/refreshToken/alteroApi/groupIds 字段；
  `canvas-api.mjs` 删除 fetchAllUpstreamItems/resolveItemAttachment/
  normalizeZoteroItemToInboxEntry/inboxEntryInput/defaultFetchAltero。
- dev-server：`/auth/callback`、`/api/*`、`/files/*` → 410 feature_retired。
- 前端：登录框 Altero 段/切换按钮、设置面板 Altero API+Zotero Key 直连模式、
  collections 容器、loadExternalLibrary 及其分派、direct-key 存储与全部
  Altero/Zotero 文案删除；`getApiUrl`/`libraryApiPrefix` 改为显式抛错占位
  （遗留死分支误触即失败，保证运行期零 Altero 请求）。
- 测试：bff/bff-flow/native-m1/canvas 四套按新契约重写（本地认证全流程、
  410 矩阵、`AUTH_MODE=altero` 下仍为 local、全流程 0 次外呼断言、组权限
  403 化）；canvas-ui 增加"退役函数与文案必须不存在"否定断言。
- 归档：`archive/last-altero-compatible` 标签保留完整旧实现；.env 与
  .env.example 已清除 ALTERO_API/OAUTH_CLIENT_ID/ALLOW_DYNAMIC_ALTERO/
  ALLOW_PRIVATE_HOSTS/ALLOW_DIRECT_AUTH 等退役变量。

### P1.7 有界扫描

- `collectPdfEntries` 重写为惰性生成器 `iteratePdfEntries` + `batchesOf`
  固定批消费：目录清单不再整体聚合，逐批（SCAN_BATCH_SIZE=100）哈希与
  写库；105 文件跨嵌套目录行为测试 + 生成器惰性断言。

### 其他修正

- 错误映射：`FileOpError` 在全局 catch 中先于 TypeError/400 分支处理，保留
  精确 code/status；导入落盘的 NativePathError（如符号链接父目录）映射为
  400 `symlink_rejected` 而非 500。
- 并行整改说明：本轮 P1 测试补齐与旧套件重写由三个并行子代理按文件边界
  完成（native-m4 行为测试 / 前端+canvas-ui / 四个旧认证套件），服务端修复
  由主会话统一落地后全量回归。

### 验证

- `npm test` 9 套全部通过（exit 0）；`git diff --check` 通过。
- 服务已重启：/auth/session 仅 local；/api/*、/auth/callback 实测 410。
- M4 人工实机验收仍未执行——等下一轮审计通过后再进行。

---

## 2026-09-03 会话（M4 二轮审计 P1/P2 整改：CONDITIONAL PASS → 待复审）

上一轮初审后复审又提出 4 个 P1 + 2 个 P2，本轮全部闭环：

### P1-A 目录树符号链接读取（修复）

- `listDirectoryLevel` 原先只做词法拼接后直接 readdir，`?path=escape`（escape
  为指向根外目录的符号链接）会列出根外内容。重写为 `listDirectoryPage`：
  先对请求目录逐组件 lstat（任意一级符号链接 → `symlink_rejected` 400），
  再从验证后的真实路径 opendir 流式读取。`listDirectoryLevel` 保留为兼容
  包装。HTTP tree 端点拒绝测试（顶层 + 深层符号链接）已补。

### P2-A 目录树分页下推（修复）

- `listDirectoryPage` 用 opendir 流式枚举，名称缓冲上限
  `MAX_DIRECTORY_LIST=20000`（超出置 `meta.truncated=true`），stat 仅对
  请求页执行；tree 端点 limit/cursor 下推到列举层，超大目录不再全量
  materialize 条目对象与 stat。

### P1-B 恢复器绕过安全原语（修复）

- 新增 `safeProbeInsideRoot`（逐组件 lstat、任何一级符号链接即视为不可
  安全寻址、realpath 边界校验、区分 absent/symlink/escape/invalid）与
  `safeUnlinkInsideRoot`（最终项必须为非符号链接常规文件，失败上抛）。
- reconcile 全家族（rename/move/trash/restore/import/delete_permanent）的
  磁盘事实检查改用 safeProbe；import 补偿删除与永久删除的 unlink 改用
  safeUnlink——删除失败标 `compensation_failed` failed（绝不 rolled_back），
  目标父级被换成符号链接时标 `unsafe_path` failed 且根外零副作用。
- reconcileMkdir 改用 realpath 后的根做逐组件校验。
- 测试组 20：崩溃后父目录替换为符号链接（import/trash/restore 三场景，
  外部放置同名诱饵文件断言逐字节不变）+ unlink 失败（父目录 chmod 0500）。

### P1-C 有界扫描（真正实现）

- 三阶段重构 `performScan`，磁盘事实经 TEMP 表 `scan_staging`（按
  scan_id 作用域、参数绑定写入、扫描结束/失败即删、同根重扫先清理陈旧行）：
  - Phase A：惰性批次（生成器 + batchesOf）逐批哈希并写入 staging，行内
    联动（内容变化级联/统计漂移恢复/未读标记）同事务提交；
  - Phase B：`listSourceFilesForScanPage` 复合游标分页读存量行，missing/
    移动识别经 `findMoveCandidateStaging` 的 SQL NOT EXISTS（顺序更新时
    即时复核路径占用，不会双重认领）；
  - Phase C：`listUnclaimedScanStaging` 分页取未认领条目入册/判重。
  全程不再有全量 inventory/diskState/shaToDiskPaths/claimedPaths/unclaimed
  聚合。`scanLibraryRoot` 新增 `entryIteratorFn` 注入口供测试。
- 测试组 21：30,000 条模拟目录项（50 个内容身份 → 50 入册 + 29,950 副本），
  关键断言为"拉取-已入库不变量"——生成器每次吐出条目时校验
  pulled − staged ≤ SCAN_BATCH_SIZE（聚合式实现会在首个断言即失败，最大
  拉取差记录在违规数组）；成功与失败扫描后 staging 表均清空；报告计数
  与 105 文件真实磁盘回归全部一致。

### P1-D 部署层 Altero 移除（修复）

- Dockerfile：删除 `ALTERO_API` ENV，创建 `/app/library` 挂载点。
- docker-compose.yml：删除全部退役变量（含无读取者的 MAX_API_BODY_BYTES/
  UPSTREAM_TIMEOUT_MS），新增 `NATIVE_LIBRARY_ROOTS` 与
  `${ALTCANVAS_LIBRARY_DIR:-./library}:/app/library` 读写挂载；
  `docker compose config` 校验通过。
- docker-compose.all-in-one.yml 删除（git 历史保留）；
  config/altero.web-library.example.json 与 .gitignore 对应条目一并清理。
- 新增 `test/deploy-config.test.mjs`（第 10 套，接入 npm test）：静态断言
  退役变量/服务/依赖零出现、all-in-one 不存在、文库挂载与
  NATIVE_LIBRARY_ROOTS 存在、README/package 元数据合规。

### P2-B 文档对齐（修复）

- README 全面改写为 Native 架构（本地账号 + SQLite + blobs + 文库目录
  挂载），零 OIDC/Zotero/OAuth/probe-altero 引用，历史仅一句归档说明。
- package.json description/keywords 去 Altero/Zotero。
- .env.example 清除全部残留并补 ALTCANVAS_LIBRARY_DIR 与
  NATIVE_LIBRARY_ROOTS 容器路径说明；四个历史设计文档（altero-auth-bff、
  topic-research-workspace、m0、m1）标题下加"已归档（superseded）"标记。

### 验证与状态

- `npm test` 10 套全部通过（exit 0），`git diff --check` 干净；服务已重启，
  /auth/session 仅 local、首页 200。
- M4 维持 CONDITIONAL PASS：等待本轮整改复审；复审通过后才进行人工实机
  验收（步骤见前节，验收时注意 data/library 挂载已在 compose/env 配好）。

---

## 2026-09-03 会话（M4 三轮审计整改：恢复内容身份 / OAuth 旁路 / 前端分页 / 截断边界）

二轮整改复审后仍余 2 P1 + 2 P2 + README 状态问题，本轮全部闭环：

### P1 恢复器内容身份验证

- 新增 `verifyRecoveryTargetContent`：完成任何 rename/move/trash/restore
  对账前，经安全文件句柄（O_NOFOLLOW + realpath + 常规文件校验）重算目标
  SHA-256，必须与 `source_files.sha256` 一致；不一致（含目标被换 PDF、
  目标是目录、行哈希为空不可验证）→ `content_mismatch` failed，数据库零
  更新，交由下次扫描对账真实状态。
- `reconcileImport` 在 DB 行已存在时也必须核实：文件缺失 → `file_missing`
  failed；哈希不符 → `content_mismatch` failed；只有行存在且内容一致才
  completed。
- `recoverInterruptedFileOperations` 改为 async（dev-server 接线已适配）。
- 测试组 22：换 PDF / 目录占位 / DB 已写但文件缺失 / 匹配内容正反例，
  trash 与 restore 的回收载荷被替换场景。

### P1 退役 OAuth 变量旁路

- dev-server 删除 `ALLOW_INSECURE_OAUTH` 读取：生产环境恒要求
  `PUBLIC_ORIGIN=https://`，无任何豁免。
- deploy-config 测试扩展：递归扫描 server/ 与 scripts/ 全部 .mjs 断言
  不出现 `process.env.<退役变量>`（8 个变量，含 ALLOW_INSECURE_OAUTH 与
  AUTH_MODE），.env.example 同样零出现；并断言生产 HTTPS 要求无旁路。

### P2 前端目录分页消费

- `loadSourceFiles` 支持 `{append}`：携带 cursor 追加下一页，列表尾部渲染
  “加载更多（已显示 X / 共 Y）”；切换目录/根目录/重扫时 cursor 重置；
  `meta.truncated` 时列表顶部显示“目录项目过多，当前结果不完整”警示。
- canvas-ui 增加对应结构断言（loadMoreSourceFiles/append/btn-source-load-more/
  截断文案）。

### P2 截断边界

- `listDirectoryPage` 改为读到第 MAX+1 项才置 `truncated`：恰好 20000 项
  不再误报；19999/20000/20001 三个边界的行为测试（真实磁盘文件）。

### README 状态

- "M4 is complete" 改为 "in final acceptance (CONDITIONAL PASS pending
  re-audit and manual verification)"。

### 验证

- `npm test` 10 套全部通过（exit 0），`git diff --check` 干净，服务已重启
  且首页 200。M4 维持 CONDITIONAL PASS，等待最后一轮自动化复审。

---

## 2026-09-03 会话（M4 四轮审计：回滚路径内容身份验证，最后一项 P1）

三轮复审后仅余恢复器对称分支 1 个 P1，本轮闭环：

- **reconcileMoveLike 回滚**：DB 已指向 target、target 缺失、source 被换成
  异内容时，DB 回退到 source 前先经安全句柄重算 source 哈希——不匹配 →
  `content_mismatch` failed，DB 保持指向 target 且身份不变（审计复现场景
  state=rolled_back/path=old.pdf/isMismatch=true 已消除）。
- **reconcileTrash 回滚**：trash 未执行、行回退 active 前验证 source 哈希，
  不匹配保持 trashed。
- **reconcileRestore 回滚**：restore 未执行、保留 trashed 前验证回收区载荷
  哈希，不匹配 → content_mismatch，载荷原样保留。
- **reconcilePermanentDelete**：补删回收区文件前验证其哈希仍属于该行——
  被替换的异内容文件不删除、行不清除。
- 全部验证不匹配时数据库与磁盘零修改；`content_mismatch` 统一错误码。
- 测试组 23：四条反向行为（换源 move 回滚 / trash 回退 / restore 载荷 /
  永久删除补删）+ 匹配内容正控；既有 20.4 场景的回收载荷改为与行身份
  一致以继续隔离符号链接行为。

验证：`npm test` 10 套全部通过，`git diff --check` 干净，服务重启正常。
M4 维持 CONDITIONAL PASS——按审计结论，本项补完后进入最后人工 UI 与
日志验收（步骤见 M4 实施会话节）。
