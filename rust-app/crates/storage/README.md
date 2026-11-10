# highlighter-storage（R0）

存储原语的 R0 子集。计划 R2 才会接入真实的设置/凭据/数据根迁移与 SQLite；本 crate 在 R0
只交付两块可独立验证的纯逻辑：

## R0 交付

- `atomic_json`：同目录临时文件 + 写入 + `flush/fsync` + 原子 `rename` 覆盖目标。
  - 失败**不覆盖**旧文件；临时文件由 guard 清理，不残留。
  - 先关闭句柄再 rename（Windows 语义）；目标为只读/被占用/目录时返回错误而不是部分写。
  - `write_json_atomic` 固定 UTF-8、2 空格缩进、末尾单个换行，便于双端比较与人工 diff。
  - `read_json_with_limit` 在解析前按字节上限拒绝（设置/项目描述类小文件，默认 8 MiB）。
- `data_root`：开发/灰度**隔离**数据根 locator（计划 D07/R0）。
  - 固定渠道身份：`HighlighterRustDev` / `HighlighterRustGray`，locator 文件名
    `Highlighter.rust-<channel>.location.json`；**绝不写**现有 Electron 的
    `Highlighter.location.json`（代码显式拒绝该文件名）。
  - root 校验：必须绝对、无 `.`/`..`、不能是盘符根；新旧 root 不能相同或互为父子
    （拒绝嵌套覆盖，Windows 路径按 ASCII 大小写不敏感比较）。
  - locator `schemaVersion` 只接受当前版本；未知新版本拒绝写入/读取失败。
  - `generation` 单调递增：旧 locator 不能覆盖新 locator。
  - 所有函数显式接收 base 目录（例如 `%LOCALAPPDATA%`），**不读环境变量**，测试只在
    系统临时目录里建删除得掉的临时根，绝不触碰真实用户数据根。

## 明确不做

- 不解析/迁移真实数据根（R2-02）、不碰 WAL/SQLite、不做设置 normalize、不读写凭据。
- 不做跨磁盘/跨卷 rename（同目录 rename 是 R0 唯一承诺；跨卷返回 I/O 错误）。
- 不实现目录 fsync：std 在 Windows 上无法打开目录句柄；NTFS `MoveFileEx` 的元数据
  更新由文件系统日志保证。崩溃一致性证据在 R2/R8 用故障注入补齐。

## 后续批次

R2-01/R2-02 在本 crate 增加设置 normalize、真实数据根迁移 marker v1/v2/v3、停写协调；
SQLite 仓储在 R2/R4/R5 按对象加入。
