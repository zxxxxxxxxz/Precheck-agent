# 跨境通途 · 跨境融资文件智能审核 Agent

面向银行跨境融资材料办理与复核的智能审核助手，首版业务为境外贷款担保材料（公司担保、个人担保及混合）。系统按经办（Maker）与独立复核（Checker）分工组织案件、材料、证据和审核结果。

## 文档

- [源码与部署说明](docs/delivery/redeployment-guide.md)：部署步骤、Agent 与模型配置、开通账号和规则
- [线上演示操作说明](docs/delivery/online-demo-guide.md)

## 目录

```text
apps/
  api/        HTTP API
  worker/     后台任务（文档解析、模型调用、预审）
  web/        前端
packages/
  contracts/  前后端共享的业务协议与类型
  server/     业务模块、Agent、MCP/A2A 协议、数据库迁移、模型网关
  workflows/  工作流编排
  testing/    样例生成与服务探测工具
infra/        服务器、GPU、OPA、对象存储、DOCX 转换的部署脚本与锁文件
scripts/      构建、迁移、发布与全流程驱动脚本
```

## 构建

需要 Node 24 与 pnpm 10.28.0（`package.json` 中锁定）：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm build
```
# Precheck-agent
# Precheck-agent
