//! `--self-test` 等启动参数解析（纯函数，无 GUI，可单测）。
//!
//! R0-03 的原型不引入 clap：参数面固定且很小，std-only 解析更容易在报告里复述语义。

/// 自检窗口停留时长默认值（毫秒）。
pub const DEFAULT_HOLD_MS: u64 = 3_000;
/// 计划要求自检 2~5 秒后自动退出；这里作为硬边界校验。
pub const MIN_HOLD_MS: u64 = 2_000;
/// 上限。
pub const MAX_HOLD_MS: u64 = 5_000;

/// 测试专用环境变量：设为 `1` 时允许把**主显示器**作为目标显示器。
///
/// 仅用于单屏主机上的自动化（WebDriver）与性能对照；生产包不应依赖，
/// 未设置时行为与安全约定完全一致（无副屏直接失败退出、不创建可见窗口）。
pub const ENV_ALLOW_PRIMARY: &str = "HIGHLIGHTER_R0_ALLOW_PRIMARY";

/// 解析 `HIGHLIGHTER_R0_ALLOW_PRIMARY` 的原始值（严格 opt-in：只接受 `1`）。
///
/// 单独拆成纯函数便于单测证明"未设置 / 其他取值一律不允许"。
pub fn parse_allow_primary(raw: Option<&str>) -> bool {
    raw.is_some_and(|value| value.trim() == "1")
}

/// 从进程环境读取测试专用开关（`HIGHLIGHTER_R0_ALLOW_PRIMARY=1`）。
pub fn allow_primary_from_env() -> bool {
    parse_allow_primary(std::env::var(ENV_ALLOW_PRIMARY).ok().as_deref())
}

/// 启动参数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    /// `--self-test`：无人值守自检模式。
    pub self_test: bool,
    /// 自检/人工模式下窗口停留毫秒数（自检 2~5 秒）。
    pub hold_ms: u64,
    /// `--monitor <index>`：指定副屏序号（原型禁止主屏）。
    pub monitor_index: Option<usize>,
    /// `--help` / `-h`：只打印用法后退出。
    pub help: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            self_test: false,
            hold_ms: DEFAULT_HOLD_MS,
            monitor_index: None,
            help: false,
        }
    }
}

/// 用法说明（stdout 打印）。
pub const USAGE: &str = "\
Highlighter R0-03 Tauri 透明窗口/截图浮层原型

用法:
  highlighter-r0-window [--self-test] [--hold-ms <2000..=5000>] [--monitor <index>]
  highlighter-r0-window --help

说明:
  默认（人工模式）: 在副屏创建并显示透明浮层窗口，画面是 Canvas 自检图案；
                    打印显示器/握手/DPR 日志；关闭窗口即退出。
  --self-test     : 列出显示器 -> 在副屏（含负坐标）铺满浮层 -> 等待页面
                    ready/init 握手与 DPR 回报 -> 打印验证行 -> 2~5 秒后自动退出。
  --hold-ms       : 自检成功后窗口停留时长，默认 3000；必须在 2000..=5000。
  --monitor       : 指定目标副屏序号（0 起，见日志）；指向主屏会被拒绝。

安全约定: 原型只允许在非主显示器上出现可见窗口；未检测到副屏时直接报错退出，
不创建也不显示任何窗口。

测试专用环境变量（生产包不应依赖）:
  HIGHLIGHTER_R0_ALLOW_PRIMARY=1
      允许把主显示器作为目标显示器（仅用于单屏主机上的自动化/性能对照）。
      --self-test 会如实打印 target_primary=true allow_primary=true；
      未设置时行为与上面的安全约定完全一致。";
/// 未检测到副屏时的进程退出码（不创建窗口）。
pub const EXIT_NO_SECONDARY: i32 = 2;
/// 自检/启动阶段硬失败。
pub const EXIT_SELF_TEST_FAILED: i32 = 3;

