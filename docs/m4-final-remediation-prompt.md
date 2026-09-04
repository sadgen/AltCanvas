# M4 Native 文库终审整改实施 Prompt

请在 `/home/sadgen/Projects/AltCanvas` 的 `feat/m4-native-library` 分支继续完成 M4 收敛。

开始前完整阅读：

- `AGENTS.md`
- `docs/handoff.md`
- `docs/human-in-loop-debugging.md`

当前已知基线提交为 `0a6817b`。实际开工时先核对分支、HEAD 和工作区状态；禁止覆盖用户未提交的修改。

完成代码、测试、文档和服务重启，但不要自行宣布 M4 `PASS`。自动化通过后仍须保留人工实机验收和日志复核闸门。

## 一、本轮目标

一次性完成以下工作：

1. 修复日志确认的两个 P1 前端回归；
2. 修正掩盖这些回归的 UI 测试；
3. 将所有成功获得 PDF 的网页导入统一归档到“原始文件 / 网页导入”；
4. 消除 Blob-only 导入与目录归档两套相互矛盾的用户语义；
5. 安全处理已经存在的 Blob-only 网页导入 PDF；
6. 完成自动化验证后，交给用户做最短实机验收，再根据日志决定是否关闭 M4。

## 二、修复当前日志确认的 UI 回归

### P1-1：收件箱退役后登录初始化仍调用 `loadInboxEntries`

最新浏览器日志：

```text
2026-09-03T23:53:51.102Z
ReferenceError: loadInboxEntries is not defined
at initCanvasWorkspace (.../:4543:9)
```

根因：

- M4 已退役收件箱 UI 和运行时函数；
- `index.html` 的 `initCanvasWorkspace()` 仍执行 `await loadInboxEntries()`；
- 登录后画板初始化因此失败。

修复要求：

1. 删除 `initCanvasWorkspace()` 中对 `loadInboxEntries()` 的调用；
2. 清理 `index.html` 中全部残留的 `loadInboxEntries` 调用，包括用 `typeof` 包裹的遗留兼容代码；
3. 不得重新增加空的 `loadInboxEntries()` 函数掩盖问题；
4. 更新注释和 `docs/handoff.md`，明确收件箱运行时已经完全退役；
5. 登录初始化顺序继续保持：

```text
loadAiConfig
→ initCanvasWorkspace
→ loadCollectionsAndLibrary / Native 文库
→ updateAuthUI
```

### P1-2：快速导入仍操作已删除的收件箱按钮

最新浏览器日志：

```text
2026-09-03T23:53:57.153Z
2026-09-03T23:55:27.774Z

TypeError: Cannot set properties of null (setting 'disabled')
at openQuickImportModal (.../:6113:29)
```

根因：

- `btn-quick-import-inbox-only` 已从 DOM 删除；
- `openQuickImportModal()`、`resolveQuickImport()`、`executeQuickImport()` 仍读取和操作该按钮。

修复要求：

1. 从快速导入的打开、解析、执行和异常恢复路径彻底删除 `btnInboxOnly`；
2. 不得只用可选链绕过，必须清除已经退役的产品语义；
3. 当前真实操作按钮是：
   - “导入并加入当前主题”；
   - “解析并归档到目录”；
4. 弹窗打开且尚未解析文献时，两者保持禁用；
5. 解析成功后：
   - 当前主题存在时启用“导入并加入当前主题”；
   - 存在可用 Native 根目录时启用目录归档操作；
   - 解析失败时保持禁用；
6. 导入执行期间禁用对应按钮，完成或失败后恢复正确状态；
7. 清理全部已经退役的“导入收件箱”变量、监听器和文案。

## 三、统一网页导入 PDF 与“原始文件”模型

### 3.1 产品规则

AltCanvas 只保留两层名称：

1. **原始文件名**：磁盘上的真实文件名；
2. **文库文件名**：文库中显示、可独立修改的标题或名称。

不得引入第三套名称。

所有通过网页快速导入并成功取得 PDF 的来源，包括：

- URL；
- DOI；
- arXiv；
- BibTeX；
- RIS；
- Translation Server 返回的 `pdfUrl`；

都必须默认进入：

```text
研究文库/
└── 网页导入/
```

凡是成功获得 PDF 的网页导入，都必须在“原始文件”视图中可见，不能只写入内容寻址 Blob 而绕过 `source_files`。

如果只有元数据、没有可下载 PDF：

- 允许创建 Native 文库文档；
- 标记为“无 PDF”；
- 不创建虚假的 `source_file`；
- 不显示在原始文件列表中；
- 允许以后补充 PDF。

### 3.2 默认目录行为

