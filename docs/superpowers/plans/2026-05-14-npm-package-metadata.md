# PR 2: npm package metadata + per-package README/LICENSE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Подготовить `@1c-odata/client` и `@1c-odata/cli` к публикации в npm — заполнить недостающие поля `package.json` (description, keywords, repository, homepage, bugs, author, license, publishConfig) и положить per-package README + LICENSE, чтобы карточки на npmjs.com не были пустыми.

**Architecture:** Изменения чисто декларативные — никаких изменений в коде, только метаданные и текст для npmjs-страниц. Финальный gate — `pnpm turbo package:lint --filter='./packages/*'` (publint + attw), который сейчас зелёный, должен остаться зелёным после правок.

**Tech Stack:** `package.json` (npm schema), Markdown, publint 0.3.x, @arethetypeswrong/cli (attw).

**Spec:** [`docs/superpowers/specs/2026-05-14-public-release-design.md`](../specs/2026-05-14-public-release-design.md) (Этап 2).

---

### Task 1: `packages/client/package.json` metadata

**Files:**
- Modify: `packages/client/package.json`

**Текущее состояние** (из package.json — 47 строк):

```jsonc
{
  "name": "@1c-odata/client",
  "version": "0.0.0",
  "type": "module",
  "exports": { ... },          // 4 entry points: ., /filter, /internal, /package.json
  "sideEffects": false,
  "engines": { "node": ">=22.21.0" },
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": { ... },
  "devDependencies": { ... }
}
```

Отсутствуют: `description`, `keywords`, `author`, `license`, `repository`, `homepage`, `bugs`, `publishConfig`.

- [ ] **Step 1: Добавить поля metadata в `packages/client/package.json`**

Вставить блок ПОСЛЕ `"type": "module"` и ПЕРЕД `"exports"`:

```jsonc
  "description": "Type-safe OData V3 client for 1С:Enterprise 8 — query builder, filter DSL, register helpers.",
  "keywords": [
    "1c",
    "1c-enterprise",
    "odata",
    "odata-v3",
    "typescript",
    "client",
    "query-builder"
  ],
  "author": "Pavel Sokolov",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/hacker-cb/1c-odata.git",
    "directory": "packages/client"
  },
  "homepage": "https://github.com/hacker-cb/1c-odata#readme",
  "bugs": {
    "url": "https://github.com/hacker-cb/1c-odata/issues"
  },
  "publishConfig": {
    "access": "public",
    "provenance": true
  },
```

Замечание: в `client/package.json` сейчас `name`, `version`, `type` идут первыми; затем `exports`. Стандартный порядок npm field'ов — `name → version → description → keywords → author → license → repository → homepage → bugs → main/exports → ...`. Использую этот порядок, чтобы карточка npm рендерилась предсказуемо.

- [ ] **Step 2: Локальный smoke-test (lint + публикационная проверка)**

```bash
pnpm turbo package:lint --filter='@1c-odata/client'
```

Expected: `🟢 (ESM)` во всех строках matrix table; `No problems found 🌟`.

Если появится warning от publint про missing fields (например, `"main"` нужно для legacy resolvers) — добавить рекомендованное поле. На текущей конфигурации (только `"exports"`, ESM-only, node ≥22) publint ничего не требует — был зелёный до правок.

- [ ] **Step 3: Commit**

```bash
git add packages/client/package.json
git commit -m "feat(client): add npm publication metadata

description, keywords, author, license, repository, homepage, bugs,
and publishConfig — required for the v0.1.0 publish PR (Stage 3 of the
public release).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `packages/cli/package.json` metadata

**Files:**
- Modify: `packages/cli/package.json`

**Текущее состояние** (из package.json — 55 строк): уже есть `description`, `license`, `publishConfig.access`. Отсутствуют: `keywords`, `author`, `repository`, `homepage`, `bugs`. И стоит расширить `description` + добавить `provenance` в `publishConfig`.

- [ ] **Step 1: Заменить `description`**

Сейчас:
```jsonc
  "description": "CLI for 1c-odata: fetch metadata + generate TypeScript types",
