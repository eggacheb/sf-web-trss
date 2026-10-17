# Weak-Model Incremental Review Prompts — sf-web-adapter

Use this file when a weaker model needs to review already implemented sf-web-adapter changes in small, repeatable sessions.

This file is for **review only**. It is not for implementation slices and not for fix sessions unless the user explicitly switches to fix mode.

Persistent review log:
- `D:\code\trsssf\.trellis\tasks\06-12-sf-web-adapter\review-progress.md`

## Core Rules

- Do not continue implementation.
- Do not choose the next `implementation-plan.md` subtask.
- Do not edit implementation code during review unless the user explicitly switches to fix mode.
- Do not stage, commit, push, archive, or run finish-work.
- Review exactly one unchecked slice from `review-progress.md`.
- After review, update only that slice in `review-progress.md`.
- If a slice has P0/P1/P2 findings, do not mark it checked.
- Always review staged changes with `git diff --cached`; implementation changes may already be staged.
- Always also inspect unstaged changes with `git diff`; the two views may differ.
- Review must include cross-layer scan, focused file reading, and an Implementation Logic Summary for the selected slice.
- Verification commands are evidence, not proof by themselves; inspect what they cover.

## Generic New-Conversation Prompt

```text
你现在在 `D:\code\trsssf` 项目里工作，这是一个 Trellis 管理的项目。

本轮任务不是继续实现，不是选择下一个 implementation slice，也不是提交。
本轮任务是：按 `review-progress.md` 自动选择下一个未审查分片，对当前 sf-web-adapter 实现改动做一次小范围、完整、可验证的 code review。

当前 task：
D:\code\trsssf\.trellis\tasks\06-12-sf-web-adapter

必须先读取并遵守：
- `D:\code\trsssf\.trellis\workflow.md`
- `D:\code\trsssf\.trellis\tasks\06-12-sf-web-adapter\prd.md`
- `D:\code\trsssf\.trellis\tasks\06-12-sf-web-adapter\review-progress.md`
- `D:\code\trsssf\.trellis\tasks\06-12-sf-web-adapter\weak-model-review-prompts.md`（本文件）
- 当 review slice 涉及配置层时读取：`TRSS-WeChat-OC-Plugin/model/Config.js`, `TRSS-WeChat-OC-Plugin/model/path.js`
- 当 review slice 涉及适配器核心时读取：`TRSS-WeChat-OC-Plugin/index.js`
- 当 review slice 涉及前端时读取：`D:\code\trsssf\sf-web-dev\public\js\app.js`（对比源文件）
- 当 review slice 涉及指令或锅巴时读取：`TRSS-WeChat-OC-Plugin/apps/Login.js`, `TRSS-WeChat-OC-Plugin/guoba.support.js`

Trellis check 强制要求：
1. 本轮开始必须加载并执行 `trellis-check` skill，不能只把它当参考文件读取。
2. 即使本轮只审一个 slice，也必须按 `trellis-check` 的 Step 1-6 执行：
   - Step 1 Identify What Changed
   - Step 2 Read Applicable Specs
   - Step 3 Run Project Checks
   - Step 4 Review Against Checklist
   - Step 5 Cross-Layer Dimensions
   - Step 6 Report and Fix
3. 但本轮仍然是 review-only：Step 6 里的 "Fix" 在本轮解释为"把问题记录为 finding 并提出修复建议"，不要直接修改业务代码。
4. 只有非常小的格式 / lint / typo 问题，并且用户明确允许修复时，才可以直接改文件。
5. 如果 `trellis-check` 和本 prompt 冲突，以本 prompt 的 review-only 边界为准：审查并记录，不自动修业务逻辑。

请先运行/读取：
- `git status --short`
- `git diff --stat`
- `git diff --cached --stat`

重要：当前实现改动可能已经 staged。不要只看 `git diff`。
必须同时检查：
- `git diff`
- `git diff --cached`

如果当前 active task 不是 sf-web-adapter，请停止并汇报，不要继续审核。

自动选择 review slice 的规则：
1. 读取 `D:\code\trsssf\.trellis\tasks\06-12-sf-web-adapter\review-progress.md`。
2. 从 `## Review Slices` 从上到下扫描。
3. 自动选择第一个未勾选的 slice。
4. 本轮只审核这一个 slice。
5. 不要跳过前面的未审查 slice。
6. 如果 `review-progress.md` 不存在，请停止并要求先创建，不要自己临时发明 slice。

本轮 review 必须同时对齐这些约束：
1. `prd.md`：需求边界和 acceptance criteria，决定该实现是否满足真实需求；
2. `.trellis/spec/`：项目级代码规范（如果有）；
3. 参考代码（TRSS-WeChat-OC-Plugin）的已有模式。

审查方式——按 `quality-review-loop.md` 的要求：
1. Cross-layer scan：先按 `trellis-check` Step 1 识别本轮 slice 的变更文件。
2. Focused file reading：一次只精读一个相关文件；文件过长时一次只读一个连续片段。每读完一个文件/片段，记录简短分析：职责、发现、需要继续追踪的 symbol。
3. 必须查看该 slice 相关的 `git diff --cached` 和 `git diff`。
4. 必须把代码事实映射回 `prd.md` requirement。
5. 输出本 slice 的 actual `Implementation Logic Summary`：entrypoint / trigger、模块职责、data flow、success path、failure path、external contracts、verification evidence。
6. 必须按 `trellis-check` Step 4 检查：lint/type check、debug logging、suppressed warnings、spec sync。
7. 如果本 slice 跨 2 层以上，必须按 `trellis-check` Step 5 检查 data flow、code reuse、import/dependency、same-layer consistency。
8. 必须检查是否存在 partial implementation、死代码、重复逻辑、错误 fallback、日志泄密。
9. 如果验证需要真实 Redis、browser、第三方服务，不要伪造通过；记录 pre-commit external verification item。

