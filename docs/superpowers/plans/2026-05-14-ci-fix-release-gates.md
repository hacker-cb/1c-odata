# PR 1: Fix release CI gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать `release.yml` зелёным на push в `master` — убрать `examples/*` из release CI gates и починить flaky cli-тесты, если CI на feature branch их подтвердит.

**Architecture:** Двухслойная: (1) детерминированный фикс в workflow-yaml — все вызовы `pnpm turbo …` в `release.yml` и `ci.yml` получают `--filter='./packages/*'`, отделяя examples от релизной сетки. (2) Диагностический слой — после push'а feature branch смотрим красный/зелёный реальный CI и реагируем точечно.

**Tech Stack:** GitHub Actions, pnpm 10, turborepo 2, vitest 4, c12 (dotenv loader).

**Spec:** `docs/superpowers/specs/2026-05-14-public-release-design.md` (Этап 1).

---

### Task 1: Переписать CI gates в `release.yml` — фильтр + split на отдельные шаги

**Files:**
- Modify: `.github/workflows/release.yml`

Две связанные правки, которые имеет смысл делать вместе:

1. `--filter='./packages/*'` — исключает `examples/basic` (паттерн совпадает с `pnpm-workspace.yaml`, где `packages/*` и `examples/*` уже разделены; пример консьюмера проверяется в отдельном `test-example` job под live секретами).
2. Combined `pnpm turbo typecheck test:unit test:integration:offline build package:lint …` разбить на отдельные `name:` шаги, по одному task'у на шаг (mirror `ci.yml`). Combined command пускает turbo планировать tasks параллельно под единым `^build` barrier, и параллельный запуск `@1c-odata/cli#test:unit` + `@1c-odata/cli#test:integration:offline` гонится за shared process state (msw `setupServer`, `process.env`, OS tmpdir).

Почему `./packages/*` (а не `--filter=@1c-odata/client --filter=@1c-odata/cli`): glob по пути — стабилен при добавлении новых пакетов; не нужно обновлять filter при появлении нового `packages/<x>`.

- [ ] **Step 1: Заменить шаг `CI gates` в `release.yml`**

Before (baseline — это состояние `release.yml` до начала работы по этому PR; в текущем `release.yml` уже **не такое**, см. итоговый блок ниже):
```yaml
      - name: CI gates
        run: pnpm turbo typecheck test:unit test:integration:offline build package:lint
```

Заменить на (комментарий объясняет почему так структурировано):
```yaml
      # CI gates split into separate turbo invocations (mirrors ci.yml).
      # A combined `pnpm turbo typecheck test:unit ...` lets turbo run those
      # tasks in parallel under one `^build` barrier; the parallel
      # @1c-odata/cli vitest runs (test:unit + test:integration:offline)
      # then race on shared global state — msw setupServer interception,
      # process.env, OS tmpdir — producing flake that ci.yml's
      # one-task-per-step structure avoids.
      - name: Typecheck (gate 1)
        run: pnpm turbo typecheck --filter='./packages/*'
      - name: Unit tests (gate 2)
        run: pnpm turbo test:unit --filter='./packages/*'
      - name: Offline integration tests (gate 3)
        run: pnpm turbo test:integration:offline --filter='./packages/*'
      - name: Build (gate 4)
        run: pnpm turbo build --filter='./packages/*'
      - name: Package lint (gate 5)
        run: pnpm turbo package:lint --filter='./packages/*'
```

- [ ] **Step 2: Commit (на feature branch `chore/ci-fix-release-gates`)**

Один или два коммита по вкусу — фильтр и split можно слить (минимальный diff), но в этом PR они исторически разнесены: сначала фильтр (`c504152`), затем split с подробным commit message (`448f160`).

---

### Task 2: Тот же фильтр в `ci.yml`

