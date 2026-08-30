# AltCanvas Canvas 设计与实施基线

状态：S0 自动收口完成、HTTPS 实机验收中；C4 多人协作延期  
基线日期：2026-08-27；计划调整：2026-08-30

本文档是 Canvas（画板）功能后续开发和审计的验收基线。除非另有设计
变更记录，实施进度以本文的阶段、接口和退出条件为准。

## 1. 目标与边界

Canvas 是跨文献组织研究材料的空间工作区。用户可以把 Zotero/Altero
条目、附件和批注放到画板上，与手写卡片建立关系，并在后续阶段保留协作
和 AI 产物的来源记录。

数据所有权必须严格分离：

- Altero 继续作为条目、附件、笔记和批注的事实来源。
- AltCanvas 独立数据库保存 workspace、board、node、edge、布局、来源快照、
  操作来源和 AI 产物。
- AltCanvas 不修改 Altero 数据库结构，也不把画板坐标等私有字段写回
  Zotero 兼容对象。
- C1 只提供经过 BFF 会话认证的服务端 API；开发用 API key 直连模式不能
  访问 Canvas 数据。

首个版本不包含实时多人协作、离线合并、语义检索或 AI 生成。这些能力必须
建立在持久化、权限和来源追踪正确的基础上。

## 2. 身份与权限

用户身份使用经过 OIDC 验证的 `(issuer, subject)` 组合，不能只依赖显示名或
可变化的 Zotero 用户编号。数据库内部使用由该组合派生的稳定 actor key，
不保存 OAuth access token。

C1 权限模型为 owner-only：

- workspace、board 及其全部内容只有创建者可读写。
- 引用个人文库对象时，library id 必须等于当前用户的 Zotero user id。
- 引用群组文库对象时，group id 必须存在于当前会话已验证的 group 列表。
- 所有写请求要求同源/Fetch Metadata CSRF 检查。
- 未认证返回 `401`，无权访问统一返回 `404`，避免泄露资源是否存在。

数据库预留 workspace member/role 的演进空间，但 C1 不开放成员管理接口。

## 3. 存储架构

C1 使用独立 SQLite 文件，默认路径为
`$DATA_DIR/altcanvas-canvas.sqlite`，可由 `CANVAS_DB_PATH` 覆盖。启动时启用：

- `PRAGMA foreign_keys = ON`
- WAL journal mode
- busy timeout
- 显式 schema migration

该方案的部署边界是单进程、单节点。未来需要多副本或实时协作时迁移到
PostgreSQL；HTTP 资源模型和版本并发协议保持不变。

当前 Node 22 运行时通过内置 `node:sqlite` 访问数据库，会输出 experimental
warning。它不影响 C1 功能，但在正式长期支持版本冻结前，应评估升级到已稳定
该模块的 Node 版本或替换为受支持的 SQLite driver。

### 3.1 数据表

`schema_migrations`

- `version`、`applied_at`

`workspaces`

- `id`、`owner_key`、`name`
- `version`、`created_at`、`updated_at`、`deleted_at`

`boards`

- `id`、`workspace_id`、`name`
- `viewport_x`、`viewport_y`、`viewport_zoom`
- `version`、`created_at`、`updated_at`、`deleted_at`

`source_refs`

- `id`、`owner_key`
- `library_type` (`user` 或 `group`)、`library_id`
- `item_key`、`attachment_key`、`annotation_key`、`annotation_version`
- `page_label`、`position_json`、`quote_snapshot`
- `created_at`、`updated_at`

`nodes`

- `id`、`board_id`、`node_type`
- `x`、`y`、`width`、`height`、`z_index`
- `title`、`body`、`color`、`source_ref_id`
- `version`、`created_at`、`updated_at`、`deleted_at`

`edges`

- `id`、`board_id`、`source_node_id`、`target_node_id`
- `relation`、`label`
- `version`、`created_at`、`updated_at`、`deleted_at`

`provenance_events`

- `id`、`workspace_id`、`board_id`、`node_id`、`actor_key`
- `event_type`、`payload_json`、`created_at`

来源快照用于解释历史画板，不取代 Altero 中的原始对象。重新加载时可以检测
原始 annotation version 是否变化，但不能静默覆盖用户在 Canvas 中写的内容。

### 3.2 类型约束

首批 node type：

- `annotation`
- `manual_note`
- `zotero_item`
- `attachment`
- `image`
- `ai_output`
- `group`

首批 edge relation：`related`、`supports`、`contradicts`、`causes`、`cites`、
`custom`。C1 后端保存这些类型；空间界面只需先实现最常用子集。

## 4. HTTP API

