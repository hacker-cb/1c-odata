# Public release design — 1c-odata 0.1.0

**Статус**: approved
**Дата**: 2026-05-14
**Контекст**: репо `hacker-cb/1c-odata` создан, на нём только `master` (orphan, единственный коммит). Первый push в `master` запустил `release.yml` — упал на CI gates. До первой публикации в npm надо починить CI, заполнить package metadata, выложить README/LICENSE per-package, добавить changeset.

## Корневая проблема failed release run

`release.yml` запускает `pnpm turbo typecheck test:unit test:integration:offline build package:lint` — turbo без `--filter` обходит весь workspace (`pnpm-workspace.yaml` включает `packages/*` и `examples/*`).

Из лога `25859723187`: упало 3 задачи из 11.

1. **`basic-example#typecheck`** — `Cannot find module '@1c-odata/client'` в `src/demos/*.ts`. Главный блокер. `examples/basic` — пример консьюмера, не должен быть в release CI gates вообще. Уже исключён из changesets (`.changeset/config.json` → `ignore: ["basic-example"]`), но turbo ignore не уважает.

2. **`@1c-odata/cli#test:unit`** — 2 теста в `test/unit/config.test.ts` (`auto-sources .env.local from cwd before evaluating config`, `.env.local overrides .env when both are present`). Зависят от cwd / окружения. На CI runner без `.env.local` ожидание не сходится.

3. **`@1c-odata/cli#test:integration:offline`** — vitest exit code ≠ 0 при PASS всех тестов. Похоже на handle leak в teardown / unresolved process exit.

Пункты 2-3 могли быть pre-existing на dev (просто новый чистый репо без turbo cache их вскрыл) — нужно проверить, упал ли `ci.yml` на том же commit'е. Независимо от исхода — все три починить до релиза, иначе `changesets/action@v1` не дойдёт до publish step.

## Архитектура решения — 3 этапа

Делим работу на три PR в `dev` → потом один общий PR `dev → master`. Альтернативу с одним мега-PR отбросил: каждый этап имеет независимое значение, при ревью смешивать их — повышать шум.

### Этап 1 — починка CI (блокер)

**1.1. Исключить `examples/*` из release CI gates.**

В `.github/workflows/release.yml` и `.github/workflows/ci.yml` (job `lint-and-typecheck` + `test-and-build`) поменять команды turbo на форму с `--filter='./packages/*'`. Examples проверяются отдельно в `test-example` job (под live секретами) — он уже использует `pnpm --filter basic-example`, паттерн совпадает.

Конкретно меняется:
- `pnpm turbo typecheck` → `pnpm turbo typecheck --filter='./packages/*'`
- `pnpm turbo test:unit` → `pnpm turbo test:unit --filter='./packages/*'`
- `pnpm turbo test:integration:offline` → `pnpm turbo test:integration:offline --filter='./packages/*'`
- `pnpm turbo build` → `pnpm turbo build --filter='./packages/*'`
- `pnpm turbo package:lint` → `pnpm turbo package:lint --filter='./packages/*'`
- `pnpm turbo test:e2e` → `pnpm turbo test:e2e --filter='./packages/*'`

Альтернативу с `turbo.json` `pipeline` исключением через workspace конфиг отбросил — менее explicit, сложнее найти при чтении workflow.

**1.2. Починить `cli/test/unit/config.test.ts` (.env.local тесты).**

