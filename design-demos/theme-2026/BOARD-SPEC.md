# 交付物 DOM 契约（三个方向必须一致，验证脚本与截图依赖它）

所有方向都是**单文件 HTML**，源码在 `src/dir-N.html`，由 `tools/build.mjs` 注入图标表与内容模型后生成根目录的 `dir-N.html`。

## 必须存在的结构

```
<html data-theme="light|dark">          ← 主题开关切换这个属性
<body>
  <div id="board">                      ← 评审板：1600 宽，纵向排布
    <section id="appWin">               ← 主窗口，1120 × 760，1:1 不缩放
      <aside id="navBox">               ← 侧栏
        <button class="nav" data-route="home|history|usage|settings-general" data-label="快捷功能">
      <header id="pTitle">              ← 标题栏里的当前路由标题
      <div class="status-rail">         ← 状态轨（3–4 格）
      <nav id="tabs">                   ← 页签：<button class="tab" data-tab="shot">
      <main id="list">                  ← 条目容器：<div class="item">
      <button id="themeToggle">         ← 亮/暗切换
    </section>

    <section id="captureDemo">           ← 截图浮层演示：一块「假桌面」+ 选区 + 工具条
      <div class="screen">              ← 假桌面内容（用 CSS 画两块窗口）
      <div class="selection">           ← 选区框 + 尺寸徽标
      <div class="capture-bar">         ← 两行工具条
        <button class="tool" data-tool="select|rect|...">
      </div>
    </section>

    <section id="clipPanel">             ← 剪贴板面板，480 × 640
      <div class="chip" data-kind="">    ← 分类芯片
      <div id="clipList">
        <div class="clip-row" data-kind="text|url|image" aria-selected="false">
    </section>

    <section id="selBar">                ← 划词工具条 620 × 56
      <button class="sel-btn" data-action="copy|search|translate|explain|open">
    </section>

    <section id="motionStage">           ← 动效演示台（默认静止）
      <button id="motionBtn">播放
    </section>
  </div>
```

## 必须真的能交互

| 交互 | 验收 |
|---|---|
| 点侧栏 `.nav` | `#pTitle` 文本变成该路由标题；`.nav.active` 只留一个 |
| 点页签 `.tab` | `#list` 内容整组替换（条目数量或文本变化） |
| 点 `#themeToggle` | `data-theme` 翻转，`body` 计算后的 `background-color` 真的改变，再点回去能恢复 |
| 点 `.tool` | 只留一个 `.tool.active`，工具条下方对应选项组切换（至少 2 个工具选项不同） |
| 点 `.clip-row` | 该行 `aria-selected="true"`，其余为 false |
| 点 `.chip` | 只留一个 `aria-pressed="true"`，列表按 kind 过滤 |
| 点 `#motionBtn` | `#motionStage` 加上 `.is-playing`，动画在 1.2s 内结束（不是无限循环） |

## 硬约束

- **禁止网络字体**（CSP 是 `font-src 'self' data:`）。可用：`Segoe UI Variable Display/Text`、`Segoe UI`、`Microsoft YaHei UI`、`DengXian`、`Bahnschrift`、`Noto Serif SC`、`Noto Sans SC`、`Cascadia Mono`、`Consolas`。
- **图标**：只用 `var(--ico-<name>)`（由 build 注入的 45 个真实产品图标），写法：
  ```html
  <i class="ico" style="--icon:var(--ico-search)"></i>
  <style>.ico{width:18px;height:18px;background:currentColor;-webkit-mask:var(--icon) center/contain no-repeat;mask:var(--icon) center/contain no-repeat}</style>
  ```
- **内容**：只用 `window.HL` 里的字符串（`/*__CONTENT__*/` 会被替换成该脚本）。不许出现 Lorem、不许编造数字。
- 字号：正文 ≥14px，标签 ≥12px。对比度 ≥4.5:1。
- 动效只用 `transform`/`opacity`/`filter`；必须写 `@media (prefers-reduced-motion: reduce)` 降级。
- 1600 宽下不许出现横向滚动。
- 文件内不许有 `http://` / `https://` 资源引用（除了注释里的出处 URL）。

## 交付

- 源码 `src/dir-N.html`，其中必须原样保留两个占位标记：`/*__ICON_SHEET__*/`（放在 `<style>` 的第一个规则位置）与 `/*__CONTENT__*/`（放在 `<script>` 里、使用 `window.HL` 之前的独立 `<script>` 标签内）。
- 生成物不要自己写：Lead 统一跑 `node tools/build.mjs`。
