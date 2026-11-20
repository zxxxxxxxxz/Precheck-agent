# OSS 运维工具

现有 Python 工具仅用于 APP 基础设施，使用独立 `/data/hsbc/envs/ops` 环境，不改变 Node 应用技术栈。P1 应用上传采用独立 Node 工具及受限身份，见下文。
Bucket 固定为 `hsbc-poc`，地域固定 `cn-wulanchabu`，使用内网 HTTPS Endpoint。

## 身份与安装

使用官方 OSS Python SDK V2 及 Credentials SDK。显式指定 `ecs_ram_role`，强制 IMDSv2，由 SDK 刷新临时凭证；不会读取 AK 环境变量或个人 CLI 凭证。必须先为 ECS 绑定可访问该 Bucket 的 RAM 角色。所有命令仅输出状态，不输出凭证、元数据响应或 SDK 错误正文。

```sh
python3 -m venv /data/hsbc/envs/ops
PIP_CACHE_DIR=/data/hsbc/envs/ops/pip-cache /data/hsbc/envs/ops/bin/python -m pip install \
  --index-url https://pypi.org/simple -r /data/hsbc/scripts/oss/requirements.lock
/data/hsbc/envs/ops/bin/python /data/hsbc/scripts/oss/oss_ops.py check
/data/hsbc/envs/ops/bin/python /data/hsbc/scripts/oss/oss_ops.py smoke
```

`check` 只读检查角色、地域与 private ACL；无法核验私有 ACL 时拒绝上传，不修改 Bucket 设置。
`smoke` 只创建本次随机 `infra-smoke/<UTC>-<uuid>/probe.bin`，下载校验 SHA-256 后删除该对象；不会列举或删除其他对象。网络故障时检查失败，不能当作已验收。

## 加密备份

先由受限运维身份生成一次密钥，保存为权限 600 的 `/data/hsbc/secrets/backup.key`。密钥不会覆盖、上传或打包到备份中。必须将该密钥另存到用户控制的安全位置，服务器磁盘丢失而密钥未另存时无法解密备份；该工具不会自行选定或创建外部密钥存储。

```sh
/data/hsbc/envs/ops/bin/python /data/hsbc/scripts/oss/oss_ops.py init-key
/data/hsbc/envs/ops/bin/python /data/hsbc/scripts/oss/oss_ops.py backup-upload \
  /data/hsbc/backups/<已完成的归档文件>
```

只接受 `/data/hsbc/backups` 内非符号链接的已完成单文件，目录应先由备份流程打包。拒绝 `.tmp`、`.part`、`.partial`，加密期间检测源文件变动。调用方必须先完成数据库一致性备份，不能直接传入活动数据库目录。

工具通过 OpenSSL 使用 AES-256-CBC、随机 salt、PBKDF2-SHA256 600000 次迭代加密；以独立派生的 HMAC 密钥认证含密文摘要的 manifest，解密前先验签与校验密文。密码从权限受控的文件读取，不放入命令参数。随机对象路径为 `backups/YYYY/MM/DD/<uuid>/artifact.enc`，经完整下载 SHA-256 验证后写入认证 manifest。不会上传明文、删除源文件或自动清理历史备份。失败时可能留下未完成的独立对象，需依据失败记录人工核查；不能把缺少 manifest 的对象视为有效备份。

恢复时先下载密文及同名 `.manifest.json`，取得另行保管的原密钥，再执行：

```sh
/data/hsbc/envs/ops/bin/python /data/hsbc/scripts/oss/oss_ops.py decrypt \
  /path/artifact.enc /path/artifact.enc.manifest.json /path/new-output.tar.gz
```

不会覆盖已有恢复文件；校验失败时删除本次产生的输出。manifest 包含摘要、长度和非秘密 key ID，不包含源文件名或密码。工具未安装自动上传定时任务。

## 已验证备份的完整 OSS 恢复演练

`verify_oss_backup.py` 只接受 `/data/hsbc/backups` 的直接子目录：必须有完整清单、通过本地恢复，并且只包含既有备份的六个文件。脚本校验全部摘要，将完整原备份打包；数据库角色密码哈希作为加密恢复数据保留，但不会加入 `.env`、SSH 密钥或 `backup.key`。原目录不修改。

```sh
/data/hsbc/envs/ops/bin/python /data/hsbc/scripts/oss/verify_oss_backup.py \
  /data/hsbc/backups/<已完成且本地恢复通过的备份目录>
```

脚本依次执行角色与私有 ACL 检查、合成对象往返、加密上传、完整下载密文及认证清单、认证解密和六文件逐一摘要核验，最后调用已有 `verify-backup.py`，在不连接业务网络的临时容器内恢复 PG 角色与数据库、验证历史 OPA 规则包和探针。不会覆盖原备份、现有数据库或规则配置。不存在密钥时只生成一次权限 600 的服务器本地密钥，不将其上传。

无秘密记录默认写到 `/data/hsbc/deploy/oss-acceptance.json`，完成必须同时有 `ok: true`、`oss_restore_verified: true`、`completed_at`。其中 `restore` 原样保留独立本地恢复器的结果；它的 `oss_restore_verified: false` 仅表示该本地工具不验证传输，完整 OSS 验收由外层记录确定。下载文件保留在 `/data/hsbc/run/oss-restore-*`，解包备份保留在 `/data/hsbc/backups/oss-restored-*`。

2026-10-12 已完成真实验收，见 [`infra/evidence/oss-20261012`](../evidence/oss-20261012/README.md)。这不代表已经安装 OSS 自动备份定时任务或完成密钥的异地保管。

## RAM 最小权限

- Bucket：`oss:GetBucketInfo`（同时核验 ACL 与地域）。
- `infra-smoke/*`：`oss:PutObject`、`oss:GetObject`、`oss:DeleteObject`。
- `backups/*`：`oss:PutObject`、`oss:GetObject`、`oss:AbortMultipartUpload`；大型上传 SDK 可能需要 `oss:ListParts`。
- 应用资料前缀权限由应用设计补充；工具无需 Bucket 管理、RAM、ACL 修改、全 Bucket 删除权限。

已有 `infra/app/oss-ram-policy.json` 将对象权限限定在该 Bucket，但覆盖全部对象；属于项目级角色，不是仅运维工具的前缀最小权限。不要为读取 ACL 而增加 ACL 修改权限。

## 验证

```sh
cd /data/hsbc/scripts/oss
/data/hsbc/envs/ops/bin/python -m unittest -v test_oss_ops.py
```

离线验证包括加密恢复、密文及 manifest 篡改、密钥权限、禁止覆盖、目录边界和校验失败后的 smoke 清理。真实 OSS 读写需要角色绑定后执行 `smoke`；离线通过不代表 OSS 已可用。

官方参考：[OSS SDK V2](https://www.alibabacloud.com/help/en/oss/developer-reference/2-0-manual-preview-version/)、[Credentials SDK IMDSv2](https://github.com/aliyun/credentials-python)。
