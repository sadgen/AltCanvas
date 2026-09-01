# AltCanvas 主题研究工作台：产品与实施方案

状态：已形成实施基线，等待按阶段开发
日期：2026-08-31

## 1. 产品结论

AltCanvas 采用“Altero 文献底座 + Canvas 研究工作台”的边界：

- Altero 是报告、PDF、条目元数据、Collection、标签和正式批注的唯一事实来源。
- AltCanvas 不复制或取代文库；它保存主题、报告与主题的关系、处理状态、观点卡片、
  证据关系、布局、AI 产物和来源记录。
- 现有 `workspace` 直接成为一个“研究主题”，其下的 `board` 表示该主题中的一次分析、
  一个问题、一个争议或一个阶段性成果。
- 同一份 Altero 报告可以加入任意多个主题；每个主题可以形成不同观点和关系，但都引用
  同一个 Altero 条目和附件。
- 产品默认进入全屏 Canvas。PDF Reader 从常驻主面板变为按需出现的证据预览、PDF
  弹窗和完整阅读模式。

核心原则：**Altero 管“拥有哪些资料”，AltCanvas 管“如何用这些资料研究”。**

## 2. 用户工作流

### 2.1 常规批量入库：Altero → AltCanvas

这是第一优先级、默认工作流：

1. 用户通过 Altero、Zotero 同步、浏览器采集或其他既有入口批量加入报告。
2. AltCanvas 手动刷新或按可配置周期检查增量。
3. 未处理报告进入“研究收件箱”，不自动铺到任何画板。
4. AI 先基于标题、摘要、作者、年份、Collection、标签和目录给出多主题建议。
5. 用户可以批量接受、调整、暂缓或拒绝建议。
6. 报告加入主题后，只创建轻量文献引用；全文理解由用户显式触发，或在用户开启的
   自动化策略下排队执行。

### 2.2 研究中快速加入：AltCanvas → Altero

Canvas 提供拖入 PDF、选择本地文件、粘贴 DOI/URL 的入口，但底层必须先写入 Altero：

1. 检查 DOI、规范化 URL、标题/年份和文件指纹，提示疑似重复。
2. 在 Altero 创建或复用条目。
3. 上传/关联 PDF 附件。
4. 可选加入绑定的 Altero Collection。
5. 将返回的 `(libraryType, libraryId, itemKey, attachmentKey)` 关联到当前主题。
6. 用户选择是否立即生成全文理解卡片。

AltCanvas 不允许出现“只存在 Canvas、Altero 中找不到”的正式报告。若上传中途失败，
显示可重试的导入任务，不创建伪成功的主题成员。

当前 BFF 已支持 Zotero 兼容条目/Collection 读取、条目写请求转发和 PDF 读取；完整附件
上传的 Altero 契约尚未完成兼容性验证。因此 AltCanvas 文件拖入必须经过第 10.1 节的
兼容性闸门，不能先按 Zotero 官方上传流程作未经验证的假设。

### 2.3 主题研究

用户进入主题后看到：

- 主题说明：研究问题、纳入范围、排除范围和可选分类规则。
- 报告区：已加入、待理解、理解中、已理解、失败、疑似更新。
- 画板区：概览、章节、概念、论点、证据和跨报告关系。
- 筛选器：报告、作者、年份、Collection、标签、关系类型、处理状态和置信度。
- 折叠的相关研究入口，例如“相关观点 5”“冲突证据 3”，默认不自动展开。

同一报告进入多个主题时，共享文献身份、附件和可复用的基础全文分析；主题内解释、
卡片选择、关系、布局和研究结论彼此独立。

## 3. Collection、标签、主题和 Board 的语义

| 对象 | 事实来源 | 主要用途 | 是否多对多 |
| --- | --- | --- | --- |
| Altero Collection | Altero | 人工文献目录、资料来源 | 一篇报告可在多个 Collection |
| Altero 标签 | Altero | 稳定属性与跨工具检索 | 一篇报告可有多个标签 |
| AltCanvas 主题/workspace | AltCanvas | 持续研究问题和知识空间 | 一篇报告可在多个主题 |
| AltCanvas board | AltCanvas | 主题内某次分析或输出 | 一个主题可有多个 board |

### 3.1 Collection 绑定模式

一个主题可以绑定零个或多个 Collection。每个绑定独立选择模式：

1. `inbound`（默认）：Collection 新成员进入主题收件箱；Canvas 不反向修改 Collection。
2. `confirm_both`：双向建议、人工确认。Canvas 加入报告时建议写回 Collection；从主题
   移除只解除主题关系，不删除 Altero 对象。