统一前缀为 `/canvas`，JSON 响应使用 `{ "data": ... }`，错误使用
`{ "error": { "code": "...", "message": "..." } }`。

Workspace 和 board：

- `GET /canvas/workspaces`
- `POST /canvas/workspaces`
- `GET /canvas/workspaces/:id`
- `PATCH /canvas/workspaces/:id`
- `DELETE /canvas/workspaces/:id`
- `GET /canvas/workspaces/:id/boards`
- `POST /canvas/workspaces/:id/boards`
- `GET /canvas/boards/:id`
- `PATCH /canvas/boards/:id`
- `DELETE /canvas/boards/:id`
- `GET /canvas/boards/:id/snapshot`

Node 和 edge：

- `POST /canvas/boards/:id/nodes`
- `PATCH /canvas/nodes/:id`
- `DELETE /canvas/nodes/:id`
- `PATCH /canvas/nodes/:id/restore`（撤销删除）
- `POST /canvas/boards/:id/edges`
- `PATCH /canvas/edges/:id`
- `DELETE /canvas/edges/:id`
- `PATCH /canvas/boards/:id/layout`（批量保存坐标和 viewport）

创建返回 `201`。删除采用 soft delete 并返回 `204`。snapshot 一次返回 board、
nodes、edges 和 source refs，供前端冷启动使用。

## 5. 并发、校验与审计

可修改资源有单调递增的整数 `version`。读取时发送 `ETag: W/\"<version>\"`；
更新和删除必须携带相同值的 `If-Match`：

- 缺失 `If-Match` 返回 `428 Precondition Required`。
- 版本过期返回 `412 Precondition Failed`。
- 批量布局在单个事务内完成，要么全部成功，要么全部回滚。

服务端约束 UUID、有限数值坐标、zoom 范围、允许的类型、字符串长度和 JSON
请求体大小。任何客户端字段都不能直接拼接 SQL。

关键创建、修改、删除和来源关联写入 append-only provenance event。事件载荷
只保存必要差异，不保存 access token、cookie 或完整身份声明。

## 6. 分阶段计划与退出条件

### S0：单人工作流稳定化（当前优先）

- 在继续增加功能前，收口 C1–C3 与 C5 已实现部分的安全、权限、隐私和真实交互问题。
- 修复 AI 端点 SSRF、浏览器长期保存密钥、导入来源越权、群组来源导航/状态等高风险缺陷。
- 自动测试必须从“代码结构存在”提升到关键行为验证；桌面 HTTPS 主流程由人工 UI 操作配合开发日志验收。
- S0 通过后，C1–C3 才能按退出条件重新标记完成；C5 只验收安全的单人 AI 工作流。

#### 2026-08-30 审计账本

| 阶段 | 当前判断 | 已通过 | 仍需验收或后续工作 |
| --- | --- | --- | --- |
| C0 | 完成 | 数据边界、权限、并发和分阶段退出条件已有基线 | 设计改变时持续更新本文 |
| C1 | 自动及首轮实机验收通过 | SQLite CRUD、owner 隔离、个人/群组来源权限、CSRF、`If-Match`、重启持久化测试；HTTPS 刷新恢复无异常 | 后续继续补充端到端浏览器测试 |
| C2 | 主流程实机验收通过 | 平移/缩放、节点增删改、连线、布局保存；删除与连线无成功弹窗且 Ctrl+Z 会真实写入服务端；刷新恢复通过 | 补充真正的浏览器交互测试和移动端可访问性验收 |
| C3 | 主流程完成 | 来源状态区分修改/删除/无权访问/错误；跨个人与群组文库路径；导入权限和拓扑校验；导出与 provenance API | 实机验证跨文献跳转、导出和历史；导出包完整性签名仍是后续增强 |
| C4 | 延期 | 仅保留未来演进边界 | 不实施成员、角色、共享或实时同步 |
| C5 | 安全基线完成 | AI 密钥仅在服务端；端点协议、私网/DNS、重定向、超时和响应大小受限；AI 产物及输入来源持久化 | 配置真实模型后做一次端到端生成验收；无模型配置时保持禁用 |
| 调试设施 | 自动验收通过 | 服务端/浏览器错误采集、失败请求摘要、去重、脱敏、路径标识清洗、2 MiB 轮转 | 实机操作后确认没有无意义噪声 |

本轮自动回归命令为 `npm test`，覆盖 BFF 单元与登录流程、个人/群组 PDF
Range、AI 端点边界、Canvas 持久化/API、UI 结构和开发日志。自动测试全部通过并不
替代真实浏览器交互，因此 C1–C3 暂不写成“最终验收完成”。

