# graph-ime

## Cursor Cloud specific instructions

这是进程内的 TypeScript 候选图内核。验证发生在 Node 进程里，不监听端口，也不依赖数据库或 Docker。

工作区存在 `package.json` 时：

- Node.js 版本见 `package.json` 的 `engines`（`>=22`）。
- 依赖用 `npm install`。`npm test` 和 `npm run typecheck` 写在 README 的「开发」一节。
- 仓库没有 lint 脚本，也没有 `dev` 脚本。`npm test` 用 `tsx` 跑 Node 测试，文字和图形 provider 由测试注入，这就是当前内核的端到端检查。

工作区还没有 `package.json` 时，该分支只有说明文档。Windows TSF、librime 和安装包是后续阶段，不在本仓库里。
