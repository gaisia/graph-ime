# graph-ime 设计说明

日期：2026-10-13

## 结论

graph-ime 做 Windows 优先的输入法。一次编码对应一张候选图，图里同时有文字、本地图形和按需生成。按键路径只走本地解码和图索引；生成是用户点开之后的异步结果。

文字引擎选用 librime。Windows 集成自己写 Text Services Framework（TSF）文本服务和自绘候选窗。产品交互对齐搜狗输入法公开的候选条、服务切换、候选表情和按需生成。REA 的源码留在上游，本仓库借鉴它的分层和证据表达。

## 参考怎么分工

| 参考 | 采用的部分 | 落点 |
| --- | --- | --- |
| 搜狗输入法 | 候选条、向下展开多行、Tab 切换服务、常用词带出表情、单独入口做 AI 表情和写作 | 交互和通道划分 |
| 微软拼音 | 预编辑、上屏、光标跟随在 Windows 文本框里的正常行为 | TSF 前端的验收对照 |
| librime | 拼音、双拼、五笔等方案和用户词库 | `TextProvider` 的正式实现 |
| REA `9407236` | 纯领域图、provider 适配器、`coverage` 与 `limitations` | `src/domain` 与会话 |

搜狗的词库、皮肤、表情包和可执行文件不进入本仓库。公开材料只用来确定交互：候选条升级、Tab 切换服务、候选 emoji、以及「AI 合成表情」这种用户主动触发的生成。生成速度以搜狗 2025 年公开演示的量级为体验目标（图片约 300ms 出预览）；做不到这个速度时，候选上先放占位，按键继续响应。

小狼毫（Weasel）是 librime 的 Windows 前端，许可证是 GPL。本项目只把它当作现成前端的行为对照，不链接、不复制它的界面代码。

REA 是本地逆向分析工具，MIT 许可，架构是入口适配器、组合根、应用流程、provider、纯领域模型。graph-ime 对应成：

```text
将来的 TSF / 候选窗   → 适配器，只做按键、上屏和绘制
CompositionSession    → 应用流程
TextProvider 等       → 可替换 provider
CompositionGraph      → 纯领域图，不读盘、不访问网络
```

上游文档里的 JavaScript Application Graph 把节点、有向边、coverage 和 limitations 分成独立事实。graph-ime 的候选图使用同一约束：失败写成 limitation，缺结果写成 `unknown` 或 `partial`，图本身拒绝悬空边、自环和远程 URL。

## 候选图

schema 为 `GraphImeCompositionGraph`，version 为 1。

节点：

- `composition`：当前编码，例如 `shoudao`。
- `text`：文字候选，带读音、分数和页内序号。
- `graphic`：emoji、贴纸或图片，必须挂在某个文字候选上。
- `generation`：一次生成请求，状态是 `pending`、`ready` 或 `failed`。

边：

- `proposes`：编码指向文字候选。
- `illustrates`：文字候选指向本地图形。
- `requests`：编码或文字候选指向生成请求。

`coverage` 取 `complete`、`partial`、`unknown`。`complete` 不能带 limitations；另外两种必须说明缺了什么。文字 provider 抛错时，编码节点还在，coverage 为 `unknown`。图形索引抛错或结果被截断时，文字候选保留，coverage 为 `partial`。

图形和生成结果的 `source` 只能是本机路径、UNC 路径或 `file:` URL。`http:`、`https:`、`data:` 和无协议的 `//` 地址会被拒绝。宿主若调用了远程模型，先把文件写入临时目录，再交给内核。

## 三条路径

### 文字

同步。目标是按键到预编辑更新低于 16ms，只调用本地 librime。默认一页 9 个候选，按分数从高到低，分数相同再按文字和读音排序。重复项保留高分。这一页之外的候选记为截断，coverage 变为 `partial`。

正式 provider 实现 librime 的 C API，方案文件沿用 Rime 的 schema。第一期方案用朙月拼音，双拼和五笔以后加 schema，不另写分词器。

### 图形