首轮 HTTPS 人工验收于 2026-08-30 05:13–05:15 UTC 完成。浏览器日志无新增错误；
数据库 provenance 依次记录 `edge.created` → `edge.deleted` 与 `node.deleted` →
`node.restored`，确认连线和卡片 Ctrl+Z 均完成服务端持久化，而非仅前端回滚。
刷新后布局与节点仍可读取。PDF 标注三点菜单删除未再触发历史上的 412/500 失败链。

第二轮 C3 验收发现两项竞态：跨文献切换后在 PDF 页面 viewport 就绪前定位标注，
以及导入新画板时旧画板的延迟布局保存继续执行。功能均可通过后续加载完成，但分别
留下 Reader `unhandledrejection` 和 Canvas `412`。布局保存现已绑定发起时的
board id，导入会取消旧定时器，并忽略已经切换画板后的迟到响应。Reader 顶层
`initializedPromise` 经实机确认在当前 vendor 版本中不会完成，因此不能阻塞普通 PDF
打开；现在仅在标注定位时轮询目标 PDF 页的 viewport，普通打开会立即完成。
自动回归通过，等待最小实机复验。

随后于 05:29–05:30 UTC 完成 PDF 打开与跨文献定位复验，浏览器日志仅有诊断连接
记录，没有新增 Reader、Fetch 或 Canvas 异常。C3 的跨文献跳转竞态据此关闭。

### 6.1 当前键盘操作

快捷键只在画板或 Reader 自己拥有焦点时生效，输入框、文本域和可编辑区域不会触发
删除或画板命令：

- Reader：沿用 vendor 原生 `Delete/Backspace` 删除选中标注。
- Canvas：`Delete/Backspace` 删除选中卡片；多选会形成一个可撤销操作。
- Canvas：`Ctrl/Cmd+Z` 撤销最近一次卡片删除或连线创建。
- Canvas：`Ctrl/Cmd+A` 全选卡片，`Escape` 清除选择并退出连线模式。
- Canvas：`N` 新建手写卡片，`C` 切换连线模式，`H` 打开历史。
- Canvas：方向键移动聚焦卡片，`Shift+方向键` 加大移动步长；`+`、`-`、`0`
  调整或重置缩放。

历史面板使用独立的 viewport 高度约束和内部滚动容器，不依赖可能未进入预编译 CSS
的任意值工具类。

快捷键与历史面板于 2026-08-30 05:39–05:43 UTC 完成实机验收。浏览器日志没有
新增错误；provenance 显示两卡片批量删除后产生两条 `node.restored`，三卡片批量
删除后一次撤销产生三条 `node.restored`，确认批量 Delete 与单次 Ctrl/Cmd+Z 的
服务端恢复语义正确。历史面板内部滚动、Reader 原生标注 Delete、Canvas 的 N/C/H
及选择快捷键均由人工操作通过。

### C0：设计基线

- 本文覆盖所有权边界、身份、schema、API、并发、权限和阶段验收。
- README 链接到本文，后续设计偏差必须更新文档。

### C1：持久化服务

- 独立数据库能够自动初始化和迁移。
- workspace、board、node 和 edge 可 CRUD 并在服务重启后保留；不可变的 source
  ref 可随 node 创建并由 snapshot 读取。
- 跨文档 annotation source 可共存于同一 board。
- owner 隔离、个人/群组来源权限、CSRF 和请求大小限制可自动验证。
- `If-Match` 的成功、缺失和冲突路径有自动测试。
- 原有 BFF、PDF Range 和 annotation 测试保持通过。

### C2：空间画板界面

- 当前右侧“批注卡片列表”升级为可平移、缩放的二维画布。
- 可从当前文档批注创建节点，也可创建手写节点。
- 节点拖动、缩放、删除和连线自动持久化。
- 切换文档不会清空已加入画板的卡片。
- 刷新页面后 viewport、节点位置和连线完全恢复。
- 键盘操作、焦点、移动端只读/编辑策略通过可访问性验收。

### C3：来源与恢复

- source ref 显示原文、页码、文献和 attachment 导航。
- 检测 Altero 批注变化、删除或无权访问，并显示明确状态。
- 支持画板导出/导入和可验证的 provenance 历史。

### C4：协作

- workspace member 角色为 owner/editor/viewer。
- 多用户写入使用可靠冲突策略；需要实时体验时引入同步层。
- 权限变化、分享和成员操作纳入审计日志。

当前决策：C4 延期。AltCanvas 近期以单人研究工作流为主，不为多人角色、共享、
实时同步或协作冲突增加复杂度；只有出现明确的多人使用需求时才重新排期。

### C5：AI

