//! Database-only cases. Never open or change the Windows clipboard.
use highlighter_clipboard::storage::Store;
use serde_json::json;
use uuid::Uuid;

#[test]
fn paste_receipts_do_not_replay_or_alias_copy_operations() {
    let root = std::env::temp_dir().join(format!("highlighter-paste-receipts-{}", Uuid::new_v4()));
    let store = Store::open(&root).unwrap();
    let item = Uuid::new_v4().to_string();
    let operation = Uuid::new_v4().to_string();
    assert_eq!(store.begin_paste(&item, &operation).unwrap(), None);
    assert_eq!(
        store.begin_paste(&item, &operation).unwrap_err(),
        "PASTE_OUTCOME_UNKNOWN"
    );
    assert_eq!(
        store.begin_copy(&item, &operation).unwrap_err(),
        "OPERATION_CONFLICT"
    );
    let result = json!({"copied":true,"outcome":"injected"});
    store.finish_paste(&item, &operation, &result).unwrap();
    assert_eq!(store.begin_paste(&item, &operation).unwrap(), Some(result));
    let other = Uuid::new_v4().to_string();
    assert_eq!(
        store.begin_paste(&other, &operation).unwrap_err(),
        "OPERATION_CONFLICT"
    );
    drop(store);
    // Simulated restart must retain pending/complete receipts as well.
    let store = Store::open(&root).unwrap();
    assert_eq!(
        store.begin_paste(&item, &operation).unwrap().unwrap()["outcome"],
        "injected"
    );
    let pending = Uuid::new_v4().to_string();
    store.begin_paste(&item, &pending).unwrap();
    drop(store);
    let store = Store::open(&root).unwrap();
    assert_eq!(
        store.begin_paste(&item, &pending).unwrap_err(),
        "PASTE_OUTCOME_UNKNOWN"
    );
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