Подход: `systematic-debugging`. Сначала локально воспроизвести — `pnpm -F @1c-odata/cli vitest run test/unit/config.test.ts`. Если зелёный локально — значит зависимость от внешнего `.env.local` в repo root (он gitignored, но локально у Pavel'а присутствует — попадает в process.env через какую-то связку). Корректировка теста: явно изолировать cwd / `process.env` в `beforeEach/afterEach`, не полагаться на отсутствие `.env.local` сверху.

**1.3. Починить exit-code-2 в `cli/test/integration:offline`.**

Скорее всего unfulfilled promise / open handle. Вариант: запустить с `--reporter=verbose --no-file-parallelism` и `process._getActiveHandles()` в teardown. Если handle leak — закрыть. Если ошибка в process.exit hook — починить.

### Этап 2 — npm metadata + per-package README/LICENSE

**2.1. `packages/client/package.json`** — добавить:

```json
{
  "description": "Type-safe OData V3 client for 1С:Enterprise 8 — query builder, filter DSL, register helpers.",
  "keywords": ["1c", "1c-enterprise", "odata", "odata-v3", "typescript", "client"],
  "author": "Pavel Sokolov",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/hacker-cb/1c-odata.git",
    "directory": "packages/client"
  },
  "homepage": "https://github.com/hacker-cb/1c-odata#readme",
  "bugs": { "url": "https://github.com/hacker-cb/1c-odata/issues" },
  "publishConfig": { "access": "public", "provenance": true }
}
```

**2.2. `packages/cli/package.json`** — добавить недостающие keywords/repository/homepage/bugs/author. `description` уже есть, расширить до:

```
"CLI for @1c-odata/client: fetch 1С EDMX metadata and generate TypeScript types."
```

И в `publishConfig` добавить `"provenance": true`.

**2.3. README per-package.** Создать `packages/client/README.md` и `packages/cli/README.md`. Каждый — самостоятельный, ориентированный на npmjs страницу:

- что делает пакет (1-2 предложения)
- install
- quick start (короткий пример)
- ссылка на root [README](https://github.com/hacker-cb/1c-odata#readme) и [STABILITY.md](https://github.com/hacker-cb/1c-odata/blob/master/STABILITY.md)

Не дублировать root README — то излишне.

**2.4. LICENSE per-package.** Скопировать root `LICENSE` в `packages/client/LICENSE` и `packages/cli/LICENSE`. Физические файлы (не symlinks — кросс-платформа: Windows / NTFS). В `.gitignore` они НЕ должны попасть.

**2.5. Проверка локально.**

```bash
pnpm turbo build --filter='./packages/*'
pnpm turbo package:lint --filter='./packages/*'   # publint + attw
```

publint должен пройти без warnings. attw — может ругаться на `cjs-resolves-to-esm` (уже игнорируется флагом). Если новые warnings — исправлять перед PR.

### Этап 3 — первый релиз

**3.1. Создать `.changeset/initial.md`:**

```markdown
---
"@1c-odata/client": minor
"@1c-odata/cli": minor
---

Initial public release (0.1.0). API is pre-1.0 and unstable — see STABILITY.md.
```

`linked: [["@1c-odata/client", "@1c-odata/cli"]]` в config гарантирует синхронность версий.

**3.2. Push `dev` на новый remote.** Сейчас на remote есть только `master`. Дев нужен как integration branch — без него последующие PR некуда направлять.

```bash
git remote prune origin   # уберёт stale tvip refs локально
git push -u origin dev
```

Default branch — `dev` (через GitHub UI или `gh repo edit --default-branch dev`).

**3.3. Открыть PR `dev → master`** с этапами 1-3. После approval & merge — push в master запустит `release.yml`.

**3.4. NPM credentials.** До merge PR'а в master:

- На npmjs.com создать Granular Access Token: scope `@1c-odata`, permission `Read and write`, expiration 30 дней.
- В `hacker-cb/1c-odata` Settings → Secrets and variables → Actions → New repository secret → `NPM_TOKEN` = (значение).

**3.5. Первая публикация.** Push в master → `release.yml`:
- CI gates пройдут (этапы 1-3 их починили).
- `changesets/action@v1` увидит pending changeset, откроет «chore: release packages» PR с bump до `0.1.0` обоих пакетов + CHANGELOG.md в каждом.
- Merge того PR → новый push в master → release.yml снова → теперь `changesets/action@v1` НЕ видит pending changesets, выполняет `pnpm changeset publish` → npm publish с provenance.

**3.6. После первой публикации.**

- На npmjs.com на каждом пакете (`@1c-odata/client`, `@1c-odata/cli`) → Settings → Trusted Publishers → Add → GitHub Actions:
  - repo: `hacker-cb/1c-odata`
  - workflow: `release.yml`
  - environment: (пусто)
- В `hacker-cb/1c-odata` отозвать секрет `NPM_TOKEN` (Settings → Actions → удалить).
- В `release.yml` step «Create Release Pull Request or Publish to npm» удалить `NPM_TOKEN: ${{ secrets.NPM_TOKEN }}` (provenance + OIDC через `id-token: write` уже на месте).

**3.7. Branch protection** на `master` через GitHub UI: require PR, require status checks (CI), no force-push, no deletion. Pavel'у — делать руками.

## Не входит в scope

- **Документирование API surface** (separate concern, в `STABILITY.md` уже есть skeleton). Дописывать — после первого релиза, когда видны реальные questions от консьюмеров.
- **Bun/Deno compatibility** — Node 22+ only заявлено, не трогаем.
- **Docs site (Astro/Docusaurus)** — README + JSDoc canonical. Сайт — отдельная задача, не блокер.
- **CI: Trusted Publishing на первом релизе.** Невозможно: trusted publishing настраивается в UI npmjs.com **после** создания пакета. Первый релиз обязан идти через классический token. Переключение — этап 3.6.
- **`feedback_strategic_recommendations`**: смотрел, нужно ли переименовать `dist/` → `lib/` или `_internal` → `private` для long-term — нет, текущая схема (`/internal` subpath, `@internal` JSDoc) уже задокументирована в STABILITY.md, не меняем.

## Риски и решения

| Риск | Митigation |
|---|---|
| `--filter='./packages/*'` на Windows ломает glob | turbo поддерживает glob нативно; протестировано в `ci.yml` matrix. Если ломается — fallback на explicit list `--filter=@1c-odata/client --filter=@1c-odata/cli`. |
| Tests 2-3 в этапе 1.2/1.3 окажутся flaky-on-CI-but-green-locally | Включить debug logs, запускать через `act` локально (GitHub Actions runner emulator). Если корень — `process.env.CI=true` change — изолировать через `beforeEach`. |
| Первый npm publish провалится (token scope недостаточен) | Granular token с явно выбранным scope `@1c-odata` + `Read and write` — стандартный минимум. Если не сработает — fallback на Automation token org-wide. |
| `changesets/action@v1` не найдёт changesets (ноль файлов в `.changeset/`) | Этап 3.1 явно создаёт `.changeset/initial.md`. |
| Push `dev` создаст orphan-like duplicate | Локальный `dev` уже unrelated history vs `master` (master orphan создан из dev state в один коммит без истории). При push `dev` на remote — это будет отдельная ветка с богатой историей dev, master — orphan один коммит. Norm. |

## Открытые вопросы

Ни одного — все решения согласованы.
