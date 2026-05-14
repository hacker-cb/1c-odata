# Public release design — 1c-odata 0.1.0

**Статус**: approved
**Дата**: 2026-05-14
**Контекст**: репо `hacker-cb/1c-odata` создан, на нём только `master` (orphan, единственный коммит). Первый push в `master` запустил `release.yml` — упал на CI gates. До первой публикации в npm надо починить CI, заполнить package metadata, выложить README/LICENSE per-package, добавить changeset.

## Корневая проблема failed release run

`release.yml` запускает `pnpm turbo typecheck test:unit test:integration:offline build package:lint` — turbo без `--filter` обходит весь workspace (`pnpm-workspace.yaml` включает `packages/*` и `examples/*`).

Из лога `25859723187`: упало 3 задачи из 11.

1. **`basic-example#typecheck`** — `Cannot find module '@1c-odata/client'` в `src/demos/*.ts`. `examples/basic` — пример консьюмера, не должен быть в release CI gates вообще. Уже исключён из changesets (`.changeset/config.json` → `ignore: ["basic-example"]`), но turbo ignore не уважает.

2. **`@1c-odata/cli#test:unit`** — 2 теста в `test/unit/config.test.ts` (`auto-sources .env.local from cwd before evaluating config`, `.env.local overrides .env when both are present`). Тесты сами создают `.env`/`.env.local` в temp cwd и передают `loadConfig({ cwd: tmp })` — внешний `.env.local` им не нужен. Реальная причина (см. ниже) — гонка с `@1c-odata/cli#test:integration:offline` за общий процессный state (msw `setupServer` interception, `process.env`, OS tmpdir).

3. **`@1c-odata/cli#test:integration:offline`** — vitest exit code ≠ 0 при PASS всех тестов. Та же гонка с другой стороны.

**Корень пунктов 2-3.** На `release.yml` одна команда `pnpm turbo typecheck test:unit test:integration:offline build package:lint` запускала все 5 tasks параллельно под единым `^build` barrier — turbo планирует независимые tasks одного workspace в параллель. У `@1c-odata/cli` `test:unit` и `test:integration:offline` оба вызывают vitest на одном пакете, и параллельно дерутся за process-wide shared state. На `ci.yml` те же tasks идут отдельными шагами (`pnpm turbo test:unit` → `pnpm turbo test:integration:offline`) → последовательно, без гонки → зелёные на том же commit'е.

Фикс — две правки в `release.yml`: (а) `--filter='./packages/*'` (исключает `basic-example`), (б) разбить combined `pnpm turbo …` на отдельные `name:` шаги (mirror `ci.yml`).

## Архитектура решения — 3 этапа

Делим работу на три PR в `dev` → потом один общий PR `dev → master`. Альтернативу с одним мега-PR отбросил: каждый этап имеет независимое значение, при ревью смешивать их — повышать шум.

### Этап 1 — починка CI (блокер)

**1.1. Добавить `--filter='./packages/*'` ко всем turbo вызовам в `release.yml` и `ci.yml`.**

Включает (`ci.yml` jobs `lint-and-typecheck` + `test-and-build`, плюс `release.yml`):
- `pnpm turbo typecheck` → `pnpm turbo typecheck --filter='./packages/*'`
- `pnpm turbo test:unit` → `pnpm turbo test:unit --filter='./packages/*'`
- `pnpm turbo test:integration:offline` → `pnpm turbo test:integration:offline --filter='./packages/*'`
- `pnpm turbo build` → `pnpm turbo build --filter='./packages/*'`
- `pnpm turbo package:lint` → `pnpm turbo package:lint --filter='./packages/*'`
- `pnpm turbo test:e2e` → `pnpm turbo test:e2e --filter='./packages/*'`

`examples/basic` исключён из release/PR gates (паттерн совпадает с `pnpm-workspace.yaml`, где `packages/*` и `examples/*` уже разделены). Сам пример продолжает проверяться в выделенном `test-example` job под live секретами, который использует `pnpm --filter basic-example` напрямую.

Альтернативу с `turbo.json` `pipeline` исключением через workspace конфиг отбросил — менее explicit, сложнее найти при чтении workflow.

**1.2. Разбить combined `pnpm turbo …` в `release.yml` на отдельные `name:` шаги (mirror `ci.yml`).**

Это устраняет parallel-race между `@1c-odata/cli#test:unit` и `@1c-odata/cli#test:integration:offline`, описанную в разделе «Корень пунктов 2-3» выше. Содержательной правки тестов не требуется — гонка возникала именно из-за того, как turbo планировал tasks под одной командой.

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

| Риск | Митигация |
|---|---|
| `--filter='./packages/*'` на Windows ломает glob | turbo поддерживает glob нативно; протестировано в `ci.yml` matrix. Если ломается — fallback на explicit list `--filter=@1c-odata/client --filter=@1c-odata/cli`. |
| Tests 2-3 в этапе 1.2/1.3 окажутся flaky-on-CI-but-green-locally | Включить debug logs, запускать через `act` локально (GitHub Actions runner emulator). Если корень — `process.env.CI=true` change — изолировать через `beforeEach`. |
| Первый npm publish провалится (token scope недостаточен) | Granular token с явно выбранным scope `@1c-odata` + `Read and write` — стандартный минимум. Если не сработает — fallback на Automation token org-wide. |
| `changesets/action@v1` не найдёт changesets (ноль файлов в `.changeset/`) | Этап 3.1 явно создаёт `.changeset/initial.md`. |
| Push `dev` создаст orphan-like duplicate | Локальный `dev` уже unrelated history vs `master` (master orphan создан из dev state в один коммит без истории). При push `dev` на remote — это будет отдельная ветка с богатой историей dev, master — orphan один коммит. Norm. |

## Открытые вопросы

Ни одного — все решения согласованы.
