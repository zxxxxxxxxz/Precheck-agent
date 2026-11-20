# 「跨境通途」源码与部署说明

供银行 IT 人员用随附的源码包重新部署。命令均以 `root` 在应用服务器执行。

## 1. 准备

| 项目 | 要求 |
| --- | --- |
| 应用服务器 | Ubuntu 24.04 x86_64，数据盘挂载到 `/data` |
| 域名与证书 | 一个 HTTPS 域名及证书 |
| 对象存储 | 阿里云 OSS 私有桶，开启版本控制 |
| OCR／NER 服务 | 一台 24 GB 显存 GPU，安装脚本见 [infra/gpu3090](../../infra/gpu3090/README.md) |
| 本地模型 | 一台 32 GB 显存 GPU，vLLM + `Qwen/Qwen3.8-27B`，安装脚本见 [infra/gpu5090/qwen38](../../infra/gpu5090/qwen38/README.md) |
| 云端大模型 | 任一 OpenAI 兼容的云端模型服务（Responses 接口）及 API Key |

## 2. 源码

把源码包解压到 `/data/hsbc/app`。

站点域名、证书目录和 OSS 桶名写在下列文件中（现网为 `hsbc.mse.pub`、`/etc/ssl/certs/mse.pub/`、`hsbc-poc`），部署到其他域名时先修改：

`infra/app/nginx.conf.template`、`infra/app/activate-tls.py`、`infra/app/hsbc-tls-renewal.service`、`infra/app/p1-configure.py`、`infra/app/oss-p1-cors.json`、`scripts/p1-deploy.py`

## 3. 部署

```bash
# 1. 主机：安装 Docker、Nginx，创建 /data/hsbc 目录和运行用户
cd /data/hsbc/app
bash infra/app/install-host.sh

# 发布工具按 Git 提交构建：把解压后的源码（含上面的修改）提交为本地版本
git init -q && git add -A
git -c user.name=deploy -c user.email=deploy@localhost commit -qm "source package"

# 2. 安装运维脚本
install -m 750 infra/app/{compose.sh,setup-runtime.sh,backup.py,verify-backup.py,p1-configure.py,activate-tls.py,init-secrets.py,pull-images.py} scripts/p1-deploy.py /data/hsbc/scripts/
install -m 755 infra/app/init-postgres.sh /data/hsbc/scripts/
install -m 644 infra/app/{compose.yaml,compose.p1.yaml} /data/hsbc/deploy/
install -m 644 infra/app/hsbc-{infra,backup,tls-renewal}.service infra/app/hsbc-{backup,tls-renewal}.timer /data/hsbc/config/systemd/

# 3. 镜像、凭据，启动 PostgreSQL 和 Redis
python3 /data/hsbc/scripts/pull-images.py
python3 /data/hsbc/scripts/init-secrets.py
bash /data/hsbc/scripts/setup-runtime.sh

# 4. 启动规则引擎 OPA
set -a; . /data/hsbc/deploy/.env; set +a
python3 infra/opa/manage.py --opa-image "$OPA_IMAGE" prepare
python3 infra/opa/manage.py --opa-image "$OPA_IMAGE" --node-image "$NODE_IMAGE" activate demo_v1 --approved-by <执行人>

# 5. 生成应用配置 /data/hsbc/secrets/p1-api.env、p1-worker.env，然后按第 4 节补充
python3 /data/hsbc/scripts/p1-configure.py

# 6. 构建、迁移、上线（证书先放到 activate-tls.py 指定的目录）
python3 /data/hsbc/scripts/p1-deploy.py prepare HEAD           # 输出完整 commit
echo "P1_RELEASE_DIR=/data/hsbc/releases/<commit>/source" > /data/hsbc/deploy/p1-release.env   # 仅首次部署
python3 /data/hsbc/scripts/p1-deploy.py migrate <commit>
python3 /data/hsbc/scripts/p1-deploy.py activate <commit>
systemctl enable --now hsbc-infra.service hsbc-backup.timer hsbc-tls-renewal.timer

# 7. 创建管理员，临时密码写入 /data/hsbc/secrets/bootstrap/bootstrap-admin.json
install -d -m 700 /data/hsbc/secrets/bootstrap
docker run --rm --network hsbc_app --read-only --tmpfs /tmp --workdir /app \
  -v /data/hsbc/releases/<commit>/source:/app:ro \
  -v /data/hsbc/secrets/p1-migration.env:/run/secrets/p1-migration.env:ro \
  -v /data/hsbc/secrets/bootstrap:/out \
  "$NODE_IMAGE" node --env-file=/run/secrets/p1-migration.env --import tsx \
  scripts/p1-bootstrap.ts sys.admin "系统管理员" /out/bootstrap-admin.json
```