```

Заменить на (уточнение про привязку к `@1c-odata/client`, формат как у крупных tooling-CLI):
```jsonc
  "description": "CLI for @1c-odata/client: fetch 1С EDMX metadata and generate TypeScript types.",
```

- [ ] **Step 2: Добавить недостающие metadata после `description`**

Вставить ПОСЛЕ `"description": "..."` и ПЕРЕД `"license": "MIT"`:

```jsonc
  "keywords": [
    "1c",
    "1c-enterprise",
    "odata",
    "odata-v3",
    "typescript",
    "codegen",
    "cli"
  ],
  "author": "Pavel Sokolov",
```

`license` остаётся на своём месте (уже есть).

- [ ] **Step 3: Добавить `repository`, `homepage`, `bugs` после `license`**

Вставить ПОСЛЕ `"license": "MIT"` и ПЕРЕД `"type": "module"`:

```jsonc
  "repository": {
    "type": "git",
    "url": "git+https://github.com/hacker-cb/1c-odata.git",
    "directory": "packages/cli"
  },
  "homepage": "https://github.com/hacker-cb/1c-odata#readme",
  "bugs": {
    "url": "https://github.com/hacker-cb/1c-odata/issues"
  },
```

- [ ] **Step 4: Расширить `publishConfig` — добавить `provenance`**

Сейчас в конце:
```jsonc
  "publishConfig": {
    "access": "public"
  }
```

Заменить на:
```jsonc
  "publishConfig": {
    "access": "public",
    "provenance": true
  }
```

- [ ] **Step 5: Smoke-test**

```bash
pnpm turbo package:lint --filter='@1c-odata/cli'
```

Expected: те же зелёные ✓ — `No problems found 🌟`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/package.json
git commit -m "feat(cli): fill npm publication metadata

keywords, author, repository, homepage, bugs; tighten description to
explicitly link to @1c-odata/client; add provenance:true to
publishConfig (the release workflow already sets NPM_CONFIG_PROVENANCE=true
but mirroring intent in package.json keeps it discoverable).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `packages/client/README.md`

**Files:**
- Create: `packages/client/README.md`

**Цель.** Карточка на `npmjs.com/package/@1c-odata/client` сейчас будет пустая (нет README — npm рендерит «нет описания»). Создаём фокусный per-package README — 1-2 кратких параграфа, install, минимальный example, ссылки на repo / STABILITY.

Не дублируем root README — то слишком длинное для package page и пользователь обычно хочет «как сразу подключить».

- [ ] **Step 1: Создать `packages/client/README.md`**

```markdown
# @1c-odata/client

Typed runtime for the 1С:Enterprise OData V3 interface — `ODataV3Client`, query builder, filter DSL, value-storage helpers, and register helpers.

Server-side only. Pure ESM. Node ≥ 22.21.

