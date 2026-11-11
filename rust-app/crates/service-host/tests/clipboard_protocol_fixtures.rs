//! 跨语言夹具对照：`test/fixtures/host-parity/clipboard-protocol/`（不允许 skip）。
//!
//! 夹具由 `scripts/rust/generate-host-fixtures.js` 按
//! `docs/plans/rust-migration/contract-format.md` §4/§4.3 生成。有效用例要求逐帧 header
//! 与 payload 字节相等；无效用例用 `failAt=feed|finish` + `expectedError=invalid-frame`
//! 表达期望，Rust 必须在同一阶段失败且错误码一致。
//!
//! 失败信息带 case id 与字段名，便于定位是夹具还是解码器的问题。

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use highlighter_service_host::clipboard_protocol::{FrameDecoder, InvalidFrame};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

const GROUP_ID: &str = "clipboard-protocol";
const FORMAT: &str = "clipboard-protocol.v1";

fn parity_root() -> PathBuf {
    highlighter_contracts::repo_root()
        .join("test")
        .join("fixtures")
        .join("host-parity")
}

fn group_dir() -> PathBuf {
    parity_root().join(GROUP_ID)
}

fn load_json<T: DeserializeOwned>(path: &Path) -> T {
    let bytes = fs::read(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_slice(&bytes)
        .unwrap_or_else(|error| panic!("parse {} as UTF-8 JSON: {error}", path.display()))
}

/// 单个 case 文件（contract-format.md §4 外壳 + §4.3 的 clipboard-protocol 附加字段）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    schema_version: u32,
    case_id: String,
    format: String,
    source: Vec<String>,
    /// `valid` | `invalid`（外壳字段）。
    expect: String,
    /// §4.3 的 `kind`；必须与 `expect` 一致。
    kind: String,
    /// 按顺序喂给 decoder 的 base64 原始字节。
    chunks: Vec<String>,
    /// 有效用例的期望帧。
    #[serde(default)]
    expected_frames: Vec<ExpectedFrame>,
    /// 无效用例的机器码（`invalid-frame`）。
    #[serde(default)]
    expected_error: Option<String>,
    /// 无效用例要求失败的阶段：`feed` | `finish`。
    #[serde(default)]
    fail_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedFrame {
    header: Value,
    #[serde(default)]
    payload_base64: String,
}

fn decode_chunks(case: &Case) -> Vec<Vec<u8>> {
    case.chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| {
            STANDARD.decode(chunk).unwrap_or_else(|error| {
                panic!(
                    "{}: chunk {index} is not standard base64: {error}",
                    case.case_id
                )
            })
        })
        .collect()
}

fn check_valid_case(case: &Case, chunks: &[Vec<u8>]) {
    let mut decoder = FrameDecoder::new();
    let mut frames = Vec::new();
    for (index, chunk) in chunks.iter().enumerate() {
        let produced = decoder.feed(chunk).unwrap_or_else(|error| {
            panic!(
                "{}: valid case failed on chunk {index} ({} bytes): {error}",
                case.case_id,
                chunk.len()
            )
        });
        frames.extend(produced);
    }
    decoder
        .finish()
        .unwrap_or_else(|error| panic!("{}: finish after valid case: {error}", case.case_id));

    assert_eq!(
        frames.len(),
        case.expected_frames.len(),
        "{}: decoded frame count",
        case.case_id
    );
    for (index, (frame, expected)) in frames.iter().zip(&case.expected_frames).enumerate() {
        assert_eq!(
            frame.header, expected.header,
            "{}: frame {index} header",
            case.case_id
        );
        let expected_payload = STANDARD
            .decode(&expected.payload_base64)
            .unwrap_or_else(|error| {
                panic!(
                    "{}: frame {index} payloadBase64 is not base64: {error}",
                    case.case_id
                )
            });
        assert_eq!(
            frame.payload, expected_payload,
            "{}: frame {index} payload bytes",
            case.case_id
        );
    }
    assert!(
        case.expected_error.is_none(),
        "{}: valid case must not declare expectedError",
        case.case_id
    );
    assert!(
        case.fail_at.is_none(),
        "{}: valid case must not declare failAt",
        case.case_id
    );
}

