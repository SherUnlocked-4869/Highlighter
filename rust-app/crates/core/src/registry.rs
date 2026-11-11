//! 操作注册表原型（计划 §4.2）。
//!
//! 目标不变量：
//!
//! - 一次长任务在注册表里关联：窗口实例、generation、取消信号、清理函数。
//! - 旧 generation 的**完成/取消**必须失效，不能把旧实例的结果回流到新实例。
//! - 清理函数在完成、取消、代际失效、关窗、注册表销毁时**最多执行一次**。
//! - 关闭窗口只释放它拥有的操作，不影响其它窗口。
//!
//! R0 只有单一 generation 维度，语义等同 `HostContext.generation`。R1 装配宿主时再把
//! 窗口实例代际与数据根 generation 绑定（计划 §4.2 任务寿命说明），本原型的错误语义
//! 保持不变。

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use highlighter_contracts::{HostContext, OperationRef};

/// 可克隆的取消信号。注册表 cancel/代际失效/Drop 都会把它置位；
/// 工作线程/异步任务只需持有 clone 并周期性检查。
#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    /// 新建未取消的信号。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 置位取消信号（幂等）。
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    /// 是否已取消。
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// 注册成功后的句柄：操作引用 + 取消信号。
#[derive(Debug)]
pub struct RegisteredOperation {
    reference: OperationRef,
    cancellation: CancellationToken,
}

impl RegisteredOperation {
    /// 交给调用方/回执的稳定引用（operationId + generation）。
    #[must_use]
    pub fn reference(&self) -> &OperationRef {
        &self.reference
    }

    /// 取消信号的 clone。
    #[must_use]
    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }
}

/// 代际失效结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Invalidation {
    /// 该窗口的新 generation。
    pub generation: u64,
    /// 被取消并清理的旧操作数量。
    pub cancelled: usize,
}

/// 注册表错误。所有错误都显式区分"重复/过期/未知/不匹配"，不合并成通用失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryError {
    /// operationId 为空。
    InvalidOperationId,
    /// 同一窗口实例上 operationId 重复。
    DuplicateOperation {
        /// 重复的 operationId。
        operation_id: String,
    },
    /// 注册上下文比该窗口已知 generation 更旧。
    StaleGeneration {
        /// 窗口实例。
        window_instance_id: String,
        /// 注册表已知 generation。
        current: u64,
        /// 请求注册的 generation。
        requested: u64,
    },
    /// 操作不存在（已成功完成/取消，或从未注册）。
    UnknownOperation {
        /// 操作 ID。
        operation_id: String,
    },
    /// 引用的 generation 与注册时不一致。
    StaleOperation {
        /// 操作 ID。
        operation_id: String,
        /// 注册时的 generation。
        registered: u64,
        /// 引用里的 generation。
        requested: u64,
    },
    /// 调用上下文的 generation 与已注册操作不一致（例如用新实例完成旧操作）。
    ContextGenerationMismatch {
        /// 操作 ID。
        operation_id: String,
        /// 注册时的 generation。
        registered: u64,
        /// 上下文里的 generation。
        provided: u64,
    },
}

impl fmt::Display for RegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RegistryError::InvalidOperationId => formatter.write_str("operation id must not be empty"),
            RegistryError::DuplicateOperation { operation_id } => {
                write!(formatter, "operation `{operation_id}` is already registered")
            }
            RegistryError::StaleGeneration {
                window_instance_id,
                current,
                requested,
            } => write!(
                formatter,
                "stale generation {requested} for window `{window_instance_id}` (current generation is {current})"
            ),
            RegistryError::UnknownOperation { operation_id } => {
                write!(formatter, "operation `{operation_id}` is not active")
            }
            RegistryError::StaleOperation {
                operation_id,
                registered,
                requested,
            } => write!(
                formatter,
                "operation `{operation_id}` is registered at generation {registered}, not {requested}"
            ),
            RegistryError::ContextGenerationMismatch {
                operation_id,
                registered,
                provided,
            } => write!(
                formatter,
                "context generation {provided} does not match operation `{operation_id}` generation {registered}"
            ),
        }
    }
}