**Files:**
- Modify: [.github/workflows/ci.yml:100](/.github/workflows/ci.yml#L100)
- Modify: [.github/workflows/ci.yml:113-121](/.github/workflows/ci.yml#L113-L121)

- [ ] **Step 1: Поменять команды в job `lint-and-typecheck`**

Сейчас (строка 99–100):
```yaml
      - name: Typecheck (gate 2)
        run: pnpm turbo typecheck
```

Заменить на:
```yaml
      - name: Typecheck (gate 2)
        run: pnpm turbo typecheck --filter='./packages/*'
```

- [ ] **Step 2: Поменять команды в job `test-and-build`**

Сейчас (строки 112–121):
```yaml
      - name: Unit tests (gate 3)
        run: pnpm turbo test:unit
      - name: Offline integration tests (gate 4)
        run: pnpm turbo test:integration:offline
      - name: Build (gate 5)
        run: pnpm turbo build
      - name: Package lint (gate 6)
        run: pnpm turbo package:lint
      - name: E2E tests (gate 8)
        run: pnpm turbo test:e2e
```

Заменить на:
```yaml
      - name: Unit tests (gate 3)
        run: pnpm turbo test:unit --filter='./packages/*'
      - name: Offline integration tests (gate 4)
        run: pnpm turbo test:integration:offline --filter='./packages/*'
      - name: Build (gate 5)
        run: pnpm turbo build --filter='./packages/*'
      - name: Package lint (gate 6)
        run: pnpm turbo package:lint --filter='./packages/*'
      - name: E2E tests (gate 8)
        run: pnpm turbo test:e2e --filter='./packages/*'
```

NB: job `test-example` НЕ трогаем — он уже использует `pnpm --filter basic-example`, явно отрабатывает example.

- [ ] **Step 3: Локальный smoke-test фильтра**

```bash
pnpm turbo typecheck --filter='./packages/*' --dry-run=json | grep '"package":' | sort -u
```

Expected: только `@1c-odata/client` и `@1c-odata/cli`, без `basic-example`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: scope all turbo gates to packages/* via filter

Mirror the release.yml fix in ci.yml so PR CI behaviour matches
the release path. examples/basic continues to be exercised in the
dedicated test-example job under owner-only live secrets.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Push feature branch, посмотреть реальный CI output

**Files:** (no edits in this task)

- [ ] **Step 1: Убрать stale local remote refs из старого tvip-remote**

```bash
git remote prune origin
```

Expected: либо «pruned: origin/chore/drop-tvip-fixture …», либо «No stale references found» если уже отпрюнено.

- [ ] **Step 2: Push feature branch**

```bash
git push -u origin chore/ci-fix-release-gates
```

NB: это первый push в новый remote `hacker-cb/1c-odata` любой не-master ветки. CI на новый remote запустится, но `detect-secrets` упадёт (на `hacker-cb` нет ещё ни одного секрета). Это ожидаемо — нам важен job `lint-and-typecheck` + `test-and-build`, которые `secrets`-независимы.

- [ ] **Step 3: Дождаться окончания CI workflow и снять статус**

```bash
gh run list --branch chore/ci-fix-release-gates --workflow ci.yml --limit 1
```

Expected: один run, status `in_progress` → потом `completed`. Дождаться `completed`.

```bash
gh run view --branch chore/ci-fix-release-gates --workflow ci.yml --log-failed > /tmp/ci-failed.log
```

Если файл пустой → все jobs прошли. Pi pi pi — переход к Task 6.
Если непустой — анализ в Task 4.

---

### Task 4: Conditional — диагностика cli `test:unit` (`config.test.ts`)

**Skip this task if** Task 3 показал зелёный CI. (В реальном исполнении этого PR — пропущено: split в Task 1 step 2 устранил гонку и тесты прошли без правки.)

**Files:**
- Maybe modify: `packages/cli/test/unit/config.test.ts`
- Maybe modify: `packages/cli/src/config.ts`

**Context.** Лог из предыдущего release run (`hacker-cb/1c-odata` run `25859723187`) показал два падения:

```
× auto-sources .env.local from cwd before evaluating config
× .env.local overrides .env when both are present
```

Локально (macOS, pnpm 10.27, node 22) — все 14 тестов в `test/unit/config.test.ts` зелёные. На `ci.yml` (тот же commit) — тоже зелёные. На `release.yml` — два падения, и `test/unit/fetch-command.test.ts (0 test)` (значит beforeAll бросил исключение). Версии deps детерминированы — обе сборки идут через `pnpm install --frozen-lockfile` с одним lockfile. Реальное отличие — release.yml шёл одной командой `pnpm turbo typecheck test:unit test:integration:offline …`, что позволило turbo пускать tasks параллельно (см. Task 1 step 2). Параллельный запуск `@1c-odata/cli#test:unit` и `@1c-odata/cli#test:integration:offline` гонится за общий process state (msw `setupServer` interception, `process.env`, OS tmpdir). На `ci.yml` те же tasks идут разными шагами → последовательно → green.

- [ ] **Step 1: Получить точный stderr из failed job**

```bash
gh run view --branch chore/ci-fix-release-gates --workflow ci.yml --log 2>&1 | \
  awk '/cli:test:unit/,/ELIFECYCLE/' > /tmp/cli-test-unit.log
cat /tmp/cli-test-unit.log
```

Искать: какие именно ассерты не сошлись. Возможные сценарии:
- `result.config.connections.trade?.auth.username` undefined — `.env.local` не подгружен.
- `result.config.connections.trade?.baseUrl` другой — `.env` overrode `.env.local`.

- [ ] **Step 2: Проверить, что c12 в lockfile делает с массивом `fileName`**

```bash
grep -A2 '"c12":' pnpm-lock.yaml | head -20
```

Expected: одна или две версии c12. Если в lockfile резолвится в, например, c12@3.4.0+ и они там поменяли API — это root cause.

Прочитать `node_modules/.pnpm/c12@<resolved>/node_modules/c12/dist/shared/*.mjs` поиском `fileName`:

```bash
grep -rn "fileName" node_modules/.pnpm/c12@*/node_modules/c12/dist 2>/dev/null | head -10
```

Если c12 принимает только `fileName: string` (одно имя) — массив не работает → `.env.local` не подгружается → тесты падают.

- [ ] **Step 3: Если c12 не поддерживает массив — fix в `packages/cli/src/config.ts`**

Заменить:
```typescript
const result = await c12Load<CliConfig>({
  cwd: opts.cwd,
  name: '1c-odata',
  dotenv: { fileName: ['.env', '.env.local'] },
  ...(opts.configFile !== undefined ? { configFile: opts.configFile } : {}),
})
```

На двойной вызов loadDotenv (`c12` экспортирует `loadDotenv`):

```typescript
import { loadConfig as c12Load, loadDotenv } from 'c12'

// ... внутри loadConfig:
// Layer: .env первым, .env.local поверх (override). Совместимо со старым API c12.
await loadDotenv({ cwd: opts.cwd, fileName: '.env' })
await loadDotenv({ cwd: opts.cwd, fileName: '.env.local' })

const result = await c12Load<CliConfig>({
  cwd: opts.cwd,
  name: '1c-odata',
  // dotenv уже подгружен выше — не дублируем
  ...(opts.configFile !== undefined ? { configFile: opts.configFile } : {}),
})
```

NB: `loadDotenv` в c12 v3 принимает `fileName: string` и расставляет переменные в `process.env`. Двойной вызов — `.env.local` идёт ВТОРЫМ, что соответствует "later overrides earlier" в существующем JSDoc.

- [ ] **Step 4: Проверить локально что тесты не сломались**

```bash
pnpm -F @1c-odata/cli exec vitest run test/unit/config.test.ts
```

Expected: все 14 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/config.ts
git commit -m "fix(cli): split .env/.env.local loading into explicit loadDotenv calls

c12@3.x dropped array support for dotenv.fileName — passing
{ fileName: ['.env', '.env.local'] } silently no-ops on Linux CI.
Use two explicit loadDotenv() calls so .env.local always overrides .env
regardless of c12 version. Test behaviour matches the JSDoc on
loadConfig().

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

**Alternative path** — если шаг 2 покажет что c12 массив поддерживает: тогда падение — другая причина (env var pollution в CI runner, кэш и т.п.). Зафиксировать в `beforeEach` теста явный `delete process.env.ONEC_FROM_DOTENV_URL` ДО `mkdtempSync` и проверить.

---

### Task 5: Conditional — диагностика cli `test:integration:offline` (exit code 2 на PASS)

**Skip this task if** Task 3 показал зелёный CI.

**Files:**
- Maybe modify: `packages/cli/vitest.config.ts`
- Maybe modify: `packages/cli/test/codegen/integration/setup.ts` (если есть)

**Context.** Из release run:
```
✓ test/codegen/integration/metadata-json-schema.test.ts (6 tests)
✓ test/codegen/integration/fixtures.test.ts (15 tests)
✓ test/codegen/integration/validate-on-write.test.ts (1 test)
✓ test/codegen/integration/maxlength-jsdoc.test.ts (2 tests)
✓ test/codegen/integration/enums.test.ts (3 tests)
ELIFECYCLE  Command failed.
```

Все тесты PASS, vitest exit ≠ 0. Признак — unfulfilled handle / unhandled rejection в teardown.

- [ ] **Step 1: Локально воспроизвести**

```bash
pnpm -F @1c-odata/cli exec vitest run test/codegen/integration --reporter=verbose
echo "Exit: $?"
```

Если локально `Exit: 0` — это CI-specific (Linux fs handle / FsWatcher). Если `Exit: 2` — точечно искать.

- [ ] **Step 2: Запустить с детектором leak**

```bash
pnpm -F @1c-odata/cli exec vitest run test/codegen/integration --no-file-parallelism --reporter=verbose 2>&1 | tail -50
```

Если появляется «open handles» секция — посмотреть тип.

- [ ] **Step 3: Скорее всего фикс — `pool: 'forks', isolate: true` в `vitest.config.ts`**

Прочитать `packages/cli/vitest.config.ts`. Если pool по дефолту (`threads`) — менять на forks: каждый test file в своём процессе, child exit чистит handles автоматически.

```typescript
// packages/cli/vitest.config.ts — пример правки
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        isolate: true,
        singleFork: false,
      },
    },
    // ... existing config
  },
})
```

NB: trade-off — forks медленнее threads. Для integration suite (5 файлов) приемлемо.

- [ ] **Step 4: Локальный re-run**

```bash
pnpm -F @1c-odata/cli exec vitest run test/codegen/integration
echo "Exit: $?"
```

Expected: `Exit: 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/vitest.config.ts
git commit -m "test(cli): switch integration suite to forks pool to flush handles

