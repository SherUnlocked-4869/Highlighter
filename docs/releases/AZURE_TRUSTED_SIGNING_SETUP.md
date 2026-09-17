# Azure Trusted Signing 配置教程

本教程完整说明如何为 Highlighter 配置 Azure Trusted Signing（云端代码签名），使 `.github/workflows/release.yml` 能在 GitHub Actions 上自动签名并发布 Release。全程不需要 PFX 文件 —— 私钥永不离开微软云端。

配套代码：`scripts/prepare-release-signing.ps1`（生成签名配置）、`.github/workflows/release.yml`（签名构建）、`scripts/verify-release.ps1`（签名校验）。

## 1. 原理与流程

```
推 tag v2.1.0-beta.0
        │
        ▼
release.yml  ──►  prepare-release-signing.ps1
        │            读取环境变量/密钥，生成 electron-builder.azure.json
        ▼
electron-builder  ──►  azureSignOptions  ──►  @electron/windows-sign
        │                                        │
        ▼                                        ▼
   签名安装包 + 便携版                    向 Azure Trusted Signing 发起
   (4-6 个文件逐个签名)                   云端签名请求（私钥在云端）
        │
        ▼
   verify-release.ps1  ──►  签名状态 Valid + 时间戳 + 发布者匹配
        │
        ▼
   创建 draft Release（人工验收后由 promote-release.yml 公开发布）
```

对比方案：

| 项目 | Azure Trusted Signing | PFX |
|---|---|---|
| 私钥位置 | 微软云端，不可导出 | 自己保管 |
| 泄漏风险 | 无（无文件可泄漏） | PFX 泄漏即被冒用 |
| 有效期 | 证书由微软滚动管理，不操心续期 | 1-3 年需续期 |
| SmartScreen 信任 | 支持（Public Trust） | 支持（商用证书） |
| 需要上传 GitHub 的凭据 | 服务主体 client secret | PFX base64 + 密码 |

## 2. 成本

