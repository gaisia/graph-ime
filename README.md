# graph-ime

graph-ime 是一款面向 Windows 的输入法内核。候选状态是一张显式的图：文字、本地图形和按需生成挂在同一次编码上，按键解码不需要等待生成。

当前仓库实现的是这张图和会话，还没有注册成系统输入法。`npm test` 可以在 Windows 上用 Node.js 22 直接跑。

完整建议见 [设计说明](docs/superpowers/specs/2026-10-13-graph-ime-design.md)。

## 建议

文字解码用 [librime](https://github.com/rime/librime)（BSD）。Windows 前端自己写 TSF，候选窗用自绘窗口，这样同一条候选里可以出现字、表情和生成结果。

交互参考搜狗输入法已经公开的行为：单行候选条、向下展开、Tab 切换「文字 / 图形 / 生成」、常用词带出本地表情、生成必须由用户点开。微软拼音适合作为 TSF 上屏行为的对照。小狼毫可以看交互，它的前端是 GPL，不链进本项目。

[REA](https://github.com/morluto/rea) 提供分层方法，不把上游源码搬进本仓库。借鉴的是纯领域图、可替换 provider，以及 `coverage` / `limitations` 这种不把失败说成“没有结果”的做法。对照的上游提交是 [`94072364c7f8410b0e86e72c912c2611572b278f`](https://github.com/morluto/rea/commit/94072364c7f8410b0e86e72c912c2611572b278f)。

## 现在能做什么

`CompositionSession` 接收注入的文字 provider 和本地图形索引：

- 文字候选按分数排序，默认一页 9 个。
- 图形候选挂在对应的词上。Emoji 上屏为文字，贴纸和图片上屏为本地图片载荷。
- `stageGeneration` 只记录请求。宿主完成模型调用后，用 `fulfillGeneration` 或 `failGeneration` 写回。
- 编码一变，未完成的生成就丢弃。
- `http(s)` 资源进不了图。图片要先落在本机路径或 `file:` URL。

## 开发

```bash
npm install
npm test
npm run typecheck
```

系统级 TSF 前端、librime 适配器和安装包是后续阶段，需要 Windows SDK。
