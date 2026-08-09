# Windows 硬件验收与发布晋级

正式发布分为两个阶段：版本 tag 只构建并创建签名的 draft Release；真实机器完成验收并提交证据后，
由受保护的 `Promote verified Windows release` 工作流再次校验资产和证据，再把 draft 公开。任何人都不能
用一次本机 smoke 代替 Windows 10、DPI、RDP 或休眠恢复矩阵。

## 证据约束

- 必须测试 draft Release 中的签名 NSIS 或 portable 资产，不能用源码运行或 unsigned 包代替。
- 每份证据绑定版本、tag 对应的完整 commit、资产 SHA-256、Authenticode publisher 和时间戳。
- 证据不记录机器名、用户名、显示器序列号或凭据；只记录 OS、GPU 驱动、显示布局和 DPI。
- `pass` 需要 reviewer、说明、原生组件/真实抓屏 runtime probe 和逐项通过结果。
- P0/P1 会阻止发布；P2 必须有 Issue URL 和可执行的规避说明。
- 所有证据必须指向同一个 tag commit。验收后除该版本的 evidence JSON 外只要还有源码变化，证据立即失效。

必测 claim 定义在 `config/release-hardware-matrix.json`。一份证据可以覆盖同一台机器、同一安装类型上实际
执行过的多个 claim，但不得仅因环境看起来相符就声明通过。

## 采集流程

1. 推送版本 tag，等待 `Signed Windows release` 生成 draft 和签名资产。
2. 在隔离测试机检出该 tag，下载并安装 draft 中的准确资产。
3. 按 claim 描述完成功能、安装/卸载、DPI、会话或电源场景。
4. 在同一 tag checkout 中构建 native helper，然后采集证据。例如：

```powershell
npm ci
npm run build:native
npm run collect:hardware -- `
  -PackageType nsis `
  -ArtifactPath C:\candidate\Highlighter-Setup-2.1.0-beta.1.exe `
  -Claims "windows-11-current-full-smoke,dpi-150-capture,nsis-data-and-update-paths" `
  -Result pass `
  -Reviewer "release-reviewer" `
  -Notes "Full smoke, capture, OCR, pin, recording, data root, and update channel passed." `
  -RunRuntimeProbe
```

如果存在 P2，在命令中额外提供 `-DefectSeverity P2 -IssueUrl <URL> -Workaround <说明>`。失败场景使用
`-Result fail` 和 P0/P1/P2；不得把失败记录改写成 pass。

5. 将生成的 JSON 放入 `docs/releases/evidence/<version>/`，汇总所有机器的证据并提交。该提交只能包含证据。
6. 在本地先运行：

```powershell
npm run verify:hardware -- --version 2.1.0-beta.1 --source-commit <tag-commit>
```

7. 在 GitHub 手动运行 `Promote verified Windows release` 并输入 tag。受保护的 `release` Environment 审批后，
工作流会重新校验矩阵、tag commit、draft 状态、资产签名/时间戳、manifest、SBOM 和 SHA-256，全部通过才公开。

## 覆盖范围

矩阵要求 Windows 10 22H2、当前稳定 Windows 11、100%/125%/150%/200% DPI、混合 DPI 负坐标双屏、
睡眠/唤醒/锁屏、RDP、NSIS 和 portable。GitHub hosted runner 只执行自动化测试，不提供这些真实硬件证据。
