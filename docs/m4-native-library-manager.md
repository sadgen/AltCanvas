# M4 Native 文件与文库管理实施方案

## 1. 目标与范围

M1、M1.5、M2、M3.0、M3.1、M3.2 已关闭。用户没有实际 Altero/Zotero
文库和迁移需求，因此取消外部迁移器，下一阶段直接实施 **M4 Native 文件与文库管理**。

产品最终只保留三个入口：

1. **原始文件**：真实磁盘目录和 PDF；
2. **文库**：文档元数据与主题分类；
3. **研究画板**：主题内阅读、批注、全文理解和观点关联。

M4 同时负责退出收件箱、Collection 绑定及 Altero/Zotero 运行时依赖。

## 2. 不可变产品规则

### 2.1 两个名称

每篇文档只维护两个名称：

- **原始文件名**：磁盘上当前真实文件名，例如 `report.pdf`；
- **文库文件名**：AltCanvas 中的显示名称，对应文档 title。

不增加第三个历史名称字段。

- 修改文库文件名不得修改磁盘文件；
- 用户可以显式重命名原始文件；
- AI、解析器、扫描器和主题分类不得自动修改原始文件名；
- 原始文件重命名后同步更新路径，PDF、批注、主题、分析与 Canvas 关系保持有效；
- 扩展名保持 `.pdf`。

### 2.2 文件夹只是真实目录

- 不新增虚拟文件夹或 Collection；
- 原始文件视图遍历配置根目录及其子目录；
- 同一真实目录不讨论“重复文件名”，因为文件系统本身不允许；
- 只有导入、移动或重命名的目标位置已经存在同名文件时，才产生目标冲突；
- 不同目录可以存在同名文件；
- 主题是唯一文库分类方式，保持单层；
- 同一文档可以归入多个主题，PDF 不复制。

### 2.3 内容去重

SHA-256 相同默认不加入文库：

- 不复制文件；
- 不创建第二篇文档；
- 不创建重复附件；
- 返回 `duplicate_content` 和已有文档/文件位置；
- UI 提供“打开已有文档”和“查看所在目录”；
- 不自动把已有文档加入当前主题，用户可随后正常归类。

若扫描发现多个真实路径的文件内容相同：

- 原始文件视图仍可展示磁盘上客观存在的副本；
- 文库只建立一个文档身份；
- 其他副本标记为“内容重复，未加入文库”；
- 不自动删除、移动或改名任何副本。

### 2.4 目标同名冲突

导入、移动或重命名时，如果目标目录已经存在同名文件：

- 先比较 SHA-256；
- 哈希相同：返回 `duplicate_content`，不执行操作；
- 哈希不同：返回 `filename_conflict`，不覆盖、不自动添加 `(2)`；
- UI 要求用户输入一个不冲突的新原始文件名后重试；
- 新名字仍冲突则继续阻断。

M4 不提供覆盖不同内容文件的功能。

### 2.5 取消收件箱

- 新文件直接进入文库；
- 导入时可选择零个、一个或多个主题；
- 未归入主题的文档通过“未分类”筛选呈现；
- 删除待处理、暂缓、忽略、采纳等收件箱状态；
- AI 主题建议成为文库批量操作，不依赖收件箱。

## 3. 核心界面

### 3.1 原始文件

左侧为授权根目录和真实目录树，右侧为文件列表。

列表字段：

| 字段 | 含义 |
| --- | --- |
| 原始文件名 | 当前磁盘文件名 |
| 文库文件名 | AltCanvas 文档名称；未入库时为空 |
| 所在目录 | 根目录下相对路径 |
| 所属主题 | 可为多个；未入库时为空 |
| 大小/修改时间 | 真实文件属性 |
| 状态 | 正常、重复未入库、缺失、损坏、回收站 |

操作：递归扫描、打开 PDF、打开所在目录、新建目录、移动、显式重命名、加入文库、
主题归类、移入回收站、恢复。

### 3.2 文库

左侧入口：全部、未分类、最近加入、无 PDF、文件缺失、分析已过期、主题列表、回收站。

中间列表显示：文库文件名、原始文件名、作者、年份、主题、原始路径、PDF/批注/AI
状态。

右侧详情支持：修改文库文件名、编辑元数据、查看并打开原始文件、主题多选、标签、
批注、全文分析、导入/文件操作历史以及删除操作。

### 3.3 研究画板

- 复用现有 workspaces、topic_documents 和 boards；
- 同一文档可以关联多个主题；
- 基础全文分析继续跨主题缓存复用；
- 各主题画板节点、布局和关系独立；
- 从主题移除文档不得删除文库记录或原始文件。

## 4. 导入流程