1. 使用当前启用的 Native 根目录；
2. 默认子目录固定为 `网页导入`；
3. 目录不存在时通过既有安全目录原语创建；
4. 必须继续执行逐级符号链接拒绝、realpath 根边界验证和 TOCTOU 防护；
5. 用户可以展开高级目录选项并选择其他子目录，但默认导入不应要求用户手动选择目录；
6. 前端明确显示默认落点，例如：

```text
保存位置：研究文库 / 网页导入
```

如存在多个启用的 Native 根目录，应使用 UI 当前选择的根目录；未选择时使用确定性的默认根目录，不得随机选择。

### 3.3 文件名规则

原始文件名的候选优先级：

1. 安全、可信的 HTTP `Content-Disposition` 文件名；
2. PDF URL 路径中的文件名；
3. 根据文库标题生成的安全文件名；
4. 最后回退为确定性名称，例如 `<document-id>.pdf`。

要求：

- 最终必须是安全的 `.pdf` 文件名；
- 过滤路径分隔符、控制字符、NUL 和危险名称；
- 禁止客户端提交绝对路径或 `..`；
- 不自动追加 `(2)`；
- 不静默覆盖。

冲突规则：

1. **相同 SHA-256**：
   - 默认不重复导入；
   - 复用既有文档、附件和原始文件；
   - 返回明确的 `reused` 或 `duplicate_content` 结果；
   - 不落第二份文件。
2. **不同 SHA-256，但同一目标目录文件名相同**：
   - 返回 `409 filename_conflict`；
   - 前端要求用户修改原始文件名后重试；
   - 禁止覆盖；
   - 禁止自动生成 `(2)`。
3. 不同子目录允许存在同名文件，这是正常文件系统语义。

### 3.4 数据模型不变量

任何成功归档的网页 PDF 必须满足：

```text
document
  → active attachment
  → storage_kind = source_file
  → source_file_id
  → library_root + relative_path
  → 磁盘真实 PDF
```

同时满足：

- `source_files.document_id` 与 attachment/document 身份一致；
- 主题关联继续指向同一 Native document，不复制 PDF；
- 同一文档进入多个主题时只保留一份原始文件；
- 文库文件名修改不能修改磁盘文件名；
- 原始文件重命名不能自动修改文库文件名；
- PDF 阅读、Range 请求、批注、全文分析和跨主题分析缓存继续工作。

### 3.5 统一执行路径

不得复制第二套导入器。必须复用现有：

- `executeNativeImportItem`；
- M2 去重链；
- 安全 PDF 下载；
- `fileTarget` 分支；
- Blob/数据库失败补偿；
- `source_files` 和文件操作安全原语。

“导入并加入当前主题”也应调用同一执行器。取得 PDF 时自动附加等价目标：

```js
{
  targetWorkspaceId,
  fileTarget: {
    rootId: defaultNativeRootId,
    targetDir: '网页导入',
    filename: resolvedSafeFilename
  }
}
```

没有 PDF 时走 metadata-only 分支。

可以保留高级目录选择，但“普通导入”和“归档到目录”不得形成两套不一致的后端生命周期。

## 四、安全处理既有 Blob-only 网页导入 PDF

先审计真实数据库、附件来源字段和数据量，再实现安全、幂等的迁移/归档机制：

1. 只处理确实来自网页、DOI、arXiv、BibTeX、RIS 或 Translation Server 导入，且当前仍为 Blob-only 的 PDF attachment；
2. 默认归档到 `网页导入` 目录；
3. 使用安全文件句柄、哈希校验和排他创建；
4. 数据库更新成功前不得删除原 Blob；
5. 数据库更新失败时删除本次新建的目录文件，并保持原 Blob 可读；
6. 成功后 attachment 切换为 `source_file` 存储，确认读取、Range、批注和全文分析仍正常；
7. 重复执行必须幂等；
8. 目标文件名冲突且哈希不同时，不得自动改名，记录为待用户处理的冲突；
9. 如果启动时自动迁移风险过高，可实现显式的一次性管理命令或持久化后台任务，但必须在 UI 或管理结果中显示待处理数量，不能静默遗漏；
10. 输出迁移报告：扫描数、迁移数、复用数、冲突数、失败数；禁止记录文档正文、凭据或二进制内容；
11. 迁移必须具备崩溃恢复和双向孤儿补偿，并复用既有文件操作审计机制。

## 五、修正自动化测试契约

当前测试存在矛盾：

- 静态断言 `btn-quick-import-inbox-only` 必须不存在；
- 行为测试的 DOM mock 却对任意 ID 返回对象，掩盖生产空引用；
- 初始化测试仍人为注入已退役的 `loadInboxEntries`。

必须补充或重写以下测试。

