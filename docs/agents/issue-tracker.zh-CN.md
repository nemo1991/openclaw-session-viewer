# Issue 跟踪器:GitHub

本仓库的 issues 和 specs 都存在 GitHub Issues 上。所有操作通过 `gh` CLI 完成。

## 仓库

- **GitHub**: `nemo1991/openclaw-session-viewer`
- **远程别名**:`openclaw-session-lookup`(不是 `origin` — 通过 `git push openclaw-session-lookup <branch>` 推送)

## 约定

- **<redacted> issue**:`gh issue create --title "..." --body "..."`。多行 body 用 heredoc。
- **读取 issue**:`gh issue view <number> --comments`,配合 `jq` 过滤评论并获取 labels。
- **列出 issues**:`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`,配合 `--label` 和 `--state` 过滤。
- **评论 issue**:`gh issue comment <number> --body "..."`
- **添加/移除 label**:`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**:`gh issue close <number> --comment "..."`

从 `git remote -v` 推断仓库 — 在 clone 内运行 `gh` 会自动识别。

## PR 作为 triage 入口

**PRs 作为请求入口:否** _(如果本仓库把外部 PR 当成 feature request,改成 `yes`;/triage 会读取此 flag)_

设置为 `yes` 时,PR 跟 issue 走相同的 labels 和 states,使用 `gh pr` 对应命令:

- **读取 PR**:`gh pr view <number> --comments`,配合 `gh pr diff <number>` 看 diff。
- **列出待 triage 的外部 PR**:`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`,然后只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的(过滤掉 `OWNER`/`MEMBER`/`COLLABORATOR`)。
- **评论/label/关闭**:`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 和 PR 共用一个编号空间,所以一个裸的 `#42` 可能是其中任一 — 先 `gh pr view 42`,fallback `gh issue view 42`。

## 当 skill 说 "publish to the issue tracker"

<redacted>一个 GitHub issue。

## 当 skill 说 "fetch the relevant ticket"

运行 `gh issue view <number> --comments`。

## Wayfinding 操作

`/wayfinder` 使用。**Map** 是单个 issue,**child** issues 作为 ticket。

- **Map**:单个带 `wayfinder:map` label 的 issue,持有 Notes / Decisions-so-far / Fog body。`gh issue create --label wayfinder:map`。
- **Child ticket**:通过 GitHub sub-issue 关联到 map 的 issue(`gh api` 操作 sub-issues 端点)。如果 sub-issue 不可用,在 map body 的 task list 里加上 child,child body 顶部写 `Part of #<map>`。Labels:`wayfinder:<type>`(`research`/`prototype`/`grilling`/`task`)。一旦认领,assignee 设为驱动开发的 dev。
- **Blocking**:GitHub **原生 issue 依赖** — UI 可见的标准表示。用 `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` 添加边,`<blocker-db-id>` 是 blocker 的数字 **database id**(`gh api repos/<owner>/<repo>/issues/<n> --jq .id`,**不是** `#number` 或 `node_id`)。GitHub 返回 `issue_dependencies_summary.blocked_by`(只看 open blockers — 即时闸门)。依赖不可用时,在 child body 顶部加 `Blocked by: #<n>, #<n>` 行。当所有 blocker 都关闭时,ticket 解锁。
- **Frontier 查询**:列出 map 的 open children(`gh issue list --state open`,限定到 map 的 sub-issues / task list),过滤掉有 open blocker(`issue_dependencies_summary.blocked_by > 0`,或 `Blocked by` 行里有 open issue)或有 assignee 的;按 map 顺序第一个胜出。
- **Claim**:`gh issue edit <n> --add-assignee @me` — session 的第一次写入。
- **Resolve**:`gh issue comment <n> --body "<answer>"`,然后 `gh issue close <n>`,再在 map 的 Decisions-so-far 末尾追加 context pointer(gist + 链接)。