```text
选择本地 PDF / DOI / arXiv / URL / BibTeX / RIS
  -> 解析元数据并取得 PDF
  -> 选择目标真实目录
  -> 确认原始文件名与文库文件名
  -> 计算 SHA-256
  -> 相同哈希：不加入，返回已有文档
  -> 目标同名且不同哈希：要求修改原始文件名
  -> 原子写入目标目录
  -> 创建 source_file/document/attachment
  -> 可选关联主题
  -> 刷新原始文件和文库
```

导入弹窗增加：目标根目录、目标子目录、原始文件名、文库文件名、主题多选。

## 5. Schema v13

当前主线是 Schema v12。M4 使用独立 v13，不改写旧迁移含义。

### 5.1 `library_roots`

字段：`id, owner_key, display_name, absolute_path, scan_enabled, last_scan_at,
last_scan_status, version, created_at, updated_at, deleted_at`。

- 活跃 `(owner_key, absolute_path)` 唯一；
- 第一阶段由服务端 `NATIVE_LIBRARY_ROOTS` 配置；
- 客户端不得传任意绝对路径新增根目录。

### 5.2 `source_files`

字段：

```text
id, owner_key, root_id, document_id, attachment_id,
relative_path, filename, sha256, size_bytes, modified_at,
last_seen_at, status, version, created_at, updated_at,
missing_at, trashed_at, deleted_at
```

`status`：`active | duplicate | missing | unreadable | trashed`。

索引：

- 活跃 `(owner_key, root_id, relative_path)` 部分唯一；
- `(owner_key, sha256)` 内容索引；
- document/attachment 外键索引；
- `(owner_key, status, last_seen_at)` 扫描索引。

`filename` 必须等于 `relative_path` 的 basename，不增加其他名称字段。

### 5.3 `attachments`

增加 `source_file_id` 和 `storage_kind = managed_blob | source_file`。

- 旧数据继续使用 managed_blob；
- 新扫描/导入到真实目录的文件使用 source_file；
- Reader、Range、全文分析统一通过附件读取抽象访问内容；
- 前端不感知存储差异；
- M4 不强制搬迁旧 Blob。

### 5.4 `file_operations`

持久化文件系统操作：`id, owner_key, operation_type, source_file_id, source_path,
target_path, state, payload_json, error_code, started_at, completed_at, created_at,
updated_at`。

类型至少包括 `file.import/file.rename/file.move/file.trash/file.restore/library.scan/
library.reconcile`。启动时恢复 queued/running 操作。

## 6. 扫描与一致性

- 递归扫描 PDF，不跟随符号链接；
- 排除临时目录和 AltCanvas 回收目录；
- 按批次写库，不聚合完整大目录；
- 大小与 mtime 未变时不重新哈希；
- 新增/变化文件流式计算 SHA-256；
- 扫描完整成功后才推进检查点和标记 missing；
- 根目录离线或扫描失败时不得批量误标 missing；
- 旧路径消失且新路径哈希相同时，更新为移动/外部重命名，不创建新文档；
- 同哈希多路径只保留一个文库身份，其他 source file 标为 duplicate；
- missing 文件重新出现且哈希匹配时恢复 active。

## 7. 文件操作安全

所有路径必须基于授权 root 和相对路径生成，拒绝绝对路径、`..`、NUL、路径分隔符
伪装、符号链接逃逸和 realpath 越界。所有修改使用 If-Match。

### 重命名

- 用户显式输入新原始文件名；
- 同目录操作，扩展名保持 PDF；
- 目标存在时执行哈希/名称冲突规则；
- 文件系统成功后更新 DB；DB 失败则补偿改回；
- 不修改文库文件名；
- 记录 `file.renamed` provenance。

### 移动

- 默认保持文件名；
- 目标同名时阻断或按相同哈希去重；
- 同文件系统原子 rename；
- 跨文件系统执行复制、fsync、哈希复核、原子落位后再删除来源；
- 中断由 file_operations 恢复或回滚。

### 删除

区分四种行为：

1. 从主题移除：只删除 topic_document；
2. 从文库移除：文库解绑，原始文件保留；
3. 删除原始文件：移动到受控回收区；
4. 永久删除：二次确认后删除回收区文件并清理绑定。

## 8. API 设计

```http
GET  /canvas/native/library-roots
GET  /canvas/native/library-roots/:id/tree?path=&cursor=
POST /canvas/native/library-roots/:id/scan
POST /canvas/native/library-roots/:id/directories

GET    /canvas/native/source-files
GET    /canvas/native/source-files/:id
POST   /canvas/native/source-files/import
POST   /canvas/native/source-files/:id/rename
POST   /canvas/native/source-files/:id/move
DELETE /canvas/native/source-files/:id
POST   /canvas/native/source-files/:id/restore
DELETE /canvas/native/source-files/:id/permanent

GET   /canvas/native/documents?search=&topicId=&unclassified=&fileStatus=&cursor=
GET   /canvas/native/documents/:id
PATCH /canvas/native/documents/:id
POST  /canvas/native/documents/:id/topics
DELETE /canvas/native/documents/:id/topics/:workspaceId
POST  /canvas/native/documents/batch-topics
```