### 5.1 登录初始化行为测试

- 测试环境不定义 `loadInboxEntries`；
- 直接执行生产 `initializeAuthenticatedApp()` / `initCanvasWorkspace()`；
- 断言无 `ReferenceError`；
- 断言画板、主题和 Native 文库正常初始化；
- 断言没有 inbox 请求；
- 断言没有 Altero、OIDC 或 OAuth 请求；
- 断言并发初始化锁仍然有效。

### 5.2 快速导入真实 DOM 契约测试

DOM mock 必须遵守：

```text
已存在 ID → 返回对应元素
未知或已退役 ID → 返回 null
```

直接执行生产函数并覆盖：

- `openQuickImportModal`；
- `resolveQuickImport`；
- `executeQuickImport`；
- `executeQuickDirectoryImport`。

断言：

- 弹窗打开不抛异常；
- 解析成功正确启用现有按钮；
- 解析失败正确恢复按钮状态；
- 全程不查询或操作 `btn-quick-import-inbox-only`；
- 不调用任何收件箱函数或接口。

### 5.3 网页导入默认归档测试

覆盖：

- DOI、URL、arXiv、BibTeX、RIS 得到 PDF 后默认进入 `网页导入`；
- `source_files` 中可见；
- attachment 为 `storage_kind = source_file`；
- 原始文件管理 API 可以列出并打开；
- 加入一个或多个主题不复制文件；
- 相同 SHA 不重复落盘；
- 不同 SHA 同名返回 409；
- 无 PDF 时只创建元数据文档；
- 文件系统或数据库失败时双向无孤儿；
- 已有 Blob-only 网页导入迁移成功、失败补偿且幂等重跑；
- 文件重命名与文库名称互不改写；
- 回收和恢复后批注及主题关系仍然存在。

### 5.4 全量回归

运行并通过：

```bash
npm test
git diff --check
```

不得弱化已有保障：

- 符号链接拒绝；
- 路径逃逸防护；
- TOCTOU 防护；
- 恢复器内容身份验证；
- 扫描有界内存；
- If-Match 并发控制；
- Blob 双向一致性恢复；
- Altero 运行时完全退役断言。

## 六、文档、服务和交付要求

完成代码后：

1. 更新 `docs/handoff.md`，记录根因、修复、测试、迁移口径和遗留风险；
2. 如已有 M4 设计/实施文档，同步产品规则，避免继续描述 Blob-only 网页导入；
3. 重启 `altcanvas.service`；
4. 验证：
   - service 为 `active/running`；
   - 首页返回 200；
   - `/auth/session` 返回 200；
   - 只有一个 worker；
   - 无启动恢复错误；
5. 提交应按逻辑拆分，最终报告列出提交哈希；
6. 不得在没有人工验收与日志复核时宣布 M4 `PASS`。

## 七、人工实机验收闸门

自动化全部通过后，只给用户以下最短步骤：

1. 退出并重新登录，不刷新页面，确认主题、画板和 Native 文库直接出现；
2. 打开“快速导入”，确认弹窗无错误；
3. 导入一个带公开 PDF 的 DOI、arXiv 或 URL，使用默认设置完成导入；
4. 打开“原始文件”，确认 PDF 出现在“研究文库 / 网页导入”中；
5. 确认同时显示原始文件名和文库文件名；
6. 再次导入同一 PDF，确认提示复用且没有第二份文件；
7. 测试原始文件改名、移入回收站和恢复，然后重新打开 PDF；
8. 确认批注和主题关联仍然存在。

收到用户回复“完成”或“看日志”后，检查：

- `.debug/dev.log`；
- `.debug/browser.log`；
- 最近的 `file_operations`；
- `source_files` 与 attachment 绑定；
- 运行期 Altero/OIDC/OAuth 请求必须为 0；
- 不得出现 `loadInboxEntries is not defined`；
- 不得出现访问已删除快速导入按钮导致的 null DOM 异常。

正确的本地根目录是：

```text
/home/sadgen/Projects/AltCanvas/data/library/
```

不要使用之前误写的路径：

```text
~/Projects/Projects/AltCanvas/data/library/
```

## 八、最终报告格式

最终整改报告至少包含：

1. 实际分支和提交哈希；
2. 两个 UI 回归的根因和修复；
3. 网页 PDF 默认归档规则及数据不变量；
4. 既有 Blob-only 数据的迁移结果；
5. 新增行为测试与全量测试结果；
6. `git diff --check` 与工作区状态；
7. systemd 与 HTTP 健康状态；
8. 尚未完成的人工验收步骤；
9. 当前里程碑状态必须保持 `M4 CONDITIONAL PASS`，直到用户操作和日志复核全部通过。