> ⚠️ **v0.x — pre-release.** API is unstable; see [STABILITY.md](https://github.com/hacker-cb/1c-odata/blob/master/STABILITY.md).

## Install

```bash
pnpm add @1c-odata/client
pnpm add -D @1c-odata/cli   # generates types from $metadata
```

## Quick start

```ts
import { clientOptionsFromConnection, ODataV3Client } from '@1c-odata/client'
import { and, any } from '@1c-odata/client/filter'
import type { Document_РТУ } from '../generated/trade/index.js'
import config from '../1c-odata.config.js'

const trade = new ODataV3Client(clientOptionsFromConnection(config.connections.trade!))

const { value: docs } = await trade
  .query<Document_РТУ>('Document_РТУ')
  .filter((f) => and(f.Date.year().eq(2025), any(f.Товары, (t) => t.Сумма.gt(10000))))
  .top(50)
  .get()
```

See [`examples/basic`](https://github.com/hacker-cb/1c-odata/tree/master/examples/basic) for a runnable end-to-end consumer, and [the repo README](https://github.com/hacker-cb/1c-odata#readme) for project-wide setup (network config, cross-platform Cyrillic filename handling, codegen flow).

## License

[MIT](./LICENSE)
```

NB: ссылки идут на абсолютные URLs на github (`https://github.com/hacker-cb/1c-odata/...`) — потому что относительные ссылки на npmjs.com резолвятся относительно файла в tarball, не GitHub.

- [ ] **Step 2: Commit**

```bash
git add packages/client/README.md
git commit -m "docs(client): add per-package README for npm page

Without this the @1c-odata/client npmjs.com page renders 'no description'.
Keeps the README focused — install, one quick-start snippet, links to
repo README / STABILITY / examples — instead of duplicating the root
README which is too long for an npm card.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `packages/cli/README.md`

**Files:**
- Create: `packages/cli/README.md`

- [ ] **Step 1: Создать `packages/cli/README.md`**

```markdown
# @1c-odata/cli

Two binaries for [`@1c-odata/client`](https://www.npmjs.com/package/@1c-odata/client):

- `1c-odata fetch` — downloads `$metadata` (EDMX) from a 1С:Enterprise OData V3 endpoint and saves it locally.
- `1c-odata generate` — generates TypeScript types from the saved EDMX (per-connection output under `generated/<connection>/`).

Codegen library is also exposed at [`@1c-odata/cli/codegen`](https://github.com/hacker-cb/1c-odata/tree/master/packages/cli/src/codegen) for programmatic use.

Pure ESM. Node ≥ 22.21.

> ⚠️ **v0.x — pre-release.** API is unstable; see [STABILITY.md](https://github.com/hacker-cb/1c-odata/blob/master/STABILITY.md).

## Install

```bash
pnpm add -D @1c-odata/cli @1c-odata/client
```

## Quick start

`1c-odata.config.ts`:

```ts
import { defineConfig, parseConnectionUrl } from '@1c-odata/client'

const url = process.env.ONEC_URL
if (!url) throw new Error('Set ONEC_URL (format: http://user:pwd@host/path)')

export default defineConfig({
  connections: {
    trade: {
      ...parseConnectionUrl(url),
      serverTimezone: 'Europe/Moscow',
      codegen: { include: ['Catalog_*', 'Document_*'] },
    },
  },
})
```

Fetch + generate:

```bash
export ONEC_URL=http://u:p@1c.example.com/odata/standard.odata
pnpm 1c-odata fetch
pnpm 1c-odata generate
```

See [the repo README](https://github.com/hacker-cb/1c-odata#readme) for project-wide setup and [`examples/basic`](https://github.com/hacker-cb/1c-odata/tree/master/examples/basic) for a runnable consumer.

## License

[MIT](./LICENSE)
```

- [ ] **Step 2: Commit**

```bash
git add packages/cli/README.md
git commit -m "docs(cli): add per-package README for npm page

Same rationale as the client README — keeps the npm card useful and
focused without duplicating the root README.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: per-package `LICENSE`

**Files:**
- Create: `packages/client/LICENSE`
- Create: `packages/cli/LICENSE`

`files: ["dist", "README.md", "LICENSE"]` в обоих package.json уже декларирует LICENSE — но физически файл отсутствует в каждом пакете. npm pack ИХ молча пропустит (warning), и tarball уйдёт без LICENSE.

Используем физическую копию (не symlink) ради кросс-платформенности (Windows NTFS / git working-tree).

- [ ] **Step 1: Скопировать root LICENSE в оба пакета**

```bash
cp LICENSE packages/client/LICENSE
cp LICENSE packages/cli/LICENSE
```

Содержимое (после копирования; sanity-check):
```
MIT License

Copyright (c) 2026 Pavel Sokolov

Permission is hereby granted, free of charge, to any person obtaining a copy
... (стандартный MIT текст)
```

- [ ] **Step 2: Verify**

```bash
ls -la packages/client/LICENSE packages/cli/LICENSE
diff LICENSE packages/client/LICENSE
diff LICENSE packages/cli/LICENSE
```

Expected: оба файла размером ~1.1 KB; оба diff'а пустые (содержимое identical).

- [ ] **Step 3: Smoke-test package:lint**

```bash
pnpm turbo package:lint --filter='./packages/*'
```

Expected: `🟢` строки и `No problems found 🌟` обоим пакетам. Когда LICENSE присутствует физически — publint должен быть чище (он флагает несоответствие `files` и реального состава tarball).

- [ ] **Step 4: Commit**

```bash
git add packages/client/LICENSE packages/cli/LICENSE
git commit -m "chore: add per-package LICENSE files

Each package.json already declares LICENSE in 'files', but the physical
file was missing — npm pack would emit a warning and ship a tarball
without a license. Plain copy (not symlink) keeps it cross-platform.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Финальная локальная верификация

**Files:** (no edits)

- [ ] **Step 1: Запустить весь CI gate set локально (как делает `release.yml` после Stage 1)**

```bash
pnpm turbo typecheck test:unit test:integration:offline build package:lint --filter='./packages/*'
```

Expected: 10 tasks (по 5 на каждый пакет) — все ✓, `>>> FULL TURBO` где cache hit.

- [ ] **Step 2: Дополнительная проверка структуры tarball**

```bash
pnpm -F @1c-odata/client pack --dry-run 2>&1 | grep -E "(LICENSE|README|package.json|\.js$|\.d\.ts$)" | head
pnpm -F @1c-odata/cli pack --dry-run 2>&1 | grep -E "(LICENSE|README|package.json|\.js$|\.d\.ts$)" | head
```

Expected: каждый tarball содержит `LICENSE`, `README.md`, `package.json`, `dist/*.js`, `dist/*.d.ts`. Не должно быть `src/`, `test/`, `tsconfig*.json`, `vitest.config.ts` — `files` уже их фильтрует.

Если что-то лишнее или недостаёт — поправить `files` массив (он сейчас `["dist", "README.md", "LICENSE"]` — должно быть достаточно).

---

### Task 7: Push feature branch + PR

**Files:** (no edits)

- [ ] **Step 1: Push**

```bash
git push -u origin chore/npm-package-metadata
```

- [ ] **Step 2: Open PR в `master`**

```bash
gh pr create --repo hacker-cb/1c-odata --base master --title "chore: npm package metadata + per-package README/LICENSE (Stage 2 of public release)" --body "..."
```

PR body шаблон:
```markdown
## Summary

Stage 2 of public release prep (spec: `docs/superpowers/specs/2026-05-14-public-release-design.md`).

Fills the npm publication metadata for both packages so that the v0.1.0 publish (Stage 3) produces useful npm pages:

- `@1c-odata/client`: adds description, keywords, author, license, repository, homepage, bugs, publishConfig (access:public, provenance:true).
- `@1c-odata/cli`: fills the same set (description was present but bare; tightened to reference @1c-odata/client explicitly); provenance added.
- Per-package `README.md` (focused npm cards, not a duplicate of the root README).
- Per-package `LICENSE` (physical copy of the root LICENSE; the `files` array already declared it).

No code changes. `pnpm turbo package:lint` was green before this PR and stays green after.

## Test plan

- [ ] `pnpm turbo package:lint --filter='./packages/*'` green on Linux and Windows matrix.
- [ ] `pnpm pack --dry-run` for both packages includes LICENSE + README.md.
- [ ] CI on this PR is green.
- [ ] Manual visual review of how the two README's render on GitHub (relative URLs are intentionally absolute https links so they also work on npmjs.com).
```

- [ ] **Step 3: Дальше — `shipping-github-prs` skill** (CI watch, Copilot, merge gate).

---

## Self-Review

**1. Spec coverage:**
- Этап 2.1 (client/package.json metadata) → Task 1 ✓
- Этап 2.2 (cli/package.json metadata) → Task 2 ✓
- Этап 2.3 (per-package README) → Tasks 3 + 4 ✓
- Этап 2.4 (per-package LICENSE) → Task 5 ✓
- Этап 2.5 (local pnpm turbo package:lint) → Task 6 ✓
- Ship → Task 7 ✓

**2. Placeholder scan:** Все code blocks содержат конкретные значения, никаких "TBD". PR body шаблон содержит `...` — но только внутри подсказки на `gh pr create`, где multi-line строка имеет смысл собирать из контекста результата tasks.

**3. Type consistency:** Не применимо (нет TS-сигнатур, только JSON и Markdown).

**Дополнительная проверка:** Перепроверил порядок keys в client/package.json — `description` идёт ПОСЛЕ `type` чтобы не разбить смысловой блок `name/version/type` (current state). По npm convention пишут `name → version → description`, но менять текущий `name → version → type → description` ради ремоут convention — лишняя инвазивность.