说明：

- 第 3 步：不使用 SSH 隧道时，先删除 `setup-runtime.sh` 中处理 `secrets/ssh/` 的三行，否则目录为空时脚本会报错退出。
- 第 6 步：首次部署要先写 `p1-release.env`，否则 `migrate` 停止应用服务时会报 `no such service`。
- `activate` 完成后会自动做一次上线检查；之后升级重复第 6 步，回退用 `p1-deploy.py rollback`。

## 4. Agent 与模型配置

Agent 代码在 `packages/server/src/agents/`。各 Agent 用到的工具和模型如下：

| 环节 | 工具／模型 |
| --- | --- |
| 文档识别 | OCR、NER（GPU 服务） |
| 隐私脱敏 | NER + 本地模型 Qwen |
| 字段提取、建案助手 | 云端大模型（OpenAI 兼容接口） |
| 规则核对 | OPA |
| 核对辅助、参考译文 | 本地模型 Qwen |

把下面内容追加到 `p1-api.env` 和 `p1-worker.env`，**两份必须相同**：

```dotenv
# 对象存储（站点、数据库、Redis 已由 p1-configure.py 生成）
P1_OSS_ACCESS_KEY_ID=<OSS AccessKey>
P1_OSS_ACCESS_KEY_SECRET=<OSS AccessKey Secret>

# 工具：OCR / NER
P1_OCR_BASE_URL=<OCR 服务地址>
P1_OCR_TOKEN=<令牌>
P1_NER_BASE_URL=<NER 服务地址>
P1_NER_TOKEN=<令牌>

# 本地模型
P1_QWEN_BASE_URL=<vLLM 地址>/v1
P1_QWEN_MODEL=Qwen/Qwen3.8-27B
P1_QWEN_TOKEN=<令牌>
P3_LOCAL_INTAKE_ENABLED=true
P3_LOCAL_INTAKE_VALIDATED=true
P3_LOCAL_INTAKE_TIMEOUT_MS=120000
P3_LOCAL_INTAKE_MAX_INPUT_TOKENS=6000
P3_LOCAL_INTAKE_MAX_OUTPUT_TOKENS=1024
P3_LOCAL_INTAKE_REQUESTS_PER_MINUTE=3
P3_LOCAL_INTAKE_DAILY_BUDGET_MICROS=1000000000000000
P3_LOCAL_INTAKE_CALL_BUDGET_MICROS=100000000
P3_LOCAL_INTAKE_INPUT_MICROS_PER_MILLION=100000000
P3_LOCAL_INTAKE_OUTPUT_MICROS_PER_MILLION=100000000
P3_ASSISTANT_LOCAL_TIMEOUT_MS=120000
P3_ASSISTANT_LOCAL_MAX_INPUT_TOKENS=6000
P3_ASSISTANT_LOCAL_MAX_OUTPUT_TOKENS=2048
P3_ASSISTANT_LOCAL_REQUESTS_PER_MINUTE=120
P3_ASSISTANT_LOCAL_DAILY_BUDGET_MICROS=1000000000000000
P3_ASSISTANT_LOCAL_CALL_BUDGET_MICROS=100000000
P3_ASSISTANT_LOCAL_INPUT_MICROS_PER_MILLION=100000000
P3_ASSISTANT_LOCAL_OUTPUT_MICROS_PER_MILLION=100000000
P3_ASSISTANT_MAX_SOURCE_BYTES=256000
P3_ASSISTANT_MAX_PRIVACY_CALLS=192
P3_REVIEW_ASSIST_ENABLED=true
P3_REVIEW_ASSIST_MODEL_REVISION=6128240ebaf4eaa7bad2b3d1c72c37d677c5f462
P3_DOCUMENT_TRANSLATION_ENABLED=true
P3_DOCUMENT_TRANSLATION_MODEL_REVISION=6128240ebaf4eaa7bad2b3d1c72c37d677c5f462

# 云端大模型：任一 OpenAI 兼容服务（变量名沿用 AZURE_OPENAI_ 前缀）
P3_CLOUD_MODE=public_synthetic
AZURE_OPENAI_ENDPOINT=<兼容服务地址，如 https://xxx/v1>
AZURE_OPENAI_DEPLOYMENT=<模型名>
AZURE_OPENAI_API_KEY=<API Key>
P3_EGRESS_POLICY_JSON=<建案助手出站策略>
P3_ASSISTANT_CLOUD_TIMEOUT_MS=120000
P3_ASSISTANT_CLOUD_MAX_INPUT_TOKENS=524288
P3_ASSISTANT_CLOUD_MAX_OUTPUT_TOKENS=4096
P3_ASSISTANT_CLOUD_REQUESTS_PER_MINUTE=12
P3_ASSISTANT_CLOUD_DAILY_BUDGET_MICROS=1000000000000000
P3_ASSISTANT_CLOUD_CALL_BUDGET_MICROS=100000000
P3_ASSISTANT_CLOUD_INPUT_MICROS_PER_MILLION=100000000
P3_ASSISTANT_CLOUD_OUTPUT_MICROS_PER_MILLION=100000000
P3_DOCUMENT_CLOUD_ENABLED=true
P3_DOCUMENT_EGRESS_POLICY_JSON=<字段提取出站策略>
P3_DOCUMENT_CLOUD_TIMEOUT_MS=240000
P3_DOCUMENT_CLOUD_MAX_OUTPUT_TOKENS=16384

# 规则引擎（令牌取 /data/hsbc/secrets/opa.env 中的 OPA_QUERY_TOKEN）
P3_OPA_BASE_URL=http://opa:8181
P3_OPA_TOKEN=<OPA_QUERY_TOKEN>
P3_OPA_ALLOW_HTTP=true

# 业务功能
P2_DOCUMENT_ENABLED=true
P2_READER_ENABLED=true
P2_DIRECTORY_ENABLED=true
P2_SEARCH_ENABLED=true
P2_COMPARISON_ENABLED=true
P2_DOCX_ENABLED=true
P3_REVIEW_CONFIG_ENABLED=true
P3_REVIEW_ENABLED=true
P3_DOCUMENT_POLICY_REUSE_ENABLED=true
P3_DOCUMENT_CASE_AUTHORIZATION_ENABLED=true
P3_DOCUMENT_NER_SOURCE_SPANS_ENABLED=true
P4_SUBJECT_CONFIRMATION_ENABLED=true
```

