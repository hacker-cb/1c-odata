import { KIND_ORDER } from '@1c-odata/metadata'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ConnectionPool } from '../connection-pool.js'
import { clampTop } from '../limits.js'
import { toolResult } from './_result.js'
import { describeEntity, selectEntities } from './schema-logic.js'

/** Register the read-only schema-introspection tools. */
export function registerSchemaTools(server: McpServer, pool: ConnectionPool): void {
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
          .string()
          .optional()
          .describe(`Filter by 1С entity kind (one of: ${KIND_ORDER.join(', ')})`),
        name: z.string().optional().describe('Case-insensitive substring matched against the entity-set or short name'),
        top: z.number().int().optional().describe('Page size (default 50, max 1000)'),
        skip: z.number().int().min(0).optional().describe('Offset for pagination (default 0)'),
      },
    },
    async ({ connection, kind, name, top, skip }) =>
      toolResult(async () => {
        const entry = await pool.get(connection)
        const matched = selectEntities(entry.index, { kind, name })

        const offset = skip ?? 0
        const limit = clampTop(top)
        const page = matched.slice(offset, offset + limit)
        return {
          summary: `${matched.length} entity set(s) matched; returning ${page.length} (skip ${offset}, top ${limit}).`,
          data: {
            connection,
            total: matched.length,
            skip: offset,
            top: limit,
            returned: page.length,
            hasMore: offset + page.length < matched.length,
            entities: page,
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
        return { summary: `${items.length} enum(s).`, data: { connection, total: items.length, enums: items } }
      }),
  )
}
