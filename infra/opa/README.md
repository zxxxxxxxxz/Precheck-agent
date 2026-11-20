# OPA 基础部署

这是基础设施交付，不实现业务规则中心、银行规则审批或 PG 发布登记。DEMO 仅验证传输、权限、版本、未定义结果和发布恢复；不能用于真实审核结论，也不代表业务合成规则或[当前 v0.5 需求](../../docs/requirements-and-architecture-v0.5.md)已验收。

## v0.5 联合发布的开发边界

当前 `manage.py activate/recover` 保留历史产物，但激活/恢复依靠重建 OPA 容器，更新期间短暂不可用；以下命令和既有验收事实保持有效，不代表已支持无重启热加载。

[规则中心](../../docs/rule-center-design.md)及[开发计划 P4](../../docs/application-mvp-design.md)要求新增 `ReviewConfigRelease` 联合发布：绑定分类、材料、字段和规则子版本；先验证审批/manifest/产物哈希和引擎实际加载 revision、历史版本及健康状态，再原子激活业务发布指针。失败保留上一可用发布，历史命名空间与执行产物并存；仅给输入传旧版本号不足以证明使用旧规则。此能力待开发/验收，本轮未修改管理脚本、配置或服务器。

案件固定 `configuration_release_id`，迁移需显式确认并使依赖结果失效；当前人员/服务授权持续复验。基础设施激活记录不能替代业务批准，旧版本恢复与新版本启用均须核对完整兼容依赖。

## 接入 Compose

把 `compose.fragment.yaml` 的 `opa` 服务与 `rules` 网络合入 APP Compose。OPA 使用 UID/GID `10001:10001`，官方无 shell 镜像直接运行 OPA；无宿主端口、无 Docker socket、无管理 API 身份。`rules` 是只给规则调用方加入的 `internal: true` 网络，显式名称 `hsbc_rules`。

准备 `/data/hsbc/secrets/opa.env`，权限 `0600`，包含两项独立随机值（均至少 32 字符）：

```dotenv
OPA_QUERY_TOKEN=<generate-secret-on-server>
OPA_PROBE_TOKEN=<generate-another-secret-on-server>
```

业务规则服务只取得 `OPA_QUERY_TOKEN`，探针 token 只交付发布流程。两个值不可相同。运行时只开放已登记决策路径的 POST 和 `/health` 的 GET；探针身份额外允许读取已加载版本。任意查询、原始 data、策略管理、写入、`explain` 和未知版本均拒绝。

Compose 的 `deploy/.env` 锁定 `OPA_IMAGE` 与 `NODE_IMAGE`（精确标签及 `@sha256:`）。配置目录和产物内容不含凭证，可让 UID 10001 只读遍历；发布身份才有写权限。不要对应用用户授予 Docker 权限。

## 初次准备与激活

先启动 PG、Redis；首次 OPA 由发布脚本启动。以下变量从服务器部署清单读取，命令不输出凭证：

```sh
python3 infra/opa/manage.py --opa-image "$OPA_IMAGE" prepare
python3 infra/opa/manage.py --opa-image "$OPA_IMAGE" --node-image "$NODE_IMAGE" \
  activate demo_v1 --approved-by user-approved-infrastructure-demo
```

`prepare` 用指定引擎在无网络构建容器内执行能力白名单检查、至少一个真实 Rego 测试、鉴权测试与构建包探针，保存源码、测试结果、能力清单、引擎版本和哈希。已有版本不允许覆盖。发布路径严格限定为 `hsbc/releases/<release_id>`；版本号必须为小写 Rego 标识符。策略不能使用 `opa.runtime`、网络、时钟、随机数、print/trace 等能力；需要的业务时间和事实必须由输入提供。

`activate` 保留全部历史版本，生成 `deploy/compose.opa-loads.json` 的精确 command 数组，仅读挂载获批产物。它只重建 `opa`，核对运行镜像、只读挂载、每份产物哈希、实际 bundle revision、全部历史版本探针及权限拒绝，再原子写入 `config/opa/approved.json`。发布失败恢复原配置并重新验证；不会转到“最新版”。更新期间服务短暂不可用，调用方必须阻塞重试。

**所有后续 Compose 和 systemd 启停命令都必须同时加载两个文件：**

```sh
docker compose --project-directory /data/hsbc/deploy \
  --env-file /data/hsbc/deploy/.env \
  -f /data/hsbc/deploy/compose.yaml \
  -f /data/hsbc/deploy/compose.opa-loads.json up -d
```

发布配置内的允许列表用于 OPA 端点授权；`approved.json` 是基础设施激活记录。未来规则服务必须核对 PG 中的业务批准登记及案件固定版本，不能将基础设施 `--approved-by` 字符串当作真实业务审批，也不能仅凭 HTTP 200 判为规则成功。缺少 `result`、版本不符和错误均应阻塞。

## 恢复、校验与备份

```sh
python3 infra/opa/manage.py --opa-image "$OPA_IMAGE" --node-image "$NODE_IMAGE" verify
python3 infra/opa/manage.py --opa-image "$OPA_IMAGE" --node-image "$NODE_IMAGE" recover
```

只有检测到 `pending-activation.json` 的中断发布时使用 `recover`；它恢复日志保存的上一配置，再验证旧版本。若回滚也失败，中断记录保留，下次发布拒绝继续，修复原因后再次恢复。备份包括 `policies/releases`、`config/opa`、`deploy/compose.opa-loads.json` 和镜像版本清单；凭证单独保护。不要手改 `approved.json` 或发布产物。

源码 `authz` 的更新必须单独审核；脚本发现已安装授权策略与仓库不一致会拒绝自动覆盖。首次部署失败会保留健康但拒绝业务查询的空加载清单，便于修复后重试。

## 本地真实验证

从官方 release 获取 OPA **1.21.1**，设置 `OPA_BINARY`；Node 20+ 可运行独立 HTTP 探针。不会启动 Docker、修改真实服务器或使用真实资料。

```sh
OPA_BINARY=/path/to/opa python3 -m unittest discover -s infra/opa -p 'test_*.py' -v
```

测试执行真实 Rego、HTTP 鉴权、实际载入 revision、未知 schema 无结果、不可变版本、产物篡改拒绝、危险能力拒绝和发布失败恢复。镜像拉取、Docker mount/UID、真实 Compose 重建和备份恢复仍需要 APP 现场验收。

## APP 现场验收记录（2026-10-12）

已在 APP 使用锁定的 OPA 1.21.1 与 Node 24.21.0 镜像执行 `acceptance.py --run-on-server`。实际加载 `demo_v1`、`demo_v2`，12 个合成决策探针与 12 个未授权操作拒绝检查通过。候选容器通过真实 HTTP 探针后注入发布失败，原加载清单、历史包哈希和两个历史版本均经容器重建恢复验证；中断日志阻断再次发布与恢复也通过。

另从同一镜像提取二进制运行六项集成测试，覆盖历史包丢失、产物篡改、不可变版本、策略能力限制、双版本 HTTP 权限及失败恢复。证据位于 `acceptance-app-2026-10-12.json`、`integration-app-2026-10-12.txt`；服务器保留对应 `/data/hsbc/run/opa-acceptance.json` 与 `/data/hsbc/run/opa-integration-tests.txt`。

`demo_rollback` 是故障注入产生的已准备但未激活产物，不在允许查询的加载清单中。验收脚本仅允许现有加载清单包含 `demo_v1/demo_v2` 的基础部署环境，执行期间会短暂重建 OPA；真实规则发布后不要运行此脚本。业务批准登记、应用层阻塞语义及关联备份恢复不属于本次合成 OPA 验收。