- AI 输出必须作为 `ai_output` 节点持久化。
- 每个输出记录模型、提示版本、输入 source refs 和生成时间。
- AI 不得绕过 workspace 权限，也不得把私有来源发送给未配置的外部服务。

## 7. 当前基线（开始实施前）

截至基线日期，应用已有当前文档的批注卡片列表、删除交互和可拖动面板，但
没有独立 Canvas 数据库、workspace/board/node/edge API、空间坐标持久化、
跨文档卡片或 provenance。因此：

- 批注卡片 MVP：约 65%。
- 空间 Canvas：约 10–15%。
- C1：0%，从本文批准后开始实施。

完成百分比只是沟通辅助；是否完成以各阶段退出条件为准。

## 8. 实施进度

2026-08-30 稳定化审计：

- C4 明确延期，不再作为当前里程碑。
- C1–C3、C5 的“核心实现”不等同于验收完成；当前进入 S0，优先修复安全和权限边界，再完成真实 UI 验收。
- C5 改为服务器端配置模型供应商和密钥；浏览器不得长期保存 AI Key，也不得为每次生成指定任意服务端请求地址。

2026-08-27：

- C0 已完成：本文及 README 索引已落盘。
- C1 已完成：独立 SQLite migration、OIDC actor identity、owner-only API、
  source 权限、soft delete、provenance、ETag/If-Match 和事务化布局已实现。
- C1 自动验收已覆盖数据库重开、owner 隔离、个人/群组来源、请求体上限、
  428/412、批量冲突回滚，以及原有 BFF/OIDC/PDF Range 回归。
- 主服务路由已实测未认证 `401` 和跨站写入 `403`。
- C2 核心实现已完成：右侧区域已升级为二维空间画板，支持默认
  workspace/board 初始化、snapshot 恢复、手写卡片、当前文档标注导入、节点
  拖动/缩放/删除、键盘移动、画布平移/缩放、关系连线和事务化布局保存。
- 切换文档只清空当前 Reader 的 annotation map，不再清空 Canvas snapshot；
  删除 Canvas 节点也不会删除 Altero 原始批注。
- C2 DOM/脚本结构测试、严格 CSP 页面提供和后端回归已通过。由于本次运行环境
  的浏览器无法连接临时本地服务，桌面与移动端视觉/手势验收仍需补做，因此
  C2 暂不标记为完全验收通过。

- C3 核心实现已完成：
  - 跨文档批注导航：在画板点击非当前打开文档的批注卡片 `↗` 按钮时，自动切入对应文献条目与 PDF 附件并精准高亮跳转。
  - Altero 批注状态感知：画板自动感知原批注删除 (`原注已删`) 或更新 (`原文已更`)，并在卡片上提供明确徽标，同时永久保留摘录快照与思考内容。
  - 画板导出与导入：提供 `GET /canvas/boards/:id/export` 生成包含 board、nodes、edges、sources 的 `.altcanvas.json` 标准 Bundle；提供 `POST /canvas/workspaces/:id/boards/import` 导入并重映射拓扑克隆画板；前端提供一键导出与文件选择导入。
  - Provenance 操作审计历史：提供 `GET /canvas/boards/:id/provenance` 与 `GET /canvas/workspaces/:id/provenance` 接口与前端历史面板，记录画板、节点、连线与导入全生命周期审计事件。
  - 全套单元测试与 UI 结构断言（5 套测试）全部通过，相关运行日志完整留存。

- C5 核心实现已完成（AI 空间研究助手与知识合成）：
  - AI 大模型端点配置：在设置中支持配置 OpenAI / DeepSeek / Ollama 兼容协议 Base URL、Model 与 API Key（本地保存），支持快速连接测试。
  - 空间多卡片选择与上下文关联：画板支持点击及 `Shift/Ctrl + 点击` 多选卡片，高亮发光边框，工具栏动态显示已选卡片数量与快捷 AI 操作入口。
  - AI 忠实学术中译 (Translate)：严格忠实原文逐句直译为学术中文，严禁删改、主观修饰或过度概括，自动生成带有回溯连线的 `ai_output` 翻译卡片。
  - 多卡片知识合成与对比 (Synthesize & Compare)：支持多篇文献卡片共性总结、观点与方法学对比分析，以及针对特定卡片的即时深入问答与解读。
  - 关系图谱与可解释性溯源：AI 输出卡片自动采用紫色标识与 `✨ AI 输出` 徽标，自动建立指向各输入卡片的关系连线，卡片底部提供“溯源输入”一键聚焦高亮原文献卡片；生成与翻译事件全量记录在 Provenance 审计日志中。
  - 自动化回归：全套 5 套测试（BFF、BFF 流程、Canvas 存储/API、Canvas UI、Dev Logger）100% 通过。
