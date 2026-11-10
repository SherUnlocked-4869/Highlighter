# highlighter-contracts（R0）

计划 §4.2 内部 DTO 的 serde 定义，加上 `contracts/host/host-contracts.json` 的**只读**
结构化视图。本 crate 是纯数据层：不访问用户数据、不读时钟、不碰窗口/宿主 API。

## R0 交付

- `WindowRole`：13 个页面角色，`kebab-case` 序列化名与合同 JSON 的 `role` 字符串、
  以及计划 §4.1 的表格一致；`ALL`/`as_str`/`FromStr` 单一来源，不另抄字符串表。
- `HostContext` / `OperationRef` / `ResourceRef` / `OperationError`：字段名与计划 §4.2
  的 TS 草案逐项对应（camelCase）。
- `host_contracts` 模块：解析 `contracts/host/host-contracts.json`（格式见
  [contract-format.md §3](../../../docs/plans/rust-migration/contract-format.md)），
  提供按 role/id/document 的查找；文件不存在时**不**伪造数据，由调用方/测试显式跳过。
- `host_contracts` 里冻结了计划 §5.1 的 schema 版本常量（截图 v3、录屏 v1、剪贴板 DB
  user_version=2、用量 DB user_version=1、数据根 marker v3），文件存在时用测试做交叉校验。

## 明确不做

- 不用 `serde` 类型取代运行时校验（计划 §4.2）；生产协议冻结属于 R1。
- 不定义 `WindowHost`/`CaptureBackend` 等拟新增内部接口的具体行为，只给 DTO。
- 不做权限映射与命令二次校验（R1-04）。

## 依赖方向

只允许 `serde`、`serde_json`。这里唯一读盘的是 `host_contracts` 读取**仓库合同产物**
（不是用户数据）；`tests/dependency_direction.rs` 会检查本 crate 没有引入 tauri/windows/
rusqlite/异步运行时或其它 workspace crate。

## 后续批次

R1 在 `contracts` 之上建立角色能力登记与运行时校验；R2 接入存储合同。
`tests/host_contracts_file.rs` 对真实 `contracts/host/host-contracts.json` 做严格校验
（13 角色 / 257 方法 / 8 项 §9.1 限额 / 6 个 sharedSchemas）；产物缺失即失败，不再 skip。
