# onyx-send2boox-core

一款与文石(Boox)电子书 send2boox 服务进行数据同步的 TypeScript 命令行工具。

English version: [README.md](./README.md)

## 快速开始

环境要求：

- Node.js `>= 20`
- npm

安装依赖并准备配置文件：

```bash
npm install
cp config.example.json config.json
cp .env.local.example .env.local
```

在 `config.json` 中填写账号和服务器地址：

```json
{
  "server": "send2boox.com",
  "email": "your_email@example.com",
  "mobile": ""
}
```

在 `.env.local` 中配置 token（也可先留空，后续通过 `auth code` 获取）：

```bash
SEND2BOOX_TOKEN=your_send2boox_token_here
```

`email` 和 `mobile` 都支持，二选一填写即可。

## 认证流程

开发态建议使用 `npm start --` 作为命令前缀：

```bash
npm start -- auth login
npm start -- auth code <6_digit_code>
npm start -- auth login --mobile 13800138000
npm start -- auth code <6_digit_code> --mobile 13800138000
```

拿到的 token 会保存到 `.env.local` 的 `SEND2BOOX_TOKEN`。默认情况下，
`auth code` 还会调用 `users/syncToken`，并将浏览器 cookies 写入
`session-cookies.json` 以便调试。如果 cookie 同步为空，命令会给出警告并继续
保留仅 token 的工作流。

## 常用命令

```bash
npm start -- file list --limit 24 --offset 0
npm start -- file send ./book1.epub ./book2.pdf
npm start -- file delete <file_id_1> <file_id_2>
```

无需打开浏览器 DevTools 即可查看书库图书。默认 `book list` 输出 `ID/Name`
表格；如需完整元数据（包含 `unique_id`，可作为 `statistics/readInfoList` 的
`docIds`）可使用 `--json`：

```bash
npm start -- book list
npm start -- book list --json
npm start -- book list --include-inactive --output ./library-books.json
```

如果你只需要 `unique_id`：

```bash
npm start -- book list --json | jq -r '.[].unique_id' > book-ids.txt
```

查询单本书阅读统计（字段来自 `statistics/readInfoList`）：

```bash
npm start -- book stats 0138a37b2e77444b9995913cca6a6351
npm start -- book stats 0138a37b2e77444b9995913cca6a6351 --output ./read-stats.json
```

导出单本书的划线批注与书签（来自 `READER_LIBRARY`）：

```bash
npm start -- book annotations 0138a37b2e77444b9995913cca6a6351 --output ./annotations.json
npm start -- book bookmarks 0138a37b2e77444b9995913cca6a6351 --output ./bookmarks.json
```

按 Boox 的 `Reading Notes` 模板导出单本书划线为 TXT：

```bash
npm start -- book dump 0138a37b2e77444b9995913cca6a6351
npm start -- book dump 0138a37b2e77444b9995913cca6a6351 --author "杨天真" --output ./reading-notes.txt
```

当不传 `--author` 时，`book dump` 会优先使用书库元数据中的 `authors`
字段（如果存在）；传入 `--author` 则会覆盖该值。

以上命令默认返回有效记录（`status == 0`）。传入 `--include-inactive` 可包含
已删除/归档的历史记录。

## CLI 输出约定

- `stdout`：结构化命令数据（表格 / JSON）。
- `stderr`：状态与进度信息。
- 状态前缀统一如下：
  - `[OK]`：成功状态提示。
  - `[WARN]`：非致命告警或回退信息。
  - `[ERROR]`：致命错误（命令以非 0 退出）。

## 作为库使用

本仓库同时导出 TypeScript 库接口：

- 根导出：`onyx-send2boox-core`
- 浏览器安全子集：`onyx-send2boox-core/browser`
- 快照能力：`onyx-send2boox-core/snapshot`
- 底层 API：`onyx-send2boox-core/api`

示例：

```ts
import { BooxApi } from 'onyx-send2boox-core/api';
import { fetchReaderLibrarySnapshot } from 'onyx-send2boox-core/snapshot';

const api = new BooxApi({ cloud: 'send2boox.com', token: process.env.SEND2BOOX_TOKEN ?? '' });
const snapshot = await fetchReaderLibrarySnapshot({ api });
console.log(snapshot.books.length);
```

## 可选：安装为全局 CLI

```bash
npm run build
npm link
send2boox --help
```

## 项目结构

- `src/api.ts`：HTTP API 层（超时、错误处理、cookie 同步）。
- `src/client.ts`：业务逻辑（认证、列表、上传、删除）。
- `src/config.ts`：`config.json` 读写 + `.env.local` token 持久化。
- `src/cli.ts`：基于 argparse 的 CLI 入口。
- `src/snapshot.ts`：阅读库快照抓取与解析能力。
- `src/browser.ts`：浏览器安全导出接口。
- `tests/`：Vitest 测试套件。

## 开发检查

```bash
npm run typecheck
npm test
npm run build
```

## 安全说明

- `config.json` 与 `.env.local` 已被 git ignore。
- `.env.local` 中包含敏感 token（`SEND2BOOX_TOKEN`）。
- 不要提交真实凭据。