- **按量计费**：约 $9.99 / 1000 次签名（以 [官方定价页](https://azure.microsoft.com/pricing/details/trusted-signing/) 为准）。
- 一次 Highlighter release 构建约签 5 个文件（`Highlighter.exe`、`HighlighterOcrSidecar.exe`、`ffmpeg.exe`、`elevate.exe`、Setup 本体 + uninstaller），即每次发布约 $0.05，可忽略。
- **Public Trust 身份验证**：首次申请时由第三方 CA（DigiCert）收取一次性费用（约 $299，以官方渠道报价为准），只交一次，之后证书由微软免费滚动更新。

## 3. 前置条件

- 一个 **Azure 订阅**（按需付费或企业协议），你需要有该订阅的 **Owner** 权限（用于注册资源提供程序和创建服务主体）。
- **Azure CLI**（[安装](https://learn.microsoft.com/cli/azure/install-azure-cli)），本教程所有命令都基于 `az`。
- 一个**组织实体**（企业主体身份）：Public Trust 身份验证需要提交营业执照/公司注册文件。个人开发者若无公司，可用个人独资企业执照，或先选 Private Trust 测试流程。
- 浏览器 + 一个企业邮箱（接收审批邮件）。

## 4. 创建 Trusted Signing 账户

### 4.1 登录并注册资源提供程序

```powershell
az login
az provider register --namespace Microsoft.CodeSigning
# 等待几分钟后可查状态：
az provider show --namespace Microsoft.CodeSigning --query registrationState
```

### 4.2 创建资源组和账户

```powershell
# 区域可自选，推荐与你 GitHub Actions 运行器接近的区域
az group create --name HighlighterSigning --location eastus2

az trustedsigning create `
  --account-name HighlighterTrustedSigning `
  --resource-group HighlighterSigning `
  --location eastus2 `
  --sku Basic
```

> `--sku`：测试阶段选 `Basic` 即可；`Premium` 针对高频签名（>1000 次/月）。

### 4.3 可用区域与签名端点

| 区域 | 签名端点（endpoint） |
|---|---|
| West Central US | `https://wus2.codesigning.azure.net` |
| East US 2 | `https://eaus2.codesigning.azure.net` |
| West Europe | `https://westeurope.codesigning.azure.net` |
| UK South | `https://uksouth.codesigning.azure.net` |
| Central India | `https://centralindia.codesigning.azure.net` |
| East Asia | `https://eastasia.codesigning.azure.net` |

> 端点列表以 [官方文档](https://learn.microsoft.com/azure/trusted-signing/how-to-signing-integrations) 为准，账户所在区域与端点必须对应，记下你账户所在区域的端点，稍后要填入 GitHub。

## 5. 创建证书配置文件（Certificate Profile）

### 5.1 选择配置类型

| 类型 | 用途 | 是否被 Windows 信任 |
|---|---|---|
| **Public Trust** | 正式对外发布的安装包（SmartScreen 消除"未知发布者"） | 是 |
| Private Trust | 内部分发、测试 | 否 |
| VBS Enclave | 特殊场景（本仓库不用） | — |

正式发布选 **Public Trust**。流程分两步：先做身份验证（Identity Validation），再创建签名配置文件。

### 5.2 提交身份验证申请（Public Trust 必需）

> 此步骤在 Azure 门户操作，无法用 CLI 完全代替，因为需要上传证明文件。

1. 打开 [Azure 门户](https://portal.azure.com) → 进入刚创建的 `HighlighterTrustedSigning` 账户。
2. 左侧 **Certificate profiles** → **Create**。
3. Profile type 选 **Identity Validation**，命名如 `HighlighterIdentityValidation`。
4. 按表单提交组织信息、联系邮箱，并**下载申请表**（PDF），填写盖章后上传。
5. 等待审批（一般 **1-3 个工作日**，DigiCert 审核）。审批期间不影响创建账户，但 Public Trust 签名配置创建前必须完成。

### 5.3 创建 Public Trust 签名配置

审批通过后：

1. 账户页 → **Certificate profiles** → **Create**。
2. Profile type 选 **Public Trust**。
3. 名称填写 `PublicTrustProfile`（或你喜欢的名字），选择刚审批通过的 Identity Validation 配置。
4. 创建成功后记下 **证书配置文件名**（Certificate profile name），如 `PublicTrustProfile`。
5. 页面里可下载该配置签发的证书（`.cer`），用以下命令查看证书 **Subject 的 CN（Simple Name）**，它就是稍后要填的 `WIN_SIGNING_PUBLISHER`：

```powershell
Get-AuthenticodeSignature .\downloaded.cer
# 或
openssl x509 -in downloaded.cer -noout -subject
```

> 例：CN=Highlighter LLC → `WIN_SIGNING_PUBLISHER=Highlighter LLC`（必须精确匹配，`verify-release.ps1` 会校验）。

## 6. 创建服务主体（给 GitHub Actions 用）

GitHub Actions 需要一组 Azure 凭据（租户 ID + 客户端 ID + 客户端密钥）来调用签名接口。用最小权限：只授予**该证书配置文件的签名角色**。

```powershell
# 替换为你的订阅 ID
az account show --query id -o tsv

# 创建服务主体，作用域限定到证书配置文件
az ad sp create-for-rbac `
  --name highlighter-release-signer `
  --role "Trusted Signing Certificate Profile Signer" `
  --scopes "/subscriptions/<订阅ID>/resourceGroups/HighlighterSigning/providers/Microsoft.CodeSigning/codeSigningAccounts/HighlighterTrustedSigning/certificateProfiles/PublicTrustProfile"

# 输出示例（务必保存好 password，只显示一次）
# {
#   "appId": "11111111-2222-3333-4444-555555555555",
#   "password": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
#   "tenant": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
# }
```

角色与资源类型的验证：

```powershell
az role assignment list --assignee "<appId>" --query "[].{role:roleDefinitionName, scope:scope}" -o table
```

| 后续填入 GitHub 的密钥 | 来自 |
|---|---|
| `AZURE_CLIENT_ID` | `appId` |
| `AZURE_CLIENT_SECRET` | `password` |
| `AZURE_TENANT_ID` | `tenant` |

> 如果创建的服务主体在角色名上报错，先用 `az role definition list --query "[?contains(roleName,'Trusted Signing')].roleName" -o tsv` 确认当前租户中的准确角色名。

## 7. 配置 GitHub release Environment

> 环境不存在时 `release.yml` 会 404 失败；按以下命令创建并填入全部值。

```powershell
gh api repos/SherUnlocked-4869/Highlighter/environments/release -X PUT

# --- Secrets（不显示值）---
gh secret set AZURE_TENANT_ID --env release
gh secret set AZURE_CLIENT_ID --env release
gh secret set AZURE_CLIENT_SECRET --env release

# --- Variables（普通变量）---
gh variable set WIN_SIGNING_PROVIDER --env release --body "azure"
gh variable set WIN_SIGNING_PUBLISHER --env release --body "Highlighter LLC"
gh variable set WIN_AZURE_ENDPOINT --env release --body "https://wus2.codesigning.azure.net"
gh variable set WIN_AZURE_CERTIFICATE_PROFILE --env release --body "PublicTrustProfile"
gh variable set WIN_AZURE_CODE_SIGNING_ACCOUNT --env release --body "HighlighterTrustedSigning"
```

配置清单总览：

| 类型 | 名称 | 示例值 | 来源 |
|---|---|---|---|
| Variable | `WIN_SIGNING_PROVIDER` | `azure` | 固定 |
| Variable | `WIN_SIGNING_PUBLISHER` | `Highlighter LLC` | 签名证书 CN（5.3 步） |
| Variable | `WIN_AZURE_ENDPOINT` | `https://wus2.codesigning.azure.net` | 账户区域端点（4.3 步） |
| Variable | `WIN_AZURE_CERTIFICATE_PROFILE` | `PublicTrustProfile` | 证书配置名（5.3 步） |
| Variable | `WIN_AZURE_CODE_SIGNING_ACCOUNT` | `HighlighterTrustedSigning` | 账户名（4.2 步） |
| Secret | `AZURE_TENANT_ID` | GUID | 服务主体 tenant（6 步） |
| Secret | `AZURE_CLIENT_ID` | GUID | 服务主体 appId（6 步） |
| Secret | `AZURE_CLIENT_SECRET` | 字符串 | 服务主体 password（6 步） |

（可选加固）给 `release` 环境添加 required reviewer：Settings → Environments → `release` → Deployment branches and tags 限定 `v*`，Required reviewers 添加一个账号。

## 8. 本地验证（可选，建议先跑通再推 tag）

用同一套 Azure 凭据在本地模拟 CI 签名，提前暴露配置错误（如角色、端点、profile 名）：

```powershell
$env:WIN_SIGNING_PROVIDER = "azure"
$env:WIN_SIGNING_PUBLISHER = "Highlighter LLC"
$env:WIN_AZURE_ENDPOINT = "https://wus2.codesigning.azure.net"
$env:WIN_AZURE_CERTIFICATE_PROFILE = "PublicTrustProfile"
$env:WIN_AZURE_CODE_SIGNING_ACCOUNT = "HighlighterTrustedSigning"
$env:AZURE_TENANT_ID = "<tenant>"
$env:AZURE_CLIENT_ID = "<appId>"
$env:AZURE_CLIENT_SECRET = "<password>"

# 生成签名配置并构建（会真实发起云端签名请求）
.\scripts\prepare-release-signing.ps1
npx electron-builder --config dist/electron-builder.azure.json --win nsis portable --x64 --publish never "--config.electronDist=(Resolve-Path 'node_modules/electron/dist').Path"

# 校验签名
Get-AuthenticodeSignature .\dist\Highlighter-Setup-*.exe | Select Status, @{N='Publisher';E={$_.SignerCertificate.Subject}}
# 期望：Status=Valid，Publisher 包含你填的 CN
```

## 9. 触发 GitHub 自动发布

1. 确认 `package.json` 与 `package-lock.json` 版本一致并已提交。
2. 推送完全匹配的 tag：

```powershell
git tag v2.1.0-beta.0
git push origin v2.1.0-beta.0
```

3. `release.yml` 自动运行：全量测试 → 签名构建 → 校验 → 创建 **draft Release**（若配置了 reviewer 需先审批）。
4. 下载 Actions artifact，在本机隔离环境做安装/升级/卸载验收。
5. 验收通过后，手动运行 `promote-release.yml`，输入 tag → 自动公开发布。

## 10. 常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 构建日志 `error signing with azure: unauthorized` | 服务主体缺少 `Trusted Signing Certificate Profile Signer` 角色，或 secret 过期 | 重查角色分配；`az ad sp credential reset` 生成新 secret 并更新 GitHub |
| `certificate profile not found` | profile 名拼写错误，或 profile 与账户不在同一区域 | 门户里核对 profile 名与账户区域 |
| `invalid endpoint` | endpoint 与账户区域不匹配 | 按 4.3 表核对 |
| 签名成功但 `verify-release` 报 publisher 不匹配 | `WIN_SIGNING_PUBLISHER` 与证书 CN 不一致（含大小写/空格） | 从门户下载证书用 `Get-AuthenticodeSignature` 查看精确 CN |
| 签名成功但 Status 非 Valid（如 UnknownError） | 用了 Private Trust 或在无网环境下校验 | Public Trust 配置的证书本身受信任，CI 校验时保证可访问时间戳服务 |
| Identity Validation 一直审批中 | 申请表填写/盖章不完整 | 登录门户查看反馈，补齐后重新提交 |
| 免费试用/订阅类型限制 | Trusted Signing 要求按需付费或企业协议 | 升级订阅或换有资格的订阅 |

## 11. 安全注意事项

- `AZURE_CLIENT_SECRET` 只允许保存在 GitHub Environment Secret 中，不要写入仓库、日志或本地脚本文件。
- 服务主体已限定到**单个证书配置文件**作用域，即使泄露也仅能签名该 profile，无法管理 Azure 资源。
- 证书与私钥无法从 Azure 导出，不存在 PFX 泄漏风险。
- 若怀疑 secret 泄露：`az ad sp credential reset --id <appId>` 后更新 GitHub Secret，旧密钥立即失效。
- 不要删除/修改证书配置文件，否则已签发的安装包无法验证后续版本的一致性。
