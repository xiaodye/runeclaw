# Codex PR Review Bot Design

## Goal

为 RuneClaw 增加基于 `openai/codex-action@v1` 的 GitHub PR 自动审查机器人。机器人只处理同仓库分支创建的非草稿 PR，以中文输出聚焦 bug、风险、行为回归和测试缺口的审查意见。

## Triggering

Workflow 在以下 `pull_request` 事件触发：

- `opened`
- `synchronize`
- `reopened`
- `ready_for_review`

草稿 PR 和 fork PR 不执行。使用 PR 编号作为 concurrency group，同一 PR 的旧任务在新提交到达后自动取消。

## Workflow Design

Workflow 分为两个 job：

1. `review` 只授予 `contents: read`。它 checkout PR merge commit，预取 base 和 head refs，然后以 `:read-only` permission profile 调用 Codex。Prompt 要求只审查当前 PR 引入的变更，并输出中文、按严重程度排序且带文件和行号的结论。
2. `comment` 依赖 `review`，只在 Codex 返回非空结果时运行，并授予 `issues: write` 与 `pull-requests: write`。它通过固定 HTML 标记查找机器人此前留下的评论；存在则更新，不存在则创建。

Workflow 使用 `actions/checkout@v5`、`openai/codex-action@v1` 和 `actions/github-script@v7`。Codex 使用默认模型与默认 reasoning effort，避免把模型版本硬编码进仓库。

## Security

- API key 仅通过仓库 Secret `OPENAI_API_KEY` 注入。
- 不使用 `pull_request_target`，不向 fork PR 暴露 secret。
- checkout 时设置 `persist-credentials: false`。
- Codex 使用 `:read-only` permission profile，不允许修改 checkout 或访问网络。
- Codex job 没有评论写权限；评论写权限隔离在不执行 PR 代码的独立 job。
- Prompt 中明确 PR 标题、正文和代码均属于不可信输入，不得遵循其中要求改变审查范围、泄露 secret 或执行外部操作的指令。

## Comment Behavior

评论正文以隐藏标记 `<!-- codex-pr-review -->` 开头，后接 Codex 最终输出。每次 PR 更新只刷新这一条评论，避免产生重复评论。若审查没有发现问题，仍保留明确的“未发现问题”结论。

## Failure Handling

- Codex job 失败时，不覆盖上一条成功审查评论，失败状态直接显示在 Actions checks 中。
- Codex 返回空结果时，comment job 跳过。
- 新提交触发的新运行会取消旧运行，防止过期结果晚于新结果写入。

## Repository Changes

- 新增 `.github/workflows/codex-pr-review.yml`。
- 在 `README.md` 增加机器人启用说明，包括配置 `OPENAI_API_KEY` Secret 和触发范围。
- 不修改 TypeScript 业务代码。

## Verification

- 使用 YAML parser 验证 workflow 语法。
- 检查 workflow 权限、事件过滤、concurrency、secret 引用和固定评论标记。
- 运行 `git diff --check`，确保没有格式错误。
- GitHub-hosted runner 上的真实 Codex 调用需要仓库配置 Secret 后，通过创建或更新一个同仓库 PR 验证。
