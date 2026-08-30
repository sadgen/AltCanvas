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
