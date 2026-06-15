import { KIND_ORDER } from '@1c-odata/metadata'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ConnectionPool } from '../connection-pool.js'
import { clampTop, type Limits } from '../limits.js'
import { fitRows } from '../rows.js'
import { toolResult } from './_result.js'
import { describeEntity, selectEntities } from './schema-logic.js'

/** Register the read-only schema-introspection tools. */
export function registerSchemaTools(server: McpServer, pool: ConnectionPool, limits: Limits): void {
  server.registerTool(
    'list_connections',
    {
      title: 'List connections',
      description:
        'List configured 1С OData connections (name, base URL, login, timezone, where the password is stored). Never returns passwords.',
      inputSchema: {},
    },
    async () =>
      toolResult(async () => {
        const connections = await pool.list()
        const summary =
          connections.length === 0
            ? 'No connections configured. Add one in a terminal: 1c-odata-mcp add'
            : `${connections.length} connection(s): ${connections.map((c) => c.name).join(', ')}`
        return { summary, data: { connections } }
      }),
  )

  server.registerTool(
    'refresh_metadata',
    {
      title: 'Refresh metadata',
      description:
        'Drop the cached $metadata for a connection and re-download it. Use after the 1С configuration changed.',
      inputSchema: { connection: z.string().describe('Connection name (see list_connections)') },
    },
    async ({ connection }) =>
      toolResult(async () => {
        pool.refresh(connection)
        const entry = await pool.get(connection)
        const entitySets = Object.keys(entry.index.entitySetToType).length
        const entityTypes = Object.keys(entry.index.schemas).length
        return {
          summary: `Reloaded "${connection}": ${entityTypes} entity types, ${entitySets} entity sets.`,
          data: { connection, schemaNamespace: entry.index.schemaNamespace, entityTypes, entitySets },
        }
      }),
  )

  server.registerTool(
    'list_entities',
    {
      title: 'List entities',
      description: `List entity sets of a 1С base, optionally filtered by kind and a name substring. Kinds: ${KIND_ORDER.join(', ')}. Paginated via top/skip.`,
      inputSchema: {
        connection: z.string().describe('Connection name'),
        kind: z
          .enum(KIND_ORDER as unknown as [string, ...string[]])
          .optional()
          .describe('Filter by 1С entity kind'),
        name: z.string().optional().describe('Case-insensitive substring matched against the entity-set or short name'),
        top: z.number().int().optional().describe('Max rows to return this page (server-capped; omit for the default)'),
        skip: z.number().int().min(0).optional().describe('Offset for pagination (default 0)'),
      },
    },
    async ({ connection, kind, name, top, skip }) =>
      toolResult(async () => {
        const entry = await pool.get(connection)
        const matched = selectEntities(entry.index, { kind, name })

        const offset = skip ?? 0
        const limit = clampTop(top, limits)
        const page = matched.slice(offset, offset + limit)
        const { rows: shown, truncated } = fitRows(page, limits.maxBytes)
        return {
          summary: `${matched.length} entity set(s) matched; returning ${shown.length} (skip ${offset}, top ${limit})${truncated ? ' — truncated to the byte budget' : ''}.`,
          data: {
            connection,
            total: matched.length,
            skip: offset,
            top: limit,
            returned: shown.length,
            truncated,
            hasMore: truncated || offset + page.length < matched.length,
            entities: shown,
          },
        }
      }),
  )

  server.registerTool(
    'describe_entity',
    {
      title: 'Describe entity',
      description:
        'Describe one entity: properties (name/type/nullable/maxLength), keys, navigation properties, value storages and kind. Accepts an entity-set name or an entity-type name.',
      inputSchema: {
        connection: z.string().describe('Connection name'),
        entity: z.string().describe('Entity-set name (e.g. Catalog_Валюты) or entity-type name'),
      },
    },
    async ({ connection, entity }) =>
      toolResult(async () => {
        const { index, edmx } = await pool.get(connection)
        const described = describeEntity(index, edmx, entity)
        return {
          summary: `${described.entityType} (${described.kind ?? 'unknown kind'}): ${described.properties.length} properties, ${described.keys.length} key(s), ${described.navigationProperties.length} navigation property(ies).`,
          data: { connection, ...described },
        }
      }),
  )

  server.registerTool(
    'list_enums',
    {
      title: 'List enums',
      description: 'List enumeration types and their members, optionally filtered by a name substring.',
      inputSchema: {
        connection: z.string().describe('Connection name'),
        name: z.string().optional().describe('Case-insensitive substring matched against the enum name'),
      },
    },
    async ({ connection, name }) =>
      toolResult(async () => {
        const entry = await pool.get(connection)
        const needle = name?.toLowerCase()
        const items = Object.entries(entry.index.enums ?? {})
          .filter(([enumName]) => (needle === undefined ? true : enumName.toLowerCase().includes(needle)))
          .map(([enumName, def]) => ({ name: enumName, underlyingType: def.underlyingType, members: def.members }))
          .sort((a, b) => a.name.localeCompare(b.name))
        const { rows: shown, truncated } = fitRows(items, limits.maxBytes)
        return {
          summary: `${items.length} enum(s)${truncated ? `; returning ${shown.length} (truncated to the byte budget — filter by name)` : ''}.`,
          data: { connection, total: items.length, returned: shown.length, truncated, enums: shown },
        }
      }),
  )
}