impl std::error::Error for RegistryError {}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct OperationKey {
    window_instance_id: String,
    operation_id: String,
}

struct Operation {
    generation: u64,
    kind: String,
    cancellation: CancellationToken,
    cleanup: Option<Box<dyn FnOnce() + Send>>,
}

impl Operation {
    fn finish(self) {
        self.cancellation.cancel();
        if let Some(cleanup) = self.cleanup {
            cleanup();
        }
    }
}

enum FinishMode {
    Complete,
    Cancel,
}

/// 长任务注册表（R0 原型）。
#[derive(Default)]
pub struct OperationRegistry {
    operations: HashMap<OperationKey, Operation>,
    /// 每个窗口实例已知的最大 generation。窗口关闭后移除。
    generations: HashMap<String, u64>,
}

impl OperationRegistry {
    /// 新建空注册表。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册一次长任务；`cleanup` 在完成/取消/代际失效时执行，最多一次。
    pub fn register(
        &mut self,
        context: &HostContext,
        operation_id: &str,
        kind: &str,
        cleanup: impl FnOnce() + Send + 'static,
    ) -> Result<RegisteredOperation, RegistryError> {
        if operation_id.is_empty() {
            return Err(RegistryError::InvalidOperationId);
        }
        let key = OperationKey {
            window_instance_id: context.window_instance_id.clone(),
            operation_id: operation_id.to_owned(),
        };
        if self.operations.contains_key(&key) {
            return Err(RegistryError::DuplicateOperation {
                operation_id: operation_id.to_owned(),
            });
        }
        let current = self
            .generations
            .get(&context.window_instance_id)
            .copied()
            .unwrap_or(0);
        if context.generation < current {
            return Err(RegistryError::StaleGeneration {
                window_instance_id: context.window_instance_id.clone(),
                current,
                requested: context.generation,
            });
        }
        self.generations
            .insert(context.window_instance_id.clone(), context.generation);

        let cancellation = CancellationToken::new();
        self.operations.insert(
            key,
            Operation {
                generation: context.generation,
                kind: kind.to_owned(),
                cancellation: cancellation.clone(),
                cleanup: Some(Box::new(cleanup)),
            },
        );
        Ok(RegisteredOperation {
            reference: OperationRef {
                operation_id: operation_id.to_owned(),
                generation: context.generation,
            },
            cancellation,
        })
    }

    /// 正常完成：校验引用与上下文，然后移除并执行清理。
    pub fn complete(
        &mut self,
        context: &HostContext,
        reference: &OperationRef,
    ) -> Result<(), RegistryError> {
        self.finish(context, reference, FinishMode::Complete)
    }

    /// 取消：校验引用与上下文，置位取消信号并执行清理。
    pub fn cancel(
        &mut self,
        context: &HostContext,
        reference: &OperationRef,
    ) -> Result<(), RegistryError> {
        self.finish(context, reference, FinishMode::Cancel)
    }

    fn finish(
        &mut self,
        context: &HostContext,
        reference: &OperationRef,
        mode: FinishMode,
    ) -> Result<(), RegistryError> {
        if reference.operation_id.is_empty() {
            return Err(RegistryError::InvalidOperationId);
        }
        let key = OperationKey {
            window_instance_id: context.window_instance_id.clone(),
            operation_id: reference.operation_id.clone(),
        };

        // 先做全部校验；失败时不得改动注册表状态（旧操作保留给合法的完成/取消）。
        let registered = match self.operations.get(&key) {
            Some(operation) => operation.generation,
            None => {
                return Err(RegistryError::UnknownOperation {
                    operation_id: reference.operation_id.clone(),
                })
            }
        };
        if reference.generation != registered {
            return Err(RegistryError::StaleOperation {
                operation_id: reference.operation_id.clone(),
                registered,
                requested: reference.generation,
            });
        }
        let current = self
            .generations
            .get(&context.window_instance_id)
            .copied()
            .unwrap_or(registered);
        if context.generation < current {
            return Err(RegistryError::StaleGeneration {
                window_instance_id: context.window_instance_id.clone(),
                current,
                requested: context.generation,
            });
        }
        if context.generation != registered {
            return Err(RegistryError::ContextGenerationMismatch {
                operation_id: reference.operation_id.clone(),
                registered,
                provided: context.generation,
            });
        }

        let Some(mut operation) = self.operations.remove(&key) else {
            return Err(RegistryError::UnknownOperation {
                operation_id: reference.operation_id.clone(),
            });
        };
        match mode {
            FinishMode::Cancel => operation.finish(),
            FinishMode::Complete => {
                // 完成不置位取消信号；只执行清理（释放资源/订阅）。
                if let Some(cleanup) = operation.cleanup.take() {
                    cleanup();
                }
            }
        }
        Ok(())
    }