vitest with the default threads pool was leaving an open handle in CI
(possibly the fast-xml-parser worker), causing exit code 2 despite all
tests passing. forks pool spawns a child process per file so
process exit is clean.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Push фиксы, дождаться зелёного CI

**Files:** (no edits)

- [ ] **Step 1: Push накопившиеся коммиты**

```bash
git push
```

- [ ] **Step 2: Дождаться CI окончания**

```bash
gh run watch $(gh run list --branch chore/ci-fix-release-gates --workflow ci.yml --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

Expected exit code: 0 (зелёный). Если != 0 — вернуться к Task 4/5, перечитать stderr, итерировать.

- [ ] **Step 3: Финальная проверка статуса**

```bash
gh pr status 2>/dev/null || gh run list --branch chore/ci-fix-release-gates --workflow ci.yml --limit 1
```

Expected: ✓ green на `lint-and-typecheck`, `test-and-build` (обе матрицы ubuntu + windows). `detect-secrets`, `test-live`, `test-write`, `test-example` могут показаться pending/skipped — это OK (secrets ещё не настроены на `hacker-cb/1c-odata`).

---

## Self-Review

**1. Spec coverage:**
- Этап 1.1 (исключить examples из release CI gates) → Task 1 + 2 ✓
- Этап 1.2 (починить config.test.ts) → Task 4 (conditional) ✓
- Этап 1.3 (exit-code-2 в offline test) → Task 5 (conditional) ✓
- Push + verify зелёный CI → Task 3 + 6 ✓

**2. Placeholder scan:** Все «Maybe modify» — это conditional пути с явными trigger-conditions. Не пустые TBD, а условные ветки с описанным фиксом для каждой.

**3. Type consistency:** Не применимо — план оперирует только YAML workflow files и небольшим количеством TS. Sigнатуры из реального кода (`loadConfig`, `c12Load`, `loadDotenv`) проверены против фактического `packages/cli/src/config.ts`.

**Дополнительно:** план не делает спекулятивных правок «на всякий случай» — все 4-5 conditional блоки активируются только если CI на feature branch повторно покажет падение в той же области.
