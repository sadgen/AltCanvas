# AltCanvas Agent Instructions

When starting a session, read `docs/handoff.md` first for the current state, pending work, and architecture notes.

For UI bugs, follow `docs/human-in-loop-debugging.md` by default.

- Use the loop: code → project logs → human UI operation → project logs → code.
- The human is the UI operator/tester. Give the shortest concrete reproduction or verification steps and accept “完成 / 已复现 / 看日志” as the handoff to inspect logs.
- The Agent manages the development service and reads `.debug/dev.log` and `.debug/browser.log`. Do not ask the human to paste Console or terminal output when those logs can provide it.
- Add only minimal, low-frequency, development-only diagnostics. Never log credentials, cookies, authorization headers, tokens, document dumps, binary data, pointer movement, or render frames.
- Prefer logs over browser automation. Use browser control for visual/layout/animation/drag behavior, missing instrumentation, or when explicitly requested.
- Remove one-off instrumentation after verification; keep the shared logging infrastructure.