以上数值是本机跑通完整流程时用的取值（预算单位为百万分之一美元），可按需调整，但不能省略。OCR、NER 走内网 HTTP 时加 `P1_OCR_ALLOW_HTTP=true`、`P1_NER_ALLOW_HTTP=true`。云端模型按 `<服务地址>/responses` 调用（OpenAI Responses 接口），任何提供该接口的 OpenAI 兼容服务都可以使用；密钥以标准的 `Authorization: Bearer` 请求头发送（Azure OpenAI 地址自动改用 `api-key` 请求头）。两个出站策略 JSON 的字段写法见 [p3.env.example](../../infra/app/p3.env.example)：端点填完整的 `<服务地址>/responses`，部署名与上面的模型名一致，`provider` 字段固定填 `azure-openai`（内部标签，不限定服务商）。

上线后再修改配置，执行 `/data/hsbc/scripts/compose.sh restart app-api app-worker` 生效。

## 5. 开通账号和规则

1. 读取 `bootstrap-admin.json` 中的临时密码，用管理员登录站点并改密，然后删除该文件。
2. **系统管理 → 账号管理**：创建经办、复核两个账号，业务岗位选 BCO。两人各自登录一次并改密。
3. **系统管理 → 权限管理**：设置“经办 → 复核”固定分工，系统自动授予两人办理和复核所需权限。
4. **规则中心**：发布至少一套审核配置（试跑后由另一人审批、发布），新建案件时才能选到担保类型。规则包装载到 OPA 的命令见 [infra/opa/review](../../infra/opa/review/README.md)。

完成后按[线上演示操作说明](online-demo-guide.md)走一遍完整流程即可验收。
