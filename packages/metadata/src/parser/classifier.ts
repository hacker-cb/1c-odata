/** One of the 14 canonical 1C OData entity kinds. */
export type Kind =
  | 'catalog'
  | 'constant'
  | 'document'
  | 'information-register'
  | 'accumulation-register'
  | 'exchange-plan'
  | 'chart-of-characteristic-types'
  | 'document-journal'
  | 'business-process'
  | 'task'
  | 'chart-of-accounts'
  | 'chart-of-calculation-types'
  | 'calculation-register'
  | 'accounting-register'

/** Stable order — matches the file structure in spec §5.1. */
export const KIND_ORDER: readonly Kind[] = [
  'catalog',
  'constant',
  'document',
  'information-register',
  'accumulation-register',
  'exchange-plan',
  'chart-of-characteristic-types',
  'document-journal',
  'business-process',
  'task',
  'chart-of-accounts',
  'chart-of-calculation-types',
  'calculation-register',
  'accounting-register',
] as const

export const KIND_TO_FOLDER: Record<Kind, string> = {
  catalog: 'catalogs',
  constant: 'constants',
  document: 'documents',
  'information-register': 'information-registers',
  'accumulation-register': 'accumulation-registers',
  'exchange-plan': 'exchange-plans',
  'chart-of-characteristic-types': 'chart-of-characteristic-types',
  'document-journal': 'document-journals',
  'business-process': 'business-processes',
  task: 'tasks',
  'chart-of-accounts': 'chart-of-accounts',
  'chart-of-calculation-types': 'chart-of-calculation-types',
  'calculation-register': 'calculation-registers',
  'accounting-register': 'accounting-registers',
}

const PREFIX_TO_KIND: [string, Kind][] = [
  ['Catalog_', 'catalog'],
  ['Constant_', 'constant'],
  ['Document_', 'document'],
  ['InformationRegister_', 'information-register'],
  ['AccumulationRegister_', 'accumulation-register'],
  ['ExchangePlan_', 'exchange-plan'],
  ['ChartOfCharacteristicTypes_', 'chart-of-characteristic-types'],
  ['DocumentJournal_', 'document-journal'],
  ['BusinessProcess_', 'business-process'],
  ['Task_', 'task'],
  ['ChartOfAccounts_', 'chart-of-accounts'],
  ['ChartOfCalculationTypes_', 'chart-of-calculation-types'],
  ['CalculationRegister_', 'calculation-register'],
  ['AccountingRegister_', 'accounting-register'],
]

export function classifyEntity(entityTypeName: string): Kind | null {
  for (const [prefix, kind] of PREFIX_TO_KIND) {
    if (entityTypeName.startsWith(prefix)) return kind
  }
  return null
}

/** Strip the kind prefix from a fully qualified entity name. */
export function tailName(entityTypeName: string): string {
  const i = entityTypeName.indexOf('_')
  return i < 0 ? entityTypeName : entityTypeName.slice(i + 1)
}
