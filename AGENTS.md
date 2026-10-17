# AGENTS.md (routing only)

- What this is and how it runs: `README.md`
- Plugin entry (Cordis `apply`, HTTP service effect): `plugin/index.js`
- Validation, auth, job store, DSH runner: `plugin/core.js`
- Tests: `node --test test/*.test.js` (from repo root)
- Host process (launchd user agent): optional; private deploy templates are not in this public repo
- Box-side client: `client/dsh-dispatch.sh`
- Secrets: the key lives only in `~/.config/dsh-grokbot-dispatch/key` (DSH host) and the box env file; never commit or print it.
- Workflow: branch + PR, squash merge only.
- Lessons / 验收规则（硬规则）：
  - 动手前读 [lessons.md](lessons.md)；返工、用户纠正、验收漏项按其中格式记录；同一条教训在 3 个不同日子出现，就升为本文件的硬规则，并在 lessons.md 注明去向。
  - 每个 commit 正文和 PR 评论都要写清三项：①回退测试：哪条回归测试先失败、修后通过；没有就说明为什么。②真实使用情况：在真机、真实数据或真实界面上实际跑了什么、结果如何；没跑就写「未在真实环境验证」。③没跑到的项目：跳过的检查、没覆盖的场景和原因。只写「测试通过」不算验收，旧记录不能充当这次的证据；squash 合并时把这三项带进合并提交正文。
  - 环境身份不写死（硬规则，2026-10-17 由 LESSONS 升级，Seen 3x：2026-10-15、10-16、10-17）：tailnet IP、主机名、家目录、带版本号的安装路径不得写成代码默认值、白名单字面量，也不得固定在 plist 或 README 的可执行示例里。对端身份用 `tailscale whois` 返回的节点名或标签判定；地址和路径按「环境变量 > git 外的配置文件 > `tailscale status --json` 发现」读取，读不到就不绑定、白名单为空即全拒。测试用占位地址夹具。改这类代码时，在 PR 里附一次「故意写入字面 IP 能被检查或测试拦下」的证据；仓库还没有这项检查的，先补检查。