3. `mirror`（高级）：Collection 成员与主题成员自动保持一致。仍然禁止删除报告或 PDF；
   移出 Collection 只把主题成员标为“来源已移除”，是否解除由用户策略决定。

初期只实施 `inbound` 和 `confirm_both`。`mirror` 在真实使用验证后再开放。

Collection 绑定不是主题身份：重命名、解除绑定或更换 Collection 都不能删除主题、
Board 或既有卡片。

### 3.2 标签策略

- Altero 中已有的人工标签只读展示并可用于过滤。
- AI 建议标签先保存在 AltCanvas，不自动写回 Altero。
- 用户明确接受后，才通过 Zotero 兼容写接口更新条目标签。
- `待理解`、`处理中`、置信度、支持/反驳等属于 AltCanvas 内部状态，不写入 Altero，
  避免污染标签列表。
- 标签匹配采用规范化比较，但保留 Altero 原始拼写；近义标签只建议合并，不自动改名。

## 4. 信息架构与界面

### 4.1 顶层导航

桌面端主导航调整为：

- 收件箱
- 主题
- Altero 文库
- 当前研究
- 设置

“当前研究”进入 Canvas-first 工作区。现有三栏结构不一次性推倒重写：第一阶段先允许
收起文库和 Reader，让 Canvas 占满可用空间；随后将文库改为抽屉、Reader 改为浮层。

### 4.2 研究收件箱

收件箱统一展示：

- Altero 最近新增
- AltCanvas 导入任务
- 等待 AI 分类
- 等待全文理解
- 疑似重复
- 处理失败

批量操作包括：加入一个或多个主题、创建主题、接受 AI 建议、添加/接受标签、全文理解、
暂缓和忽略。忽略只影响当前收件箱，不修改 Altero。

### 4.3 Canvas-first 与 PDF 三层呈现

1. **证据悬浮预览**：悬停页码或引用时，按需渲染引用矩形附近的局部 PDF 图像，显示
   前后文和高亮。低性能或触屏设备用点击代替悬停。
2. **PDF 浮层**：点击证据后打开可调整大小的 Reader 浮层，直接定位页码和引用，可翻页、
   搜索、划线和转正式批注；关闭后恢复原 Canvas 视口和选择状态。
3. **完整阅读模式**：需要连续精读时进入全屏 Reader 或 Reader/Canvas 分栏。

局部图像只能是缓存和视觉预览，不能成为来源本身。来源仍保存文献、附件、页码、逐字
引用、字符位置/矩形和版本；PDF 更新后可重新渲染并提示来源变化。

### 4.4 渐进展开与防止无限画布失控

- 当前报告的理解图正常展开，外部报告默认只显示聚合入口。
- 每张卡片初始最多展示 3–5 条外部关系，其余归入计数节点。
- 支持按报告或论点折叠、固定节点、隐藏弱关系和“仅显示证据路径”。
- 只渲染当前视口及缓冲区节点；折叠节点不参与 DOM 渲染。
- AI 收缩必须生成可逆的摘要层，不能删除原卡片或来源。
- 每个 Board 配置“可见节点预算”，超过预算时建议聚合，不强制改变用户布局。

未来的摘要层可组织为“共识、争议、方法分组、时间变化、证据缺口”。展开摘要后仍能
逐级到报告观点和 PDF 原文。

## 5. AI 能力与边界

### 5.1 多主题分类

分类输入按成本和隐私分级：

1. 默认：标题、摘要、作者、年份、Collection、标签。
2. 必要时：目录和有限正文片段。
3. 全文：仅在用户主动全文理解，或明确开启相应自动化时发送。

输出必须是多选建议：主题 ID、置信度、简短理由、使用的提示版本和输入级别。AI 不得
自行新建大量主题；只在没有合适主题时建议新主题名称，并等待确认。

自动化策略：

- 默认“建议后确认”。
- 用户可以为某个 Collection 开启“高置信度自动加入”，阈值默认不低于 0.9。
- 拒绝和人工调整记录为分类反馈，但在引入可解释的本地规则/评估集前，不进行隐式在线
  模型训练。

### 5.2 可复用全文理解

将全文理解分为两层：

- **文档基础分析**：与主题无关的摘要、章节、概念、候选论点和逐字证据锚点；按附件
  版本和提示版本缓存，避免同一 PDF 在多个主题重复付费分析。
- **主题投影**：依据主题问题、纳入/排除范围，从基础分析中选择、重述组织和建立关系；
  主题内产物可独立编辑。

