import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MetadataIndex } from '@1c-odata/client'
import { MINIMALMETADATA_JSON, NOMETADATA_JSON, readFormat, typeNameOfSet } from '@1c-odata/client/internal'
import { describe, expect, it } from 'vitest'
import { buildMetadataIndex, parseEdmx } from '../../src/index.js'

// #289 on the real EDMX: only a read whose reply carries a ValueStorage asks 1С for minimalmetadata — the sets
// measured on the live bases, both ways.
const here = dirname(fileURLToPath(import.meta.url))
const snapshotsDir = resolve(here, '../../../../snapshots')

const CASES = [
  {
    file: 'trade_v11.5.xml',
    storage: { set: 'Catalog_ВариантыАнализаЦелевыхПоказателей', base: 'ЗначениеАнализа' },
    tabular: { set: 'Document_ПланПродаж', part: 'Товары', base: 'ДополнительныеПараметры' },
    none: [
      'Document_РеализацияТоваровУслуг',
      'InformationRegister_КурсыВалют',
      'AccumulationRegister_ДвиженияДенежныеСредстваКонтрагент_RecordType',
      'AccumulationRegister_ТоварыНаСкладах/Balance()',
    ],
  },
  {
    file: 'bp_v3.0.xml',
    storage: { set: 'Catalog_ПравилаПроверкиУчета', base: 'ДополнительныеПараметры' },
    none: [
      'Document_РеализацияТоваровУслуг',
      'InformationRegister_КурсыВалют',
      'AccumulationRegister_РасчетыПоЕдиномуНалоговомуСчету_RecordType',
      'AccountingRegister_Хозрасчетный/Balance()',
    ],
  },
]

describe('integration: readFormat over the snapshot indexes (#289)', () => {
  for (const c of CASES) {
    describe(c.file, () => {
      const index: MetadataIndex = buildMetadataIndex(parseEdmx(readFileSync(resolve(snapshotsDir, c.file), 'utf8')))
      const typeOf = (set: string) => typeNameOfSet(index, set)

      it('reads a set with a storage in minimalmetadata — a whole row, its base or a half selected', () => {
        const type = typeOf(c.storage.set)
        expect(index.schemas[type ?? '']?.valueStorages).toContain(c.storage.base)
        expect(readFormat(index, type)).toBe(MINIMALMETADATA_JSON)
        expect(readFormat(index, type, { select: ['Ref_Key', c.storage.base] })).toBe(MINIMALMETADATA_JSON)
        expect(readFormat(index, type, { select: [`${c.storage.base}_Base64Data`] })).toBe(MINIMALMETADATA_JSON)
        expect(readFormat(index, type, { select: ['Ref_Key'] })).toBe(NOMETADATA_JSON)
      })

      it('reads a document whose tabular rows carry a storage in minimalmetadata (#290)', () => {
        if (!('tabular' in c) || c.tabular === undefined) return
        const { set, part, base } = c.tabular
        const type = typeOf(set)
        expect(readFormat(index, type)).toBe(MINIMALMETADATA_JSON)
        expect(readFormat(index, type, { select: ['Ref_Key', `${part}/${base}`] })).toBe(MINIMALMETADATA_JSON)
        expect(readFormat(index, type, { select: ['Ref_Key', 'Date'] })).toBe(NOMETADATA_JSON)
      })

      it('leaves documents, registers and virtual tables without storages in nometadata', () => {
        for (const set of c.none) expect(readFormat(index, typeOf(set)), set).toBe(NOMETADATA_JSON)
      }, 60_000)
    })
  }
})