fn check_invalid_case(case: &Case, chunks: &[Vec<u8>]) {
    // 所有非法帧共用同一错误语义（JS 的 invalid()）。
    assert_eq!(
        case.expected_error.as_deref(),
        Some(InvalidFrame::CODE),
        "{}: expectedError must be `{}`",
        case.case_id,
        InvalidFrame::CODE
    );

    let fail_at = case.fail_at.as_deref().unwrap_or_else(|| {
        panic!(
            "{}: invalid case must declare failAt=feed|finish (contract-format.md §4.3)",
            case.case_id
        )
    });

    match fail_at {
        "feed" => {
            let mut decoder = FrameDecoder::new();
            let mut failed_at = None;
            for (index, chunk) in chunks.iter().enumerate() {
                if let Err(error) = decoder.feed(chunk) {
                    failed_at = Some((index, error));
                    break;
                }
            }
            let (index, error) = failed_at.unwrap_or_else(|| {
                panic!(
                    "{}: expected a feed error, but every chunk decoded cleanly",
                    case.case_id
                )
            });
            assert_eq!(
                error.code(),
                InvalidFrame::CODE,
                "{}: feed error",
                case.case_id
            );
            assert!(
                decoder.is_failed(),
                "{}: decoder must be failed after a feed error (chunk {index})",
                case.case_id
            );
            assert!(
                decoder.feed(&[]).is_err(),
                "{}: failed decoder must stay failed (JS `failed` flag is permanent)",
                case.case_id
            );
            assert_eq!(
                decoder.finish(),
                Err(InvalidFrame),
                "{}: failed decoder must reject finish",
                case.case_id
            );
        }
        "finish" => {
            let mut decoder = FrameDecoder::new();
            for (index, chunk) in chunks.iter().enumerate() {
                decoder.feed(chunk).unwrap_or_else(|error| {
                    panic!(
                        "{}: failAt=finish but chunk {index} already failed at feed: {error}",
                        case.case_id
                    )
                });
            }
            assert_eq!(
                decoder.finish(),
                Err(InvalidFrame),
                "{}: expected finish() to reject the truncated/non-boundary stream",
                case.case_id
            );
        }
        other => panic!(
            "{}: unsupported failAt `{other}` (expected feed|finish)",
            case.case_id
        ),
    }
}

