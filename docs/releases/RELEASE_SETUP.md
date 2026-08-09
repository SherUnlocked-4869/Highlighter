# Windows Release 环境配置

正式发布由 `.github/workflows/release.yml` 响应匹配版本的 `v*` tag。工作流只创建或更新 draft Release，不会自动公开发布。

## 1. GitHub Environment

创建名为 `release` 的 Environment，并配置：

- 至少一名 required reviewer。
- 仅允许受保护的 tag 规则 `v*` 部署。
- 签名凭据只保存在该 Environment，不放入仓库或普通 Actions 变量。

## 2. 通用变量

| 类型 | 名称 | 内容 |
|---|---|---|
| Variable | `WIN_SIGNING_PROVIDER` | `azure` 或 `pfx` |
| Variable | `WIN_SIGNING_PUBLISHER` | 证书的 Simple Name，签名验证精确匹配 |

## 3. Azure Trusted Signing

使用 `WIN_SIGNING_PROVIDER=azure` 时配置：

| 类型 | 名称 |
|---|---|
| Variable | `WIN_AZURE_ENDPOINT` |
| Variable | `WIN_AZURE_CERTIFICATE_PROFILE` |
| Variable | `WIN_AZURE_CODE_SIGNING_ACCOUNT` |
| Secret | `AZURE_TENANT_ID` |
| Secret | `AZURE_CLIENT_ID` |
| Secret | `AZURE_CLIENT_SECRET` |

服务主体只授予目标 Trusted Signing profile 所需的最小签名权限。

## 4. PFX 回退

使用 `WIN_SIGNING_PROVIDER=pfx` 时配置：

| 类型 | 名称 | 内容 |
|---|---|---|
| Secret | `WIN_CSC_LINK` | PFX 的 base64、HTTPS 地址或 runner 可访问路径 |
| Secret | `WIN_CSC_KEY_PASSWORD` | PFX 密码 |

PFX 不得提交到仓库、Actions artifact、构建日志或 Release 资产。

## 5. 发布步骤

1. 将 `package.json` 与 lockfile 更新为目标版本并单独提交。
2. 在候选提交运行完整 CI、安装/升级烟测和硬件矩阵。
3. 创建并推送完全匹配的 tag，例如 `v2.1.0-beta.1`。
4. required reviewer 审批 `release` Environment。
5. 工作流验证 tag、测试、原生组件、fuses、签名、时间戳、发布者、更新 manifest、SBOM 和 SHA-256。
6. 下载 Actions artifact，在隔离 Windows 环境完成最终安装、覆盖升级和卸载验收。
7. 人工检查 draft Release 后再公开；不得替换已公开版本的同名资产。

任何签名变量缺失、签名无效、时间戳缺失、发布者不匹配或完整性门禁失败都会终止工作流。
