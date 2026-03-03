# onyx-send2boox-core

TypeScript CLI for interacting with the send2boox service used by Onyx Boox e-ink devices.

Chinese version: [简体中文](./README_ZH.md)

## Quick Start

Requirements:

- Node.js `>= 20`
- npm

Install dependencies and prepare config files:

```bash
npm install
cp config.example.json config.json
cp .env.local.example .env.local
```

Fill `config.json` with your account and server host:

```json
{
  "server": "send2boox.com",
  "email": "your_email@example.com",
  "mobile": ""
}
```

Set token in `.env.local` (or leave empty and obtain it with `auth code`):

```bash
SEND2BOOX_TOKEN=your_send2boox_token_here
```

`email` and `mobile` are both supported; set either one.

## Authentication Flow

Use `npm start --` as the command prefix during development:

```bash
npm start -- auth login
npm start -- auth code <6_digit_code>
npm start -- auth login --mobile 13800138000
npm start -- auth code <6_digit_code> --mobile 13800138000
```

The token is saved to `.env.local` as `SEND2BOOX_TOKEN`. By default, `auth code`
also calls `users/syncToken` and writes browser cookies to `session-cookies.json`
for debugging. If cookie sync returns no cookies, the command warns and keeps
token-only flow available.

## Common Commands

```bash
npm start -- file list --limit 24 --offset 0
npm start -- file send ./book1.epub ./book2.pdf
npm start -- file delete <file_id_1> <file_id_2>
```

List library books without opening browser DevTools. By default, `book list`
prints an ID/Name table. Use `--json` for full metadata (including `unique_id`,
usable as `docIds` for `statistics/readInfoList`):

```bash
npm start -- book list
npm start -- book list --json
npm start -- book list --include-inactive --output ./library-books.json
```

If you only need `unique_id` values:

```bash
npm start -- book list --json | jq -r '.[].unique_id' > book-ids.txt
```

Query single-book reading stats (fields from `statistics/readInfoList`):

```bash
npm start -- book stats 0138a37b2e77444b9995913cca6a6351
npm start -- book stats 0138a37b2e77444b9995913cca6a6351 --output ./read-stats.json
```

Export single-book annotations and bookmarks from `READER_LIBRARY`:

```bash
npm start -- book annotations 0138a37b2e77444b9995913cca6a6351 --output ./annotations.json
npm start -- book bookmarks 0138a37b2e77444b9995913cca6a6351 --output ./bookmarks.json
```

Export single-book annotations as Boox-style `Reading Notes` TXT:

```bash
npm start -- book dump 0138a37b2e77444b9995913cca6a6351
npm start -- book dump 0138a37b2e77444b9995913cca6a6351 --author "Tianzhen Yang" --output ./reading-notes.txt
```

When `--author` is omitted, `book dump` automatically uses the `authors` field
from library metadata (if available). Passing `--author` overrides that value.

By default these commands return active records (`status == 0`). Pass
`--include-inactive` to include deleted/archived history records.

## CLI Output Conventions

- `stdout`: structured command data (tables / JSON payloads).
- `stderr`: status and progress messages.
- Status prefixes are standardized:
  - `[OK]`: successful status updates.
  - `[WARN]`: non-fatal warnings and fallbacks.
  - `[ERROR]`: fatal failures (command exits non-zero).

## Package Usage

This repository also exposes TypeScript library APIs:

- root export: `onyx-send2boox-core`
- browser-safe subset: `onyx-send2boox-core/browser`
- snapshot helpers: `onyx-send2boox-core/snapshot`
- low-level API layer: `onyx-send2boox-core/api`

Example:

```ts
import { BooxApi } from 'onyx-send2boox-core/api';
import { fetchReaderLibrarySnapshot } from 'onyx-send2boox-core/snapshot';

const api = new BooxApi({ cloud: 'send2boox.com', token: process.env.SEND2BOOX_TOKEN ?? '' });
const snapshot = await fetchReaderLibrarySnapshot({ api });
console.log(snapshot.books.length);
```

## Install as a Global CLI (Optional)

```bash
npm run build
npm link
send2boox --help
```

## Project Layout

- `src/api.ts`: HTTP API layer with timeout/error handling and cookie sync.
- `src/client.ts`: business logic for auth, list, upload, delete.
- `src/config.ts`: JSON config load/save + `.env.local` token persistence.
- `src/cli.ts`: argparse-based CLI entrypoint.
- `src/snapshot.ts`: reader-library snapshot parser/fetch helpers.
- `src/browser.ts`: browser-safe export surface.
- `tests/`: Vitest test suite.

## Development Checks

```bash
npm run typecheck
npm test
npm run build
```

## Security Notes

- `config.json` and `.env.local` are git-ignored.
- `.env.local` contains sensitive token data (`SEND2BOOX_TOKEN`).
- Never commit real credentials.