同步，只查本地索引。索引的键是文字候选的词面，不是编码。Emoji 的上屏载荷是文字；贴纸和图片的上屏载荷是 `{ type: "image", source, altText }`。默认最多 8 个图形候选。

搜狗的「候选表情」对应这条路径：常用词直接带出已经在本地的 emoji 或贴纸。它不调用生成模型。

### 即时生成

异步，且不在 `setComposition` 里启动。`stageGeneration(skill, prompt)` 只增加一个 `pending` 节点，并把通道切到生成。技能第一期固定为：

- `continue`：续写
- `polish`：润色
- `translate`：翻译
- `sticker`：按描述生成贴纸

宿主自己调用模型，再 `fulfillGeneration` 或 `failGeneration`。未完成或失败的请求不能上屏。编码字符串一旦改变，挂在旧编码上的生成全部丢弃，避免旧结果配上新的字。

锚点优先用当前焦点：焦点是词，就挂在这个词上；焦点是图形，就挂在它所属的词上；否则挂在编码上。

搜狗里「定制 AI 表情」和「= 之后的写作技能」都属于这条路径。入口是 Tab 到生成通道，或以后的技能键，不是每次击键都请求模型。

## 通道和按键

通道顺序是文字、图形、生成。`cycleLane` 按这个顺序切换。方向键或 `focusStep` 在当前通道内移动焦点。Enter 对应 `commitFocused`。Esc 对应 `clear`，编码和未完成生成一起清空。

上屏之后会话回到空编码和文字通道。宿主拿到的载荷：

- `{ type: "text", text }`：交给 TSF 插入。Emoji 走这里。
- `{ type: "image", source, altText }`：TSF 插不进普通文本框。宿主把文件放入剪贴板，只对允许列表里的前台窗口发送粘贴；其余窗口插入 `altText`。允许列表第一期只考虑聊天窗口，并在 Windows 上逐个核对微信和 QQ。

## 隐私和失败

默认配置不上传编码和按键。生成请求里的 `prompt` 由用户明确触发，宿主在发往模型之前展示这句 prompt。内核不保存模型地址，也不保存密钥。

provider 返回坏数据时，会话丢掉这一条并记 limitation，不让整页候选消失。生成写回了远程地址时，这次写回失败，请求保持 `pending`。

## 仓库分层

```text
src/domain/compositionGraph.ts   图的不变量
src/domain/commit.ts             节点如何变成上屏载荷
src/session/compositionSession.ts 编码、通道、生成和上屏
src/session/projectLane.ts       当前通道的候选条
tests/                           图和会话的行为
```

下一步才增加 `src/providers/librime.ts`。TSF 工程、候选窗和安装包放在以后的 `windows/`，它们依赖 Windows SDK，不进这次内核。

## 后续阶段

1. **librime provider。** 用固定词库断言 `nihao` 的首候选，进程内或本机 sidecar 均可。候选窗仍然可以是控制台。
2. **TSF 文字前端。** 只上屏文字。验收标准是记事本里的预编辑、数字选词、Enter 上屏和 Esc 清空，并与微软拼音的基本手感对照。
3. **本地图形索引。** 候选条出现 emoji 和贴纸缩略图。贴纸上屏走剪贴板路径。
4. **一种文字技能。** 先做 `polish`。占位候选立即出现，结果返回后才允许 Enter。
5. **贴纸生成。** 模型输出写入临时文件，再 `fulfillGeneration`。预览超过约 300ms 时，占位保留到结果或失败回来。

每个阶段都要能单独安装或单独运行，不把后面的阶段堵在同一个二进制里。

## 风险

系统输入法需要安装程序、启动项和代码签名，杀毒软件可能拦截全局键盘钩子以外的正常 TSF 注册，所以前端从 TSF 文本服务做起，不用全局钩子去抢按键。

聊天软件对粘贴图片的支持不一致。图片载荷和替代文字必须同时存在，允许列表之外一律上屏替代文字。

生成模型的延迟和内容审核都在宿主。内核只保证未完成结果不能上屏，以及编码变化会取消旧请求。