主要响应：201 created；409 duplicate_content；409 filename_conflict；412 版本冲突；
428 缺少 If-Match；400 invalid_path；503 library_root_unavailable。

## 9. 收件箱、Collection 与 Altero 退役

### UI

删除收件箱入口/徽标/modal/状态 tab、仅存入收件箱、Altero 扫描、Collection 绑定与
同步、Altero 登录和重新授权文案。

### 数据写入

- 新导入和扫描不写 inbox_entries；
- 主题归类直接写 topic_documents；
- “未分类”由不存在活跃 topic_document 的查询动态得出。

### 兼容迁移

- 检查现有 Native inbox 条目是否已有 document；
- 有价值元数据只在文档目标字段为空时回填；
- 无对应 document 的异常项生成迁移报告，不静默删除；
- v13 保留 inbox_entries/collection_bindings 为 deprecated 表；
- 旧 API 先返回 410 Gone，稳定一个版本后再删表。

删除运行时 Altero 代码前创建 `archive/last-altero-compatible` Git 标签。Native-only
测试必须证明零 Altero/Zotero 网络请求。

## 10. 实施阶段

### Phase 0：基线

读 handoff、本方案和 canvas-design；确认干净 v12 基线；运行 npm test 和
git diff --check；备份开发 DB/Blob；创建实施分支和 Altero 归档标签。

### Phase 1：v13 与读取抽象

实现 roots/source_files/file_operations；扩展 attachment；让 Reader/Range 同时支持旧
Blob 和源文件；完成 Fresh、v12→v13、重复启动与外键测试。

### Phase 2：扫描器

实现真实目录树、分页增量扫描、SHA-256 去重、移动/外部改名识别、missing/duplicate
状态、检查点和冷启动恢复。

### Phase 3：文件操作与导入落点

实现导入到真实目录、冲突阻断、用户改名重试、重命名、移动、回收与恢复；M2/M3.2
解析、PDF 下载、去重和补偿能力必须复用，不能复制第二套执行器。

### Phase 4：前端

实现原始文件目录树、文库列表/详情、两个名称显示、主题多选、未分类、批量操作、冲突
改名对话框和回收站。

### Phase 5：退役旧功能

停止旧表写入，核验遗留数据，删除收件箱/Collection/Altero UI，旧 API 变为 410，删除
Altero 运行时分派并更新配置与文档。

### Phase 6：验收

全量测试、systemd 重启、人工操作、检查 `.debug/dev.log` 与 `.debug/browser.log`，清理
一次性诊断并更新 handoff。

## 11. 必须通过的验收

1. 多层真实目录扫描完整，失败不误推进；
2. 修改文库文件名时磁盘文件名不变；
3. 用户重命名原始文件后 Reader、批注、分析和 Canvas 来源仍有效；
4. 相同哈希加入返回 duplicate_content，document/attachment 计数不增；
5. 扫描到同哈希物理副本时只建立一个文库身份，副本仍在原始文件视图可见；
6. 导入/移动/改名目标存在不同哈希同名文件时返回 filename_conflict；
7. 用户输入无冲突的新原始文件名后才能成功；系统从不自动生成 `(2)`；
8. 同一文档归入两个主题时只有一份 PDF；
9. 未归类文档正确出现在“未分类”；
10. 从主题移除不影响文档和文件；从文库移除不删除文件；
11. 回收与恢复保留路径、文库名称、主题、批注和分析；
12. 外部移动/改名按哈希识别，不创建重复文档；
13. 根目录离线不误标或误删；
14. 路径穿越、符号链接逃逸、TOCTOU 和中断补偿测试通过；
15. 旧 managed Blob 支持 Reader、Range、批注和全文分析；
16. UI 正确显示原始文件名、文库文件名和多主题；
17. 页面不再出现收件箱、Collection 或 Altero 授权/扫描入口；
18. 页面启动不调用 inbox/collection 接口，运行期零 Altero/Zotero 请求；
19. M1–M3.2 全部回归保持通过；
20. 人工日志验收无新增错误。

## 12. 完成定义

只有真实目录管理、双名称模型、内容去重、目标同名改名重试、多主题零复制、收件箱与
Collection 退役、Altero/Zotero 运行时解除、Schema v13 安全迁移、旧 Blob 兼容、自动化
及人工日志验收全部通过，M4 才能标记 PASS。

