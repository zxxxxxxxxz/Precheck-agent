# P3 受控业务配置装载

`GET /api/review-configs/:id/package` 返回经 `rule:read` 授权的配置、生成策略、不可变 namespace 及哈希。只将完整导出保存到受控文件；不要把 Cookie 或授权头写入文件或日志。

用已固定的官方 OPA 1.21.1 校验合成事实并生成既有发布工具的输入：

```sh
python3 infra/opa/review/prepare.py --package /controlled/candidate.json --source-out /controlled/review-source --opa-binary /controlled/opa
```

该操作使用能力白名单，禁止网络、运行环境、时钟、随机数和任意查询。逐条核验声明的正常、异常、边界及缺输入预期，产生真实 OPA 回执和 Rego 测试；只准备源目录，不批准或激活业务配置。

发布身份随后按现有 `infra/opa/manage.py` 的 `prepare --source /controlled/review-source` 和 `activate <release_id>` 流程装载；`--root`、`--opa-image`、`--node-image` 等全局参数放在子命令前。生成的包遵守 `hsbc/releases/<release_id>` 独立命名空间，不修改旧 demo，也不覆盖历史版本。实际参数和发布根目录沿用部署清单。业务 API 没有 OPA 管理、文件写入、Docker 或探针身份。

装载成功之后，业务配置按 validate → trial → 独立人员 approve → publish 执行。trial 通过正式 HTTP 查询全部合成测试，publish 再次核验实际加载包回执；业务发布事务保存 manifest、策略、试跑、批准和发布回执哈希。基础设施激活不等于业务批准。未审批包即使已加载，也不能被正式案件绑定；缺包、错版、无结果、超时均阻断。

本目录的两份 `synthetic-*.txt` 只作为候选配置的可复算来源和配方，不是银行规则。`LocalOpaExecutor` 仅供显式本机合成回归，正式环境必须使用 `HttpRuleExecutor`。

## Source and extraction provenance

`docs/p3/review-source-dispositions.json` records the five actual supplied workbooks by SHA-256 and every indexed sheet/row/cell reference. It deliberately contains no cell contents. Candidate, manual, and excluded rows each retain a reason and an empty implementation mapping until the source is interpreted and approved. Physical indexed rows include notes and formatting and must not be reported as atomic rule counts. The synthetic package uses its own source, never these pending workbook rows.

Regenerate the register only from the controlled source catalog and its authorized local source-input manifest with `register-sources.ts --catalog <catalog> --input <source-input> --output docs/p3/review-source-dispositions.json`. It verifies each current workbook against its recorded hash. `REVIEW_EXTRACTION_RECIPES` pins every supported version/model/prompt-hash/mode/scope combination; a new implementation or prompt requires a new reviewed entry and release. The set-coverage operator consumes an explicitly confirmed JSON string array; natural-language lists are never split into sets automatically.

## 当前装载记录

2026-10-19 已补装 `mortgage_1792223224986` 合成配置，原页面 60/60 试例通过，尚未业务批准或发布。未登记的 decision 路径会被查询授权拒绝；账号具有 `rule:trial` 不代表规则包已经装载。规则内容改变后必须使用新的不可变发布标识并再次走准备／装载流程，不能覆盖现有包。操作、备份恢复和验收范围见[试跑修复记录](../../../docs/p3/rule-trial-readiness-20261019.json)。
