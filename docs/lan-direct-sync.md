# 局域网设备直连

两端使用同一版本的 `rookcue`，并确认 `rookcue peer --help` 可用。
当前为同一用户两台设备的手动双向同步，双方须同时在线；每个个人根只配一个 peer。
支持明确的私网 IPv4 地址，不使用共享目录、NAS、S3、协调服务或数据中继；没有自动
发现、后台常驻或公网打洞。运行服务不自动修改系统防火墙、系统证书或安全设置。

协议限制：最多 4,096 个资产、单个 8 MiB、每连接累计 64 MiB、单条元数据 1 MiB。
同步计划也占元数据预算，路径/历史较多时可能先达到该限制；应在准备写入前明确拒绝，
不留下新 pending。既有 pending 不因超限而删除，先保留原数据和恢复证据再处理输入范围。

同步沿用个人知识白名单；项目完整任务、检查点、原始复盘回答、聊天、凭据和 `.p2p`
状态均排除。同步已有记录不构成知识批准、回忆测试或掌握判断。两端自己的本地暂存
和恢复日志是端点状态，不是第三方中间存储。

## 配对及同步

以下由各自 Mac 的 Agent 执行。`GMEM_PROJECT` 为实际项目，`GMEM_PERSONAL` 为独立
个人知识根；不能将后者指向该项目的 `.growth-memory`。先核对两端 `rookcue --version`
并备份旧程序与完整数据。验收应使用独立临时根，不对真实知识库做演示修改。

Mac B 开启配对窗口，绑定 B 实际拥有的私网地址：

```sh
rookcue peer invite --project "$GMEM_PROJECT" --personal "$GMEM_PERSONAL" \
  --bind 192.168.1.20 --port 0 --out "$GMEM_INVITATION_FILE" --json
```

前台命令输出 `ready` 地址和到期时间，邀请默认五分钟有效。将 `0600` 私有邀请文件
通过可信方式交给 Mac A，在 A 执行：

```sh
rookcue peer pair --project "$GMEM_PROJECT" --personal "$GMEM_PERSONAL" \
  --invite-file "$GMEM_INVITATION_FILE" --json
```

邀请包含一次性随机凭据，不得贴入聊天、命令参数、日志、项目记忆或 Git。保存返回的
B 的 `peerId`，在 B 使用 `peer list` 核对 A；IP/名字不是身份。配对后结束邀请窗口。

B 开启 TLS 1.3 双向证书认证的正常服务，明确允许本次同步修改：

```sh
rookcue peer serve --project "$GMEM_PROJECT" --personal "$GMEM_PERSONAL" \
  --bind 192.168.1.20 --port 0 --allow-apply --json
```

A 根据本次 `ready` 地址与已配对身份，先预览：

```sh
rookcue peer sync --project "$GMEM_PROJECT" --personal "$GMEM_PERSONAL" \
  --peer "$GMEM_PEER_ID" --address "$GMEM_PEER_ADDRESS" --dry-run --json
```

核对两端增改、删除、冲突后，将 `--dry-run` 改为 `--apply`。应用会重新计算计划。
B 未开启 `--allow-apply` 时拒绝修改。服务默认五分钟结束，支持有界 `--timeout` 和
SIGINT/SIGTERM，关闭时输出 `stopped`；Agent 须保留子进程句柄并负责回收。

## 冲突及恢复

`peer conflict list/show/resolve` 使用相同的 roots、`--peer` 和 `--address`。
`show` 增加 `--path <path>`；`resolve` 还须 `--strategy local|remote|both|skip`。
local/remote 相对发起命令的一端。both 保留远端规范文件与本地原字节副本；编辑/删除
时保留仍存在的内容并记录决策。skip 保留该路径两端现状与旧基线，其他路径仍可同步。
选择与观察到的两端哈希绑定，变化后须重新检查。选择后执行 `sync --apply`。

断线后先用 `peer session status --peer <id> [--address <ip:port>]` 检查，再用
`peer session resume --peer <id> --address <ip:port>` 恢复。所有命令仍需明确 roots。
一端开始应用后不可丢弃会话按旧基线重算；已完成操作不重复写入或删除。失败不代表
两端完全没变化。出现新修改时，先检查差异与归档位置；明确决定保留当前字节并完成
原计划后，才在 resume 增加 `--preserve-current`。此命令先输出一条
`data.event = recovery-preserved` 的 JSON 信封，`data.local.archives` 与
`data.remote.archives` 分别列出各端本地归档路径；其后才输出恢复结果。
归档不是自动合并，也不保证新修改仍为活动版本。不得手工编辑日志、清空基线或用 forget 绕过 pending。

若进程在本地锁登记所有者前被终止，留下的空 `.mutation.lock` 目录在五分钟后可自动回收。
若旧版本留下含 `owner.json` 的锁目录，先确认所有可能写入该个人根的进程均已退出，
再手动移走 `$GMEM_PERSONAL/.mutation.lock` 并重试。保留 `.p2p` 内的会话和基线。

证书一年到期。两端分别执行 `peer identity renew`，沿用原私钥和同一 SPKI/peer ID。
B 再执行 `peer invite --refresh --peer <A-id>`，A 使用新私有邀请执行
`peer pair --refresh --invite-file <file>`，保留基线与 pending。不同密钥不能当作刷新。
**随后须重新启动 B 的正常 peer serve，加载新证书和信任集合，再恢复原会话。**
不关闭证书验证，不安装系统 CA。仅在明确退役设备时使用 `peer forget`；它拒绝有
pending 的设备，撤销中断时重试相同 forget 以完成清理，不创建新配对。

## 成功证据

有实际双向写入的会话，双方回执须为 committed、基线 generation/digest/lastSessionId
一致且 pending 清空。具体读取 resume/apply 返回的 `data.localReceipt`、
`data.remoteReceipt`，两者 `phase` 均为 `committed` 且 sessionId/planDigest 匹配；
随后运行带 `--address` 的 `peer session status`，检查 `data.local.baseline` 与
`data.remote.baseline` 的 generation/digest/lastSessionId，以及两端 pending 为 null。
检查预期文件字节/哈希和删除结果，再做无变化预览。若明确 skip，
保留未收敛路径的差异，不声称两端全部相同。

`npm run verify:peer -- --executable <候选文件>` 使用两个临时端点和真实 TLS/CLI，
包括杀进程后的恢复。这是同主机验收，不等于两台真实 Mac 的局域网验收。实际双机须
使用 [双机验收指南](lan-two-mac-acceptance.md)，私下记录版本、摘要和操作结果。