/// 解析参数；失败返回可直接打印的中文错误。
pub fn parse<I>(args: I) -> Result<Options, String>
where
    I: IntoIterator<Item = String>,
{
    let mut options = Options::default();
    let mut iter = args.into_iter();
    while let Some(argument) = iter.next() {
        match argument.as_str() {
            "--self-test" => options.self_test = true,
            "--hold-ms" => {
                let raw = iter.next().ok_or_else(|| {
                    format!("--hold-ms 需要一个毫秒数（{MIN_HOLD_MS}..={MAX_HOLD_MS}）")
                })?;
                let value: u64 = raw
                    .parse()
                    .map_err(|_| format!("--hold-ms 的值不是合法整数: {raw}"))?;
                if !(MIN_HOLD_MS..=MAX_HOLD_MS).contains(&value) {
                    return Err(format!(
                        "--hold-ms 必须在 {MIN_HOLD_MS}..={MAX_HOLD_MS} 之间（2~5 秒），收到 {value}"
                    ));
                }
                options.hold_ms = value;
            }
            "--monitor" => {
                let raw = iter
                    .next()
                    .ok_or_else(|| "--monitor 需要一个显示器序号（0 起）".to_string())?;
                let value: usize = raw
                    .parse()
                    .map_err(|_| format!("--monitor 的值不是合法序号: {raw}"))?;
                options.monitor_index = Some(value);
            }
            "--help" | "-h" => options.help = true,
            other => return Err(format!("未知参数: {other}")),
        }
    }
    Ok(options)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_args(args: &[&str]) -> Result<Options, String> {
        parse(args.iter().map(|value| (*value).to_string()))
    }

    #[test]
    fn defaults_are_manual_mode_with_three_second_hold() {
        let options = parse_args(&[]).expect("defaults");
        assert_eq!(options, Options::default());
        assert!(!options.self_test);
        assert_eq!(options.hold_ms, 3_000);
        assert_eq!(options.monitor_index, None);
        assert!(!options.help);
    }

    #[test]
    fn parses_self_test_and_hold_boundaries() {
        let options = parse_args(&["--self-test", "--hold-ms", "2000"]).expect("min hold");
        assert!(options.self_test);
        assert_eq!(options.hold_ms, MIN_HOLD_MS);

        let options = parse_args(&["--self-test", "--hold-ms", "5000"]).expect("max hold");
        assert_eq!(options.hold_ms, MAX_HOLD_MS);
    }

    #[test]
    fn rejects_hold_outside_two_to_five_seconds() {
        assert!(parse_args(&["--hold-ms", "1999"]).is_err());
        assert!(parse_args(&["--hold-ms", "5001"]).is_err());
        assert!(parse_args(&["--hold-ms", "abc"]).is_err());
        assert!(parse_args(&["--hold-ms"]).is_err());
    }

    #[test]
    fn parses_monitor_index_and_help() {
        let options = parse_args(&["--monitor", "1"]).expect("monitor");
        assert_eq!(options.monitor_index, Some(1));
        assert!(parse_args(&["--monitor", "-1"]).is_err());
        assert!(parse_args(&["--monitor"]).is_err());

        assert!(parse_args(&["--help"]).expect("help").help);
        assert!(parse_args(&["-h"]).expect("help short").help);
    }

    #[test]
    fn allow_primary_env_switch_is_strict_opt_in() {
        assert!(!parse_allow_primary(None), "unset env must keep default");
        assert!(parse_allow_primary(Some("1")));
        assert!(
            parse_allow_primary(Some(" 1 ")),
            "surrounding whitespace tolerated"
        );
        for value in ["0", "true", "yes", "01", "", "2", "on"] {
            assert!(
                !parse_allow_primary(Some(value)),
                "value {value:?} must not enable the test switch"
            );
        }
    }

    #[test]
    fn rejects_unknown_arguments() {
        let error = parse_args(&["--self-test", "--watch"]).expect_err("unknown flag");
        assert!(error.contains("--watch"), "unexpected message: {error}");
    }
}
