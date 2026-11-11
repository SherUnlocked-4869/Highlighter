# highlighter-core（R0）

计划 §3.1 的用例与状态机 crate。R0 只交付**操作注册表原型**：窗口实例 + generation +
取消信号 + 清理函数，验证计划 §4.2 的三条不变量：

1. 宿主为调用生成 `HostContext`（`windowInstanceId`/`role`/`generation`）；页面不能自报身份。
2. 长任务由注册表关联窗口实例、generation、取消信号与清理函数。
3. 实例/代际更新后，旧 generation 的**完成与取消**必须失效；清理函数最多执行一次。

## R0 交付

- `RegistryError`：重复 operationId、旧 generation 注册、未知操作、generation 不匹配、
  上下文不匹配等显式错误。
- `RegisteredOperation`：返回 `OperationRef` 与可克隆的 `CancellationToken`。
- `OperationRegistry`：
  - `register`：拒绝重复 operationId；拒绝比该窗口已知 generation 更旧的上下文。
  - `complete`/`cancel`：校验 reference.generation 与上下文 generation；成功才移除并执行
    清理；失败不改状态、不重复执行清理。
  - `invalidate_generation`：generation 单调 +1（`u64::MAX` 饱和），取消并清理该窗口所有
    旧操作。
  - `close_window`：只释放该窗口拥有的操作与 generation 记录，不影响其它窗口。
  - `Drop`：注册表销毁时取消/清理剩余操作（进程退出诊断用）。
- 单元测试覆盖：正常完成/取消、重复注册、旧 generation、跨窗口隔离、Drop 清理、
  generation 饱和。

## 明确不做

- 不做 ready/init 握手、窗口创建/销毁、事件路由（R1-02）；
- 不做数据根 generation 与窗口 generation 的绑定（R1/R2 装配时确定，原型只有单一
  generation 维度，语义等同 HostContext.generation）；
- 不做异步运行时/线程池/超时取消（R1-05 再定）。