关键业务决策必须在相关 slice 中核对：
- Slice 3: handleMessage 构造 e 对象的 user_id 格式 `web_${userQQ}` 是否与 `apps/WebManagement.js` clearHistory 中 `this.e.user_id.replace(/^web_/, '')` 一致
- Slice 4: sendFriendMsg 中 Redis 历史存储的 content 脱 HTML 逻辑是否正确
- Slice 5: 前端 WebSocket url 构造 `protocol://host:port` 不含代理路径

验证要求：
- 只运行本轮 slice 对应的 narrow verification。
- JS 文件优先运行 `node --check <changed-js-file>`。
- 默认验证提示：
  - `node --check sf-web-adapter/index.js`
  - `node --check sf-web-adapter/apps/WebManagement.js`
  - `node --check sf-web-adapter/model/Config.js`
  - `node --check sf-web-adapter/model/path.js`
  - `node --check sf-web-adapter/guoba.support.js`
  - `node --check sf-web-adapter/web/public/js/app.js`
  - `ls sf-web-adapter/web/public/`（确认 index.html 存在）

验证命令属于 `trellis-check` Step 3；运行后必须在 `review-progress.md` 记录命令和结果。
如果验证失败，本轮仍然是 review mode：不要擅自修复代码，把失败作为 finding 写入。
不要为了让验证通过而降低测试强度。

Findings 输出格式：

## Findings

每个 finding 使用这个格式：

### [P0/P1/P2/P3] 标题

- 文件：`绝对路径:行号`
- 关联需求：引用 prd.md 的对应 requirement 编号
- 问题：具体说明代码现在做错了什么
- 影响：说明会导致什么线上行为、安全问题或运维问题
- 建议修复：给出明确修复方向
- 验证建议：说明修复后应该跑什么验证

严重程度定义：
- P0：数据丢失、账号泄露、服务不可启动、严重安全问题
- P1：核心 PRD 不满足、并发/生命周期错误、关键 contract 破坏
- P2：边界场景错误、恢复/监控不完整、spec 与代码不一致
- P3：可维护性、命名、日志、文档问题

如果没有发现问题，请明确说："本 slice 未发现 P0/P1/P2 级问题。"

完成审核后，必须更新 `D:\code\trsssf\.trellis\tasks\06-12-sf-web-adapter\review-progress.md`。

更新规则：
1. 在对应 slice 的 `Status` 写入：
   - `reviewed - no P0/P1/P2 findings`
   - 或 `reviewed - findings found`
   - 或 `blocked - <原因>`
2. 在对应 slice 的 `Findings` 下追加本轮 findings。
3. 必须记录 `trellis-check` Step 1-6 执行摘要。
4. 必须记录本 slice 的 Implementation Logic Summary。
5. 只有当本 slice 没有 P0/P1/P2 findings 并且本轮 narrow verification 通过，才把 checkbox 改成 `[x]`。
6. 如果存在 P0/P1/P2，保持 checkbox 未勾选。pre-commit external verification item 不阻塞当前 review slice 勾选，但必须记录下来供 final-check 收口。

禁止事项：
- 不要继续选择下一个 implementation slice。
- 不要勾选新的 `implementation-plan.md` checkbox。
- 不要重新生成 PRD 或 implementation plan。
- 不要自动 commit、push、finish-work。
- 不要直接修复业务代码，除非用户明确说"进入修复模式"。

最后汇报：
1. 本轮审查的 slice；
2. 已审查的文件；
3. `trellis-check` Step 1-6 的执行摘要；
4. 运行的验证命令及结果；
5. Implementation Logic Summary；
6. findings 摘要；
7. `review-progress.md` 更新了什么；
8. 下一个建议 review slice 是什么。
```

## Cursor-Specific Reminder

```text
我是用 Cursor 开的新对话。请使用上面的 Generic New-Conversation Prompt。

如果 Cursor 自动想继续执行 `weak-model-implementation-prompts.md` 的实现流程，请忽略那部分。本轮是 review-only。

如果使用 Cursor agents，只能派发一个明确 review slice，不要派发整份 staged diff。
```

## 入口 Prompt（在 Cursor 新对话中粘贴使用）

```text
请先读取：
D:\code\trsssf\.trellis\tasks\06-12-sf-web-adapter\weak-model-review-prompts.md

我是用 Cursor 开的新对话。Cursor 属于 sub-agent-capable 平台。

本轮是 **supervisor 主会话**，使用 supervised subagent loop 模式：

1. 重新读取 task / PRD / review-progress / 本 prompt 文件
2. 从 `review-progress.md` 按顺序选择下一个最小 slice
3. dispatch 一个 Cursor agent 执行该 slice
4. dispatch prompt 必须以 `Active task: D:\code\trsssf\.trellis\tasks\06-12-sf-web-adapter` 开头
5. 告诉 subagent 它已经是 `trellis-check`，不要再 spawn 另一个 subagent
6. 等 agent 返回后审查它改过的文件、diff、验证结果
7. slice 确认完成后自动 dispatch 下一个，不要问"接下来做什么"
8. 循环直到全部 review slice 完成或遇到真实 blocker

只有以下情况才询问我：
- slice 之外大面积修改
- PRD / plan 需要变更
- 业务决策
- 大范围重构
- stage / commit / push / archive / finish-work 等受保护边界

禁止：不要主会话自己一次性做完整 review。不要 stage、commit、push、finish-work。
不要在每个成功 slice 后弹出继续/停止选择题。默认自动继续。

开始前先输出：
1. 你读取了哪些文件
2. review-progress.md 中选中的第一个 review slice
3. dispatch 的 subagent 指令摘要
```
