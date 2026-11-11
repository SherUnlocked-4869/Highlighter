//! 启动参数解析（std-only；原型参数面固定且很小，不引入 clap）。

use std::path::PathBuf;

/// 原型的验证链路。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// A. WebView2 PrintToPdfStream vs Electron printToPDF（合成文档样例矩阵）。
    Pdf,
    /// A2. 产品真实 `capture/print.html` 的图片贴页用例（与 Electron 共用 manifest）。
    PdfProduct,
    /// B. command 二进制响应 vs 自定义 URI scheme 资源通道。
    Resource,
}

/// 启动参数。
#[derive(Debug, Clone)]
pub struct Options {
    pub mode: Mode,
    pub hold_ms: u64,
    pub out_dir: Option<PathBuf>,
    /// `--pdf-product` 的用例 manifest（默认 `.tmp-r0-pdf/product/product-cases.json`）。
    pub cases_file: Option<PathBuf>,
    pub help: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            mode: Mode::Pdf,
            hold_ms: 0,
            out_dir: None,
            cases_file: None,
            help: false,
        }
    }
}

pub const USAGE: &str = "\
Highlighter R0-06：WebView2 PDF 打印 + 二进制资源通道原型（Windows/Tauri 2）

用法:
  highlighter-r0-pdf-resource --pdf [--hold-ms <ms>] [--out-dir <dir>]
  highlighter-r0-pdf-resource --pdf-product [--cases-file <json>] [--hold-ms <ms>] [--out-dir <dir>]
  highlighter-r0-pdf-resource --resource [--hold-ms <ms>] [--out-dir <dir>]
  highlighter-r0-pdf-resource --help

说明:
  --pdf          隐藏窗口加载合成的打印样例，用 WebView2 PrintToPdfStream（及旧 API PrintToPdf）
                 打印 PDF 清单到 .tmp-r0-pdf/，写 webview2-print-report.json 后退出。
  --pdf-product  隐藏窗口加载**产品真实** capture/print.html（内置只读 HTTP 服务提供真实文件与
                 shared/tokens.css），按 manifest（scripts/rust/pdf-product-cases.js 调用产品
                 main/services/pdf-export.js 生成）执行产品 DOM 注入脚本与产品纸张参数，
                 产物/报告写 .tmp-r0-pdf/product/；与 Electron 探针
                 scripts/rust/probe-electron-product-pdf.js 共用同一 manifest。
  --resource     在副屏创建 media-a / media-b 两个窗口，跑图片/视频 Range/鉴权/CSP/20MiB 传输对照，
                 写 .tmp-r0-resource/resource-report.json 后退出。
  --hold-ms      结果写出后、退出前的停留毫秒数（人工观察窗口用，默认 0）。
  --out-dir      覆盖默认产物目录。
  --cases-file   覆盖 --pdf-product 的用例 manifest 路径。

可见窗口只放副屏：未检测到非主显示器时 --resource 直接报错退出（退出码 2），不创建窗口。
PDF 打印窗口全部隐藏。";

/// 解析参数；失败返回可直接打印的中文错误。
pub fn parse<I>(args: I) -> Result<Options, String>
where
    I: IntoIterator<Item = String>,
{
    let mut options = Options::default();
    let mut mode_seen: Option<Mode> = None;
    let mut iter = args.into_iter();
    while let Some(argument) = iter.next() {
        match argument.as_str() {
            "--pdf" => {
                if mode_seen.replace(Mode::Pdf).is_some() {
                    return Err("--pdf/--pdf-product/--resource 只能三选一".into());
                }
                options.mode = Mode::Pdf;
            }
            "--pdf-product" => {
                if mode_seen.replace(Mode::PdfProduct).is_some() {
                    return Err("--pdf/--pdf-product/--resource 只能三选一".into());
                }
                options.mode = Mode::PdfProduct;
            }
            "--resource" => {
                if mode_seen.replace(Mode::Resource).is_some() {
                    return Err("--pdf/--pdf-product/--resource 只能三选一".into());
                }
                options.mode = Mode::Resource;
            }
            "--hold-ms" => {
                let raw = iter
                    .next()
                    .ok_or_else(|| "--hold-ms 需要一个毫秒数".to_string())?;
                let value: u64 = raw
                    .parse()
                    .map_err(|_| format!("--hold-ms 的值不是合法整数: {raw}"))?;
                if value > 60_000 {
                    return Err(format!("--hold-ms 超过上限 60000: {value}"));
                }
                options.hold_ms = value;
            }
            "--out-dir" => {
                let raw = iter
                    .next()
                    .ok_or_else(|| "--out-dir 需要一个目录".to_string())?;
                options.out_dir = Some(PathBuf::from(raw));
            }
            "--cases-file" => {
                let raw = iter
                    .next()
                    .ok_or_else(|| "--cases-file 需要一个 JSON 路径".to_string())?;
                options.cases_file = Some(PathBuf::from(raw));
            }
            "--help" | "-h" => options.help = true,
            other => return Err(format!("未知参数: {other}")),
        }
    }
    Ok(options)
}

/// 参数解析的单测（不启动 GUI）。
#[cfg(test)]
mod tests {
    use super::*;

    fn parse_args(args: &[&str]) -> Result<Options, String> {
        parse(args.iter().map(|value| value.to_string()))
    }

    #[test]
    fn defaults_to_pdf_mode() {
        let options = parse_args(&[]).expect("空参数应成功");
        assert_eq!(options.mode, Mode::Pdf);
        assert_eq!(options.hold_ms, 0);
        assert!(options.cases_file.is_none());
        assert!(!options.help);
    }

    #[test]
    fn selects_resource_mode_and_hold() {
        let options = parse_args(&["--resource", "--hold-ms", "1500"]).expect("参数应成功");
        assert_eq!(options.mode, Mode::Resource);
        assert_eq!(options.hold_ms, 1500);
    }

    #[test]
    fn selects_product_pdf_mode_with_cases_file() {
        let options = parse_args(&[
            "--pdf-product",
            "--cases-file",
            ".tmp-r0-pdf/product/cases.json",
        ])
        .expect("参数应成功");
        assert_eq!(options.mode, Mode::PdfProduct);
        assert_eq!(
            options.cases_file.as_deref(),
            Some(std::path::Path::new(".tmp-r0-pdf/product/cases.json"))
        );
    }

    #[test]
    fn rejects_three_modes() {
        let error = parse_args(&["--pdf", "--pdf-product"]).expect_err("互斥参数应失败");
        assert!(error.contains("三选一"), "错误应说明互斥: {error}");
        let error = parse_args(&["--pdf", "--resource"]).expect_err("互斥参数应失败");
        assert!(error.contains("三选一"), "错误应说明互斥: {error}");
    }

    #[test]
    fn rejects_unknown_argument() {
        let error = parse_args(&["--nope"]).expect_err("未知参数应失败");
        assert!(error.contains("未知参数"), "错误应指出未知参数: {error}");
    }

    #[test]
    fn rejects_bad_hold() {
        let error = parse_args(&["--hold-ms", "abc"]).expect_err("非法数字应失败");
        assert!(
            error.contains("不是合法整数"),
            "错误应指出数字非法: {error}"
        );
    }
}
