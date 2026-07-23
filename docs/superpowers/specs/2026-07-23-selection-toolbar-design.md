# 划词工具栏复制、搜索与配置页设计

## 目标

在现有划词工具栏中新增“复制”和“搜索”按钮，并新增独立的“划词工具”配置页面。复制将当前划词文本写入系统剪贴板；搜索将文本编码后交给系统默认浏览器，并默认使用 Bing。

## 范围

本次包含：

- 划词工具栏总开关。
- “复制”“搜索”“翻译”“解释”四个按钮的独立显示开关。
- 搜索引擎选择，支持 Bing、百度和 Google，默认 Bing。
- 工具栏根据实际显示按钮数量调整宽度。

本次不包含按钮拖拽排序、划词长度限制、自动隐藏时长配置或自定义搜索 URL。

## 配置模型

在现有设置对象中增加 `selectionToolbar`：

```js
selectionToolbar: {
  enabled: true,
  buttons: {
    copy: true,
    search: true,
    translate: true,
    explain: true
  },
  searchEngine: 'bing'
}
```

设置仍由现有 `electron-store`、`settings:get` 和 `settings:update` 管理。深度合并默认值，确保已有用户升级后自动获得完整配置。

## 配置页面

设置侧栏增加“划词工具”入口，页面包括：

- “启用划词工具栏”总开关。
- 四个按钮的显示开关。
- 搜索引擎下拉框：Bing、百度、Google。

开关沿用现有设置页的即时保存行为；搜索引擎选择后通过明确的保存按钮写入。总开关关闭，或四个按钮全部关闭时，划词不显示工具栏。

## 工具栏行为

主进程收到划词文本后读取最新配置：

1. 总开关关闭或没有可见按钮时直接返回。
2. 根据可见按钮数量设置工具栏窗口宽度并重新计算屏幕内位置。
3. 向工具栏发送划词文本和可见按钮列表。
4. 工具栏只渲染配置启用的按钮。

按钮顺序固定为：复制、搜索、翻译、解释。视觉样式沿用现有深色工具栏和分隔线，不引入新的设计系统。

## 动作处理

所有按钮继续通过隔离的 preload API 向主进程发送统一的 `toolbar:action` 消息。

- `copy`：使用 Electron `clipboard.writeText` 写入划词文本，然后隐藏工具栏。
- `search`：从受支持搜索引擎模板构造 HTTPS URL，使用 `encodeURIComponent` 编码划词文本，通过 `shell.openExternal` 在系统默认浏览器打开，然后隐藏工具栏。
- `translate` / `explain`：保持现有 API Key 检查、结果窗口和流式响应逻辑。

复制和搜索不检查 API Key，也不会创建 AI 结果窗口。未知动作被忽略，避免把任意输入当作 URL 或 AI 动作执行。

搜索 URL：

- Bing：`https://www.bing.com/search?q=<query>`
- 百度：`https://www.baidu.com/s?wd=<query>`
- Google：`https://www.google.com/search?q=<query>`

## 错误处理

- 空文本不执行任何动作。
- `shell.openExternal` 失败时记录日志，工具栏仍隐藏，避免阻塞后续划词。
- 配置中的未知搜索引擎回退到 Bing。
- 旧配置缺少字段时由默认配置补齐。

## 测试与验收

按测试先行方式覆盖：

- 默认配置启用工具栏和四个按钮，默认搜索引擎为 Bing。
- 总开关关闭或所有按钮关闭时不显示工具栏。
- 按钮过滤与固定顺序正确。
- Bing、百度、Google URL 正确编码中文、空格和特殊字符。
- 复制、搜索动作不进入 API Key/AI 分支；翻译、解释保持原行为。
- 工具栏宽度和位置计算使用实际可见按钮数量。

完成后运行项目 `npm run check`，并启动 Electron 人工验证配置页、按钮显示、剪贴板内容和默认浏览器搜索结果。
