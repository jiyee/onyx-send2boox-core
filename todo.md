# onyx-send2boox Python -> TypeScript 1:1 Migration TODO

## Scope Lock
- [x] Keep command names/options/output conventions aligned with Python CLI behavior.
- [x] Keep module boundaries aligned: `exceptions`, `config`, `api`, `client`, `playwright_debug`, `playwright_session`, `cli`.
- [x] Keep unit-test behavior parity with Python tests (API/Config/Client/CLI/Playwright).

## Task 1 - Project Bootstrap
- [x] Create TypeScript project files (`package.json`, `tsconfig.json`, `.gitignore`, `vitest.config.ts`).
- [x] Add runtime dependencies (HTTP + TOML + CLI parser + cookie handling + OSS client).
- [x] Add dev dependencies (`typescript`, `vitest`, `tsx`, `@types/node`, lint helper if needed).
- [x] Add npm scripts: `build`, `test`, `test:watch`, `typecheck`, `start` (CLI entry).

## Task 2 - Core Modules 1:1 Port
- [x] Implement `src/exceptions.ts`.
- [x] Implement `src/config.ts`.
- [x] Implement `src/api.ts`.
- [x] Implement `src/client.ts` with data models and formatting helpers.

## Task 3 - Playwright Modules 1:1 Port
- [x] Implement `src/playwrightDebug.ts`.
- [x] Implement `src/playwrightSession.ts`.

## Task 4 - CLI 1:1 Port
- [x] Implement `src/cli.ts` with argument schema and command routing.
- [x] Implement stderr status prefixes: `[OK]`, `[WARN]`, `[ERROR]`.
- [x] Preserve fallback cloud logic (`preferred`, `send2boox.com`, `eur.boox.com`) where used.
- [x] Preserve output behavior (stdout data vs stderr status).

## Task 5 - Unit Tests (Full Port)
- [x] Port `tests/test_api.py` -> `tests/api.test.ts`.
- [x] Port `tests/test_config.py` -> `tests/config.test.ts`.
- [x] Port `tests/test_client.py` -> `tests/client.test.ts`.
- [x] Port `tests/test_playwright_debug.py` -> `tests/playwrightDebug.test.ts`.
- [x] Port `tests/test_playwright_session.py` -> `tests/playwrightSession.test.ts`.
- [x] Port `tests/test_cli.py` -> `tests/cli.test.ts`.

## Task 6 - Verification
- [x] Run `npm run typecheck`.
- [x] Run `npm test`.
- [x] Fix parity gaps until all tests pass.
- [x] Update this TODO with completion checkmarks and final verification notes.

### Verification Notes
- `npm run typecheck`: PASS
- `npm test`: PASS (64 passed, 0 failed)
- `npm run build`: PASS

## Notes
- This migration intentionally targets behavioral parity over API redesign.
- Playwright runtime integration will be dependency-injected/mocked in tests.
