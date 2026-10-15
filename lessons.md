# 项目教训

实现、评审或验收前阅读相关条目；用户纠正、返工或漏验暴露可复用教训后补记。

## 记录模板

复制下列模板新增条目，已有同类条目则更新原条。未知的提交、原因或验收结果明确写“待核实”。
同一事件的多次修复、测试重跑不增加复发次数；只统计有独立证据的再次发生。
记录保留可复用的原因与证据定位；凭据、私人资料及完整日志留在各自获准的位置。

```markdown
### <教训标题>

**<一句话说明下次应遵守的规则。>**

- 起因与后果：<触发条件、原因、用户可感知的影响；关联 issue 或引入提交，未知则写待核实。>
- 修复与证据：<修复提交或 PR、回归检查与实际验收证据；区分已验证和未验证的部分。>
- 正确做法（Done right）：<下次的具体做法；链接到防复发代码、检查或所属规范。>
- 复发记录：Seen <N>x (<YYYY-MM-DD, ...>)；<每次独立发生的证据；修复提交数与重试次数不计入。>
```

### 单次派活有 1800 秒墙钟上限，必须先交骨架再按可验证单元递增提交推送

**在受时长限制的派活任务中，前 10 分钟内必须完成最小骨架并提交推送开 Draft PR，后续每完成一个可验证单元立即测试并推送。**

- 起因与后果：任务 `7577b4550236d66f` 试图一次性完成全部功能后再提交，触发 adapter 单次运行 1800 秒墙钟上限（`ModelTimeout`）被强杀，导致未产生远端分支与 PR。
- 修复与证据：本轮（`dsh-grokbot-dispatch-plugin-20261015-r2`，PR #5）拆分为最小骨架 + 持久映射/Yobiru 回报 + 出站命令 + 单元测试四个增量提交，每步运行 `node --test` 后即刻 push。
- 正确做法（Done right）：先建功能分支交付官方 manifest、目录结构与最小实现并开 Draft PR，再分批合入 `plugin/job-map.js`、`plugin/commands.js`、`plugin/hooks/` 及 `test/bidirectional.test.js`。
- 复发记录：Seen 1x (2026-10-15)；任务 `7577b4550236d66f` 超时强杀。

### Primary 宿主传入非退出回调时，`supervise` 超时分支不得跳过后续 `bind()`

**当 `supervise` 的 `exit` 回调不终止进程（如 DSH 桌面主进程内）时，超过 `exitAfterFailedSeconds` 后必须重置 `downSince` 并继续调用 `bind()`。**

- 起因与后果：`plugin/index.js` 原 `supervise` 在 `(Date.now() - downSince) / 1000 > cfg.exitAfterFailedSeconds` 时直接 `return exit(1)`；桌面主进程传入仅打日志的回调且不退出进程，导致休眠/Tailscale 断连超过 600 秒后永远不再调用 `bind()`，而 standby 进程见 `primary.pid` 存活也不接管端口。
- 修复与证据：在 `plugin/index.js` 的 `supervise` 中移除 `return`，调用 `exit(1)` 后重置 `downSince = Date.now()` 并继续执行 `bind()`；`node --test test/*.test.js` 全量 21 项测试通过。
- 正确做法（Done right）：守护循环中若 `exit` 回调可能返回，必须在告警后重置计时器并继续尝试重绑（见 `plugin/index.js` `supervise`）。
- 复发记录：Seen 1x (2026-10-15)；`dispatch.log` 连续打印 `still unbound; staying up`。

### 环境相关的身份（tailnet IP、主机名、家目录、带版本号的安装路径）不得写死在代码、plist 或 README 里

**节点地址与路径一律按 env > config.json > 发现（tailscale status）解析；修这类问题先全仓 grep 旧字面量，不能用新字面量替换旧字面量。**

- 起因与后果：2026-10-15 box 开机更新后重新登录 Headscale，IP 由 <旧 box IP> 变为 <新 box IP>；白名单写死旧 IP，box→DSH 主机 派单被拒。#3（ebe9f77）改读 `DISPATCH_ALLOWED_IPS`，但默认值仍是两个字面 IP；#4（66cbd85）又在 plist 写死 `DISPATCH_ALLOWED_IPS=<新 box IP>`、代码默认去掉 .114，把下一次 IP 变动的坑重新埋回去。同一天第三次改动（#7）才彻底改成配置/发现，#8 再补残留注释。
- 修复与证据：#7（8ea821a）新增 `plugin/config.js`，host/peers/allowlist/路径按 env > `~/.config/dsh-grokbot-dispatch/config.json` > `tailscale status --json` 解析，解析不到就不绑定、白名单为空即全拒；plist 改为模板由 `bin/install-launchd.sh` 渲染；`node --test test/*.test.js` 39/39，测试统一走占位地址夹具并关闭发现。#8（90959ed）修正注释。IP 再次变动后的真实自愈尚未发生，未验证。
- 正确做法（Done right）：同日 zcode-dispatch #7（68d03e1，closes #5）一次把 host/peers/allowlist/路径收进单一配置源。改地址类问题时用私有网段与本机用户路径的扫描规则全仓核对，除测试夹具和 lessons 外为零才算修完，并把扫描结果写进 PR。
- 复发记录：Seen 1x (2026-10-15)；同日 tailmsg-adapters 写死 Yobiru CLI 0.5.0 路径（#9/#10）属同类，在该仓库单独记录。