    /// 使窗口实例进入新 generation：取消并清理该窗口全部旧操作。
    ///
    /// generation 单调 +1；`u64::MAX` 时饱和（不 panic，也不回绕）。
    pub fn invalidate_generation(&mut self, window_instance_id: &str) -> Invalidation {
        let generation = self
            .generations
            .get(window_instance_id)
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
        self.generations
            .insert(window_instance_id.to_owned(), generation);
        let cancelled = self.release_window_operations(window_instance_id);
        Invalidation {
            generation,
            cancelled,
        }
    }

    /// 关闭窗口：取消/清理它拥有的操作，并丢弃 generation 记录。
    ///
    /// 只释放该窗口的 UI 订阅和引用；持久项目/导出任务不在本注册表（计划 §4.2）。
    pub fn close_window(&mut self, window_instance_id: &str) -> usize {
        let cancelled = self.release_window_operations(window_instance_id);
        self.generations.remove(window_instance_id);
        cancelled
    }

    /// 该窗口当前 active 的操作（operationId, kind），按 operationId 排序，便于诊断。
    #[must_use]
    pub fn active_operations(&self, window_instance_id: &str) -> Vec<(&str, &str)> {
        let mut entries: Vec<(&str, &str)> = self
            .operations
            .iter()
            .filter(|(key, _)| key.window_instance_id == window_instance_id)
            .map(|(key, operation)| (key.operation_id.as_str(), operation.kind.as_str()))
            .collect();
        entries.sort_unstable();
        entries
    }

    /// 该窗口已知的 generation（未注册过任何操作为 `None`）。
    #[must_use]
    pub fn known_generation(&self, window_instance_id: &str) -> Option<u64> {
        self.generations.get(window_instance_id).copied()
    }

    fn release_window_operations(&mut self, window_instance_id: &str) -> usize {
        let keys: Vec<OperationKey> = self
            .operations
            .keys()
            .filter(|key| key.window_instance_id == window_instance_id)
            .cloned()
            .collect();
        let mut cancelled = 0;
        for key in keys {
            if let Some(operation) = self.operations.remove(&key) {
                operation.finish();
                cancelled += 1;
            }
        }
        cancelled
    }
}

