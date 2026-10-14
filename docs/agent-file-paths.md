# Agent 原文路径

文章与已登记原始文件的三点菜单提供“复制原文路径”，随后选择 agent 所在机器能访问的位置。此操作只读取文件元信息并复制文本，不下载原文、不生成卡片。

生产在 192.168.5.237，项目为 `/home/sadgen/Projects/AltCanvas`。研究原文目录 `/mnt/nfs/qbit_downloads/hermesagent_shares/金融研究_paper` 来自 NAS 192.168.5.200 的 NFS 挂载；应用读取共享原文。网页上传的文件存储在项目的数据目录，未配置共享映射时只提供服务器路径。

5.233 已有同一共享目录的 Z 盘挂载。Windows SeaDrive 为补充位置：仅在文件名和相对路径通过云盘目录元数据核对后提供。SeaDrive 的占位文件由 agent 打开单篇时按需下载；不能对整个目录预下载。

映射配置保存在生产私有 `.env` 的 `AGENT_FILE_PATH_MAPPINGS` JSON 数组中，每项包含 `ownerKey`、`rootId`、`label`、绝对 `targetRoot`、`onDemand`，可选 `verifiedRelativePaths`。账号与根目录须同时匹配；云盘使用相对路径白名单，未核实的条目不显示云盘选项。新增或改名后，可仅核对目录元数据并更新白名单；Z 盘共享映射自动使用当前相对路径。私有路径与账号不放入仓库。

2026-10-14 元数据核对：研究原文 189 篇，Z 盘匹配 189 篇、SeaDrive 匹配 179 篇。未读取文件内容。仓库中没有原文复制到 Seafile 的同步任务，外部同步状态以云盘目录实测为准。

接口 `GET /canvas/native/{documents|source-files}/:id/file-location` 校验账号权限、文件存在性与根目录边界，仅返回可用路径，响应禁止缓存。HTTP 局域网页面优先调用剪贴板，受浏览器限制时使用兼容复制，仍失败时提供手动选中复制。