基础分析更新不能静默覆盖用户编辑的主题卡片。新 PDF 版本或新分析版本只标记“可更新”，
由用户选择重建、合并或保留。

### 5.3 跨报告观点关联

检索单位是经过原文核验的知识单元，而不是只做整篇报告相似度：

- 论点
- 证据
- 方法
- 研究对象/样本
- 结论
- 限制条件

关系类型第一批支持：`supports`、`contradicts`、`extends`、`same_method`、
`same_evidence`、`context_differs`、`related`。AI 关系包含置信度和理由，但用户确认、
修改后的关系优先级更高。

任何跨报告观点卡片必须能够追溯到 Altero 报告、附件、页码和逐字证据；无证据的模型
推断必须明确标为“研究提示”，不能伪装成报告观点。

## 6. 数据模型演进

沿用现有 owner-only、SQLite、软删除、版本并发和 provenance 机制。建议以 schema v3
引入主题/收件箱，以后续 migration 引入知识索引，避免一次迁移过大。

### 6.1 复用现有实体

- `workspaces`：语义升级为主题；新增主题说明字段，不改变已有 ID。
- `boards`：继续表示主题下的具体画板。
- `source_refs`：继续作为 Altero 来源快照；不保存 PDF 二进制。
- `nodes` / `edges`：继续保存 Board 上可见卡片与关系。
- `provenance_events`：扩展主题成员、同步、分类、分析和聚合事件。

### 6.2 第一阶段新增字段和表

`workspaces` 新增：

- `description`：主题说明
- `research_question`：主要研究问题
- `inclusion_rules`、`exclusion_rules`：AI 分类边界

`topic_documents`

- `id`、`workspace_id`、`owner_key`
- `library_type`、`library_id`、`item_key`、`attachment_key`
- `status`：`inbox` / `accepted` / `deferred` / `ignored` / `removed`
- `analysis_status`：`not_started` / `queued` / `running` / `ready` / `failed` / `stale`
- `origin`：`collection_sync` / `canvas_import` / `manual` / `ai_suggestion`
- `classification_confidence`、`classification_reason`
- `item_version`、`attachment_version`、`created_at`、`updated_at`、`deleted_at`
- 唯一约束：活跃记录上的 `(workspace_id, library_type, library_id, item_key)`

`collection_bindings`

- `id`、`workspace_id`、`owner_key`
- `library_type`、`library_id`、`collection_key`
- `mode`：`inbound` / `confirm_both`
- `last_library_version`、`last_synced_at`、`enabled`
- 唯一约束：`(workspace_id, library_type, library_id, collection_key)`

`inbox_entries`

- `id`、`owner_key`、文献身份四元组、`detected_from`
- 元数据快照：标题、作者、年份、摘要、Collection keys、标签、item version
- `state`：`new` / `classifying` / `ready` / `accepted` / `deferred` / `ignored` / `failed`
- `first_seen_at`、`updated_at`

元数据快照是索引和审计用途，不取代 Altero。显示详情时优先刷新 Altero 当前对象。

`jobs`

- `id`、`owner_key`、`job_type`、`resource_type`、`resource_id`
- `state`、`attempts`、`available_at`、`started_at`、`finished_at`
- 脱敏的 `error_code`、有限 `result_summary_json`

它为增量同步、分类和全文理解提供可恢复队列。任务载荷不保存整篇 PDF 文本或模型响应。

### 6.3 第二阶段知识索引

`document_analyses`

- 文献/附件身份与版本、分析版本、模型和提示版本
- 状态、有限结构统计、创建时间

`knowledge_units`

- `analysis_id`、类型、标题、正文、页码范围、逐字引用、位置数据
- embedding 或检索向量引用、版本、生成/人工来源

`knowledge_relations`

- 两个知识单元、关系类型、置信度、理由、模型/人工状态

`nodes` 增加可空的 `knowledge_unit_id`，表示 Board 卡片是知识单元的主题投影。用户编辑
仍保存在 node，不回写覆盖基础知识单元。

向量索引在数据规模证明需要后再选型；第一版可用 SQLite FTS + 元数据过滤 + AI rerank，
避免过早引入独立向量服务。

## 7. API 设计

### 7.1 主题和 Collection 绑定

- `GET/PATCH /canvas/workspaces/:id`：扩展主题说明和分类规则。
- `GET /canvas/workspaces/:id/collection-bindings`
- `POST /canvas/workspaces/:id/collection-bindings`
- `PATCH/DELETE /canvas/collection-bindings/:id`
- `POST /canvas/collection-bindings/:id/sync`

### 7.2 收件箱和主题成员