impl Drop for OperationRegistry {
    fn drop(&mut self) {
        // 进程退出/宿主销毁时不允许悄悄遗留未清理的操作。
        let keys: Vec<OperationKey> = self.operations.keys().cloned().collect();
        for key in keys {
            if let Some(operation) = self.operations.remove(&key) {
                operation.finish();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use highlighter_contracts::WindowRole;
    use std::sync::atomic::AtomicUsize;

    fn context(window: &str, generation: u64) -> HostContext {
        HostContext::new(window, WindowRole::Main, generation)
    }

    fn cleanup_counter() -> Arc<AtomicUsize> {
        Arc::new(AtomicUsize::new(0))
    }

    fn counting_cleanup(counter: &Arc<AtomicUsize>) -> impl FnOnce() + Send + 'static {
        let counter = Arc::clone(counter);
        move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn register_then_complete_runs_cleanup_exactly_once() {
        let mut registry = OperationRegistry::new();
        let counter = cleanup_counter();
        let registered = registry
            .register(
                &context("window-1", 1),
                "op-1",
                "capture",
                counting_cleanup(&counter),
            )
            .expect("register");

        assert_eq!(registered.reference().operation_id, "op-1");
        assert_eq!(registered.reference().generation, 1);
        assert_eq!(
            registry.active_operations("window-1"),
            [("op-1", "capture")]
        );
        assert_eq!(counter.load(Ordering::SeqCst), 0);

        registry
            .complete(&context("window-1", 1), registered.reference())
            .expect("complete");
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        assert!(registry.active_operations("window-1").is_empty());

        assert_eq!(
            registry.complete(&context("window-1", 1), registered.reference()),
            Err(RegistryError::UnknownOperation {
                operation_id: "op-1".to_owned()
            })
        );
        assert_eq!(
            counter.load(Ordering::SeqCst),
            1,
            "cleanup must never run twice"
        );
    }

    #[test]
    fn cancel_marks_the_token_and_runs_cleanup_once() {
        let mut registry = OperationRegistry::new();
        let counter = cleanup_counter();
        let registered = registry
            .register(
                &context("window-1", 1),
                "op-1",
                "export",
                counting_cleanup(&counter),
            )
            .expect("register");
        let token = registered.cancellation();
        assert!(!token.is_cancelled());

        registry
            .cancel(&context("window-1", 1), registered.reference())
            .expect("cancel");

        assert!(token.is_cancelled(), "cancel must set the shared token");
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        assert_eq!(
            registry.cancel(&context("window-1", 1), registered.reference()),
            Err(RegistryError::UnknownOperation {
                operation_id: "op-1".to_owned()
            })
        );
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn duplicate_and_empty_operation_ids_are_rejected() {
        let mut registry = OperationRegistry::new();
        let counter = cleanup_counter();
        let first = registry
            .register(
                &context("window-1", 1),
                "op-1",
                "capture",
                counting_cleanup(&counter),
            )
            .expect("register");

        let rejected_counter = cleanup_counter();
        let error = registry
            .register(
                &context("window-1", 1),
                "op-1",
                "capture",
                counting_cleanup(&rejected_counter),
            )
            .expect_err("duplicate id");
        assert_eq!(
            error,
            RegistryError::DuplicateOperation {
                operation_id: "op-1".to_owned()
            }
        );
        assert_eq!(
            rejected_counter.load(Ordering::SeqCst),
            0,
            "a rejected registration must not run its cleanup"
        );

        assert!(matches!(
            registry.register(&context("window-1", 1), "", "capture", || {}),
            Err(RegistryError::InvalidOperationId)
        ));
        assert_eq!(
            registry.complete(
                &context("window-1", 1),
                &OperationRef {
                    operation_id: String::new(),
                    generation: 1,
                }
            ),
            Err(RegistryError::InvalidOperationId)
        );

        registry
            .complete(&context("window-1", 1), first.reference())
            .expect("complete original still works");
    }

    #[test]
    fn invalidation_cancels_and_rejects_old_generation_completion() {
        let mut registry = OperationRegistry::new();
        let counter = cleanup_counter();
        let registered = registry
            .register(
                &context("window-1", 1),
                "op-1",
                "capture",
                counting_cleanup(&counter),
            )
            .expect("register");
        let token = registered.cancellation();

        assert_eq!(
            registry.invalidate_generation("window-1"),
            Invalidation {
                generation: 2,
                cancelled: 1
            }
        );
        assert!(token.is_cancelled(), "invalidation must cancel the token");
        assert_eq!(counter.load(Ordering::SeqCst), 1);

        let error = registry
            .complete(&context("window-1", 1), registered.reference())
            .expect_err("old generation completion must fail");
        assert!(
            matches!(error, RegistryError::UnknownOperation { .. }),
            "got {error:?}"
        );
        assert_eq!(
            counter.load(Ordering::SeqCst),
            1,
            "stale completion must not rerun cleanup"
        );

        // 旧 generation 不能再注册；新 generation 可以。
        assert!(matches!(
            registry.register(&context("window-1", 1), "op-2", "capture", || {}),
            Err(RegistryError::StaleGeneration {
                current: 2,
                requested: 1,
                ..
            })
        ));
        registry
            .register(&context("window-1", 2), "op-2", "capture", || {})
            .expect("new generation registers");
        assert_eq!(registry.known_generation("window-1"), Some(2));
    }

    #[test]
    fn stale_registration_and_reference_mismatches_are_rejected() {
        let mut registry = OperationRegistry::new();
        let registered = registry
            .register(&context("window-1", 2), "op-1", "capture", || {})
            .expect("register");
        assert!(matches!(
            registry.register(&context("window-1", 1), "op-2", "capture", || {}),
            Err(RegistryError::StaleGeneration {
                window_instance_id,
                current: 2,
                requested: 1,
            }) if window_instance_id == "window-1"
        ));

        let wrong_reference = OperationRef {
            operation_id: "op-1".to_owned(),
            generation: 99,
        };
        assert_eq!(
            registry.complete(&context("window-1", 2), &wrong_reference),
            Err(RegistryError::StaleOperation {
                operation_id: "op-1".to_owned(),
                registered: 2,
                requested: 99,
            })
        );

        // 用新实例上下文完成旧操作：上下文与注册时 generation 不一致。
        assert_eq!(
            registry.complete(&context("window-1", 3), registered.reference()),
            Err(RegistryError::ContextGenerationMismatch {
                operation_id: "op-1".to_owned(),
                registered: 2,
                provided: 3,
            })
        );

        registry
            .complete(&context("window-1", 2), registered.reference())
            .expect("correct context still completes");
    }

    #[test]
    fn close_window_releases_only_its_own_operations() {
        let mut registry = OperationRegistry::new();
        let first_counter = cleanup_counter();
        let second_counter = cleanup_counter();
        registry
            .register(
                &context("window-1", 1),
                "op-1",
                "capture",
                counting_cleanup(&first_counter),
            )
            .expect("register first");
        let second = registry
            .register(
                &context("window-2", 1),
                "op-2",
                "capture",
                counting_cleanup(&second_counter),
            )
            .expect("register second");

        assert_eq!(registry.close_window("window-1"), 1);
        assert_eq!(first_counter.load(Ordering::SeqCst), 1);
        assert_eq!(second_counter.load(Ordering::SeqCst), 0);
        assert!(registry.known_generation("window-1").is_none());
        assert_eq!(
            registry.active_operations("window-2"),
            [("op-2", "capture")]
        );

        registry
            .complete(&context("window-2", 1), second.reference())
            .expect("other window unaffected");
        assert_eq!(second_counter.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dropping_the_registry_cleans_up_remaining_operations() {
        let counter = cleanup_counter();
        {
            let mut registry = OperationRegistry::new();
            registry
                .register(
                    &context("window-1", 1),
                    "op-1",
                    "capture",
                    counting_cleanup(&counter),
                )
                .expect("register");
            registry
                .register(
                    &context("window-1", 1),
                    "op-2",
                    "capture",
                    counting_cleanup(&counter),
                )
                .expect("register");
        }
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn generation_invalidation_is_monotonic_and_saturating() {
        let mut registry = OperationRegistry::new();
        assert_eq!(
            registry.invalidate_generation("window-unknown"),
            Invalidation {
                generation: 1,
                cancelled: 0
            }
        );
        assert_eq!(
            registry.invalidate_generation("window-unknown"),
            Invalidation {
                generation: 2,
                cancelled: 0
            }
        );

        let mut saturated = OperationRegistry::new();
        saturated
            .register(&context("window-max", u64::MAX), "op-max", "capture", || {})
            .expect("register at u64::MAX");
        let invalidation = saturated.invalidate_generation("window-max");
        assert_eq!(invalidation.generation, u64::MAX);
        assert_eq!(invalidation.cancelled, 1);
    }

    #[test]
    fn active_operations_are_scoped_and_sorted() {
        let mut registry = OperationRegistry::new();
        registry
            .register(&context("window-1", 1), "b", "kind-b", || {})
            .expect("register b");
        registry
            .register(&context("window-1", 1), "a", "kind-a", || {})
            .expect("register a");

        assert_eq!(
            registry.active_operations("window-1"),
            [("a", "kind-a"), ("b", "kind-b")]
        );
        assert!(registry.active_operations("window-2").is_empty());
        assert!(registry.active_operations("").is_empty());
    }
}