#[test]
fn clipboard_protocol_cases_match_the_rust_decoder() {
    let dir = group_dir();
    assert!(
        dir.is_dir(),
        "clipboard-protocol fixtures missing at {} (run scripts/rust/generate-host-fixtures.js --write)",
        dir.display()
    );

    let mut paths: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("read {}: {error}", dir.display()))
        .map(|entry| {
            entry
                .unwrap_or_else(|error| panic!("read entry of {}: {error}", dir.display()))
                .path()
        })
        .filter(|path| path.extension() == Some(OsStr::new("json")))
        .collect();
    assert!(
        !paths.is_empty(),
        "{} exists but contains no *.json fixture cases",
        dir.display()
    );
    paths.sort();

    let mut seen_ids = BTreeSet::new();
    let mut valid_cases = 0usize;
    let mut invalid_cases = 0usize;
    for path in &paths {
        let case: Case = load_json(path);
        assert_eq!(case.schema_version, 1, "{}: schemaVersion", case.case_id);
        assert_eq!(case.format, FORMAT, "{}: format", case.case_id);
        assert!(
            case.case_id.starts_with(&format!("{GROUP_ID}/")),
            "{}: caseId must be prefixed with `{GROUP_ID}/`",
            case.case_id
        );
        assert!(
            seen_ids.insert(case.case_id.clone()),
            "{}: duplicate caseId",
            case.case_id
        );
        assert!(
            case.source
                .iter()
                .any(|source| source == "shared/clipboard-protocol.js"),
            "{}: source must include shared/clipboard-protocol.js",
            case.case_id
        );
        assert!(
            matches!(case.expect.as_str(), "valid" | "invalid"),
            "{}: expect must be valid|invalid, got {}",
            case.case_id,
            case.expect
        );
        assert_eq!(
            case.kind, case.expect,
            "{}: kind and expect disagree",
            case.case_id
        );

        let chunks = decode_chunks(&case);
        if case.expect == "valid" {
            valid_cases += 1;
            check_valid_case(&case, &chunks);
        } else {
            invalid_cases += 1;
            check_invalid_case(&case, &chunks);
        }
    }

    assert!(valid_cases > 0, "fixtures must contain valid cases");
    assert!(invalid_cases > 0, "fixtures must contain invalid cases");
    eprintln!(
        "clipboard-protocol: {valid_cases} valid + {invalid_cases} invalid fixture cases matched \
         the Rust decoder"
    );
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureManifest {
    schema_version: u32,
    generator: String,
    #[serde(default)]
    groups: Vec<ManifestGroup>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestGroup {
    id: String,
    format: String,
    #[serde(default)]
    generated_from: Vec<String>,
    #[serde(default)]
    cases: Vec<ManifestCase>,
}

#[derive(Debug, Deserialize)]
struct ManifestCase {
    id: String,
    file: String,
    #[serde(default)]
    sha256: String,
}

#[test]
fn fixtures_manifest_lists_the_clipboard_protocol_group() {
    let manifest_path = parity_root().join("manifest.json");
    assert!(
        manifest_path.is_file(),
        "fixture manifest missing at {} (run scripts/rust/generate-host-fixtures.js --write)",
        manifest_path.display()
    );

    let manifest: FixtureManifest = load_json(&manifest_path);
    assert_eq!(manifest.schema_version, 1, "manifest schemaVersion");
    assert!(
        !manifest.generator.is_empty(),
        "manifest generator must be recorded"
    );

    let group = manifest
        .groups
        .iter()
        .find(|group| group.id == GROUP_ID)
        .unwrap_or_else(|| {
            panic!(
                "manifest has no `{GROUP_ID}` group; groups = {:?}",
                manifest
                    .groups
                    .iter()
                    .map(|group| &group.id)
                    .collect::<Vec<_>>()
            )
        });
    assert_eq!(group.format, FORMAT, "group format");
    assert!(
        group
            .generated_from
            .iter()
            .any(|source| source == "shared/clipboard-protocol.js"),
        "group generatedFrom must include shared/clipboard-protocol.js"
    );
    assert!(!group.cases.is_empty(), "group has no cases");

    let mut listed = BTreeSet::new();
    for case in &group.cases {
        assert!(
            case.file.starts_with(&format!("{GROUP_ID}/")),
            "{}: case file `{}` must live under `{GROUP_ID}/`",
            case.id,
            case.file
        );
        assert!(
            case.sha256.len() == 64 && case.sha256.chars().all(|c| c.is_ascii_hexdigit()),
            "{}: sha256 must be 64 hex chars",
            case.id
        );
        assert!(
            listed.insert(case.file.clone()),
            "{}: duplicate case file",
            case.id
        );
        let path = parity_root().join(&case.file);
        assert!(
            path.is_file(),
            "{}: manifest references missing fixture {}",
            case.id,
            path.display()
        );
    }

    let on_disk: BTreeSet<String> = fs::read_dir(group_dir())
        .unwrap_or_else(|error| panic!("read {}: {error}", group_dir().display()))
        .map(|entry| {
            entry
                .unwrap_or_else(|error| panic!("read entry: {error}"))
                .path()
        })
        .filter(|path| path.extension() == Some(OsStr::new("json")))
        .map(|path| {
            let name = path
                .file_name()
                .unwrap_or_else(|| panic!("fixture without file name: {}", path.display()));
            format!("{GROUP_ID}/{}", name.to_string_lossy())
        })
        .collect();

    assert_eq!(
        on_disk, listed,
        "manifest and on-disk fixture files disagree (both directions must match)"
    );
}