- `GET /canvas/inbox?state=&collection=&cursor=`
- `POST /canvas/inbox/scan`
- `POST /canvas/inbox/classify`
- `POST /canvas/inbox/batch-action`
- `GET /canvas/workspaces/:id/documents`
- `POST /canvas/workspaces/:id/documents`
- `PATCH/DELETE /canvas/topic-documents/:id`

批量操作必须事务化返回逐项结果；对 Altero 的外部写入不能和 SQLite 假装组成单一事务，
应使用可重试 job 和幂等键补偿。

### 7.3 分析、关联和展开

- `POST /canvas/topic-documents/:id/analyze`
- `GET /canvas/document-analyses/:id`
- `POST /canvas/workspaces/:id/related-knowledge`
- `POST /canvas/boards/:id/expand-related`
- `POST /canvas/boards/:id/collapse`
- `POST /canvas/boards/:id/ai-summary-group`

现有 `/canvas/boards/:id/ai/document-map` 在迁移期保留，内部逐步改为“基础分析 + 主题投影”。

### 7.4 AltCanvas 导入

- `POST /canvas/imports/resolve`：DOI/URL/文件元数据与去重候选。
- `POST /canvas/imports`：建立可恢复导入任务。
- `GET /canvas/imports/:id`：查询进度和错误。
- `POST /canvas/imports/:id/retry`

文件上传必须走专用受限端点，不复用当前 1 MiB JSON API 代理；限制 MIME、大小、并发、
超时和临时文件生命周期，并在上传完成或失败后清理。

所有写接口继续要求同源 CSRF 检查；Canvas 资源继续使用 `If-Match`。后台 job 使用幂等
键和状态机，不让浏览器持有 Altero token 或 AI key。

## 8. 增量同步与冲突规则

### 8.1 增量发现

优先使用 Zotero 兼容的 library version / `since` 增量语义；若 Altero 未实现，则退化为
带分页的最近修改扫描。每个绑定保存游标和最近成功时间。同步必须覆盖分页，不能沿用当前
首页 `limit=100` 作为完整文库扫描。

### 8.2 冲突原则

- Altero 元数据和 Collection 成员关系以 Altero 当前版本为准。
- AltCanvas 主题成员、分类决定、Board 内容和布局以 AltCanvas 为准。
- 从主题移除绝不删除 Altero 条目、附件、标签或批注。
- Altero 报告删除/无权访问时，保留来源快照并显示状态，不删除卡片。
- PDF 或条目版本变化时，标记分析 `stale`，不静默重跑或覆盖。
- Collection 双向写失败时保持主题成员成功，但显示“Collection 尚未同步”，由 job 重试。

### 8.3 去重

候选匹配优先级：稳定 item key → DOI → 规范化 URL → 文件指纹 → 标题/作者/年份模糊匹配。
除稳定 item key 或完全一致 DOI 外，不自动合并，只提示用户选择。群组文库与个人文库中的
对象即使内容相同也保持不同身份，避免权限混淆。

## 9. 隐私、安全和成本

- 常规收件箱扫描不向 AI 服务发送数据。
- AI 分类默认只发送界面明确披露的元数据层级；全文必须单独授权或显式开启自动化。
- 用户未配置 AI 时，收件箱、Collection 同步和人工归类仍完整可用。
- AI 日志、job 错误和 provenance 不保存摘要全文、PDF 正文、模型响应或密钥。
- 跨报告检索只访问当前 owner 有权读取的来源；群组权限每次读取和展开时重新校验。
- 预览图存为短期私有缓存，按 owner 和附件版本隔离，响应禁止公共缓存。
- 后台处理需要并发、重试次数和每日预算上限；批量任务开始前显示预计报告数和正文发送范围。

## 10. 分阶段实施

### 10.1 T0：Altero 兼容性闸门

目标：确认设计所依赖的上游能力，不写 UI 假流程。

- 验证 Collection 分页、条目 Collection/标签 PATCH、library version/`since` 行为。
- 验证父条目创建、PDF 附件创建和完整文件上传协议。
- 验证重复写入、并发版本冲突、失败清理和最大附件限制。
- 将安全探针扩展为不记录私人条目内容的能力矩阵。

退出条件：明确标记每项为支持、需要适配或暂不支持；附件上传未通过前隐藏 Canvas 文件
导入，只保留“在 Altero 添加后刷新”。

### 10.2 T1：主题化与研究收件箱（首个可用版本）

