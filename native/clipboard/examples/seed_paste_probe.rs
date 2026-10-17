//! Synthetic fixtures only, in a new explicitly named OS temporary directory.
use highlighter_clipboard::storage::{Filter, Store};
fn main() {
    let root = std::path::PathBuf::from(std::env::args().nth(1).expect("temporary root"));
    let resolved = root.canonicalize().unwrap();
    assert!(resolved.starts_with(std::env::temp_dir().canonicalize().unwrap()));
    assert!(resolved
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("highlighter-paste-probe-"));
    assert!(std::fs::read_dir(&resolved).unwrap().next().is_none());
    let mut store = Store::open(&root).unwrap();
    for text in [
        "Highlighter paste probe 中文 🙂",
        "https://example.com/highlighter-paste-probe?q=123",
        "  Highlighter whitespace 中文\r\nline 2 🙂  ",
        &format!("Highlighter long probe {}", "abc中文🙂 ".repeat(8192)),
    ] {
        store
            .accept("text", text.as_bytes().to_vec(), "synthetic.exe")
            .unwrap();
    }
    println!("{}", store.list(Filter::default()).unwrap());
    store.checkpoint().unwrap();
}
