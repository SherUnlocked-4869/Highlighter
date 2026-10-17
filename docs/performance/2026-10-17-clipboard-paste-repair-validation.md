# 主动粘贴修复验证记录

修复方案：[主动粘贴失败修复方案](../plans/2026-10-17-clipboard-active-paste-fix-plan.md)。本记录随实现更新；未列为通过的验证不代表完成。

## R1：Windows 发布阶段证据

2026-10-17，在交互剪贴板上显式启用合成数据探针。探针只发布固定测试文字及 `ExcludeClipboardContentFromMonitorProcessing` 标记，不读取用户之前的剪贴板，不恢复旧内容，也不打开可见窗口。

```json
{"before":526,"beforeClose":529,"afterClose":532,"afterOwnerRelease":532,"oldWriterSequenceStillCurrent":false}
```

这次实测确认：**CloseClipboard 将序列从 529 推进到 532，旧 writer 返回的 529 已失效；随后 owner 销毁没有再推进该样本的序列。** 数字及增量是本次样本，不编码为平台规则。

- 私有 Window Station 验证：`CreateWindowStationW` 返回 `0x80070005 / E_ACCESSDENIED`，在任何写入前失败，没有隐式切换为交互测试。该隔离路径仍未通过。
- 显式交互探针：`HIGHLIGHTER_CLIPBOARD_TEST_INTERACTIVE=1 cargo test --locked --manifest-path native/clipboard/Cargo.toml --test publication_sequence -- --ignored --nocapture`，1/1 通过。
- 探针所在代码：`native/clipboard/tests/publication_sequence.rs`，默认 ignored；普通 `cargo test` 不接触交互剪贴板。

R2/R3 原生修复、R4 反馈及 R5 兼容性/资源验证尚未完成。此阶段不能宣称主动粘贴已经修复。