- workspace 主题字段和编辑 UI。
- Collection `inbound` / `confirm_both` 绑定。
- 增量扫描、分页、收件箱和人工批量多主题归类。
- 主题报告状态、过滤和来源状态。
- Canvas 全屏/Reader 收起模式。
- provenance、owner 隔离、重启恢复和同步失败重试。

退出条件：用户能向 Altero 扔一批报告，AltCanvas 发现全部增量，批量加入多个主题；刷新和
重启不丢状态；任何操作不删除或复制 Altero 报告。

### 10.3 T2：AI 分类与分析复用

- 主题分类规则和多选建议。
- 元数据级 AI 分类、批量确认和高置信度可选自动加入。
- durable job 队列、取消/重试、成本与隐私提示。
- 文档基础分析缓存和现有 document-map 的兼容迁移。

退出条件：同一附件进入两个主题时基础全文分析只执行一次；两个主题得到独立可编辑投影；
AI 失败不影响人工归类。

### 10.4 T3：跨报告关联与渐进展开

- 知识单元索引、同主题召回和关系建议。
- 支持/反驳/补充/方法与情境差异关系。
- 聚合入口、节点预算、过滤和按需展开。
- 每条外部观点的逐字证据与 PDF 定位。

退出条件：用户可从一个观点展开相关研究，所有报告观点均能回到真实来源；默认画板不会
因为后台分析完成而突然无限扩张。

### 10.5 T4：Canvas 导入与 PDF 浮层

- 在 T0 上传能力通过后开放拖入 PDF、DOI/URL 导入和疑似重复处理。
- 引用局部预览缓存、Reader 浮层、完整阅读模式。
- 触屏、键盘、焦点、内存与大型 PDF 验收。

退出条件：Canvas 导入最终在 Altero 可见；失败可恢复且无孤儿附件；从卡片悬浮预览、
弹窗核验到完整阅读的来源定位一致。

### 10.6 T5：可逆 AI 收缩

- 共识、争议、方法、时间和证据缺口摘要层。
- 固定/折叠/恢复、摘要过期提示和增量刷新。
- 用户确认后才替换当前可见布局；原节点和 provenance 永久保留。

## 11. 测试与验收矩阵

自动测试至少覆盖：

- 一篇报告加入多个主题，不复制来源对象。
- 一个主题绑定多个 Collection、分页增量和游标恢复。
- owner/group 权限、Collection 越权和来源权限变化。
- 多选 AI 分类、人工覆盖、未配置 AI 的降级。
- job 幂等、进程重启、重试上限和部分上游失败。
- 条目/附件版本变化、Collection 移除、Altero 删除和无权访问。
- 基础分析复用、主题投影隔离和用户编辑不被覆盖。
- 跨报告关系只引用可验证证据。
- 折叠/展开不丢节点、边、来源和布局。
- 导入去重、超大/错误 MIME、上传中断和临时文件清理。

UI 按 `docs/human-in-loop-debugging.md` 进行最短人机闭环，重点实机验证：批量收件、主题
多选、同步失败提示、全屏 Canvas、PDF 浮层、悬浮延迟、触屏替代交互和大型画板性能。

建议性能基线：收件箱首次展示不等待 AI；默认画板只渲染视口附近节点；1000 个持久化
节点的折叠 Board 仍可在普通桌面浏览器流畅打开；具体帧率和内存阈值在 T3 前用真实数据
测量后冻结。

## 12. 首轮开发拆分

按可独立合并的顺序：

1. Altero Collection/标签/附件写能力探针与测试夹具。
2. schema v3：主题字段、`topic_documents`、`collection_bindings`、`inbox_entries`、`jobs`。
3. 主题与 Collection 绑定 API、权限/并发/审计测试。
4. 分页增量扫描和 durable job runner。
5. 收件箱 UI、人工批量多主题归类。
6. 主题报告列表、状态筛选和 Canvas 全屏模式。
7. 元数据级 AI 分类和确认流。
8. 文档基础分析缓存与现有全文理解迁移。

首个实施切片建议只完成 1–5：它已经能验证最核心的真实使用方式——“间歇性向 Altero
扔一批报告，AltCanvas 稳定发现并整理进多个研究主题”，同时不把 PDF 上传、向量检索、
跨报告图谱和 Reader 改造绑在同一个高风险版本中。

## 13. 暂不实施

- 实时多人协作和共享主题，继续沿用 C4 延期决定。
- AI 自动删除卡片、证据或来源。
- 未经确认的大规模 Altero 标签写回。
- 在 Canvas 数据库保存 PDF 二进制或形成第二文库。
- 未验证 Altero 文件协议前的“看似成功”拖入上传。
- 为第一版提前部署独立向量数据库或分布式任务系统。
