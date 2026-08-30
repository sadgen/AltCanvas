# AltCanvas 人机协作调试模式

AltCanvas 默认采用 Human-in-the-loop Debugging。人的主要职责是实际操作页面和复现问题；Agent 的主要职责是管理开发服务、读取代码与日志、定位问题、修改并验证代码。

## 默认闭环

1. Agent 先检查相关代码和现有日志。
2. 信息不足时，只添加最小且低频的诊断信息。
3. Agent 给出一组明确、最短的 UI 操作。
4. 人完成操作后只需回复“完成”“已复现”或“看日志”。
5. Agent 读取最新日志，定位并修改代码。
6. 人按最短步骤复验。
7. Agent 确认结果，并删除已经失去价值的临时诊断。

除非问题本身是布局、动画、拖放或实际渲染差异，否则不把浏览器自动操作作为默认手段，也不要求人手工复制 Console、终端输出或长堆栈。

## 统一日志

开发环境默认启用，设置 `DEBUG_LOGS=false` 可关闭；`NODE_ENV=production` 时强制关闭浏览器日志接口。

- `.debug/dev.log`：开发服务 stdout/stderr、进程异常，以及通过 `npm run debug:run -- <command>` 执行的构建或诊断命令。
- `.debug/browser.log`：页面和 Reader iframe 的 `window.error`、`unhandledrejection`、`console.warn/error`、失败的 Fetch 请求，以及显式上报的重要应用错误。

日志采用每行一个 JSON 对象，主要字段包括时间、等级、来源、消息、堆栈、当前路由，以及失败请求的 method、endpoint、HTTP status 和短响应摘要。重复事件在短时间内去重，字符串、数组和嵌套对象都有上限；不会记录完整文档状态、渲染帧、鼠标移动、二进制或 Base64 数据。

单个日志默认达到 2 MiB 后轮转为同名 `.1` 文件，可通过
`DEBUG_LOG_MAX_BYTES` 调整。文库、条目和 Canvas UUID 等路径标识在写入日志前
会被归一化，外部 AI 地址不会写入浏览器日志。

Authorization、Cookie、密码、密钥、secret 和 token 字段会被脱敏。新的诊断不得绕过这项限制。

常用读取方式：

```sh
tail -n 100 .debug/dev.log
tail -n 100 .debug/browser.log
rg '"level":"error"' .debug
```

使用 `npm run dev` 时，开发服务 stdout/stderr 自动写入日志。单独执行可能产生构建错误的命令时使用：

```sh
npm run debug:run -- npm test
```

已有的 vendor 和 CSS 构建脚本已自动通过这一通道记录输出。

## 技术栈边界

当前主界面是原生 HTML/JavaScript，后端是 Node.js BFF，并未使用 React。因此 React Error Boundary 当前不适用；若以后引入 React，需要在组件树根部加入 Error Boundary，并将异常送入同一个浏览器日志入口。

## Agent 约定

- 先读日志，再决定是否需要额外 instrumentation。
- 只记录异常定位所需的信息，不记录高频状态或大型对象。
- 能从项目日志获得的信息，不让人再次手工提供。
- 若确实缺少信息，要说明缺少什么，并只要求最少的人工操作。
- Computer Use 仅用于关键视觉检查、无法通过日志判断的交互，或人明确要求直接操作时。
- 调试完成后保留通用基础设施，移除一次性的临时日志。
