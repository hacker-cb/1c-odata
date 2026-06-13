import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { errorText } from '../redact.js'

/**
 * Recursively convert a value into JSON-safe form: `bigint` → decimal string
 * (1С `Edm.Int64` under `int64Mode: 'bigint'` would otherwise throw in
 * `JSON.stringify`), `Date` → ISO string. Everything else passes through.
 */
function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(toJsonSafe)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) out[key] = toJsonSafe(val)
    return out
  }
  return value
}

/**
 * Wrap a tool body in a uniform result shape:
 * - success → a human-readable `summary` plus the JSON `data` (in `content` text
 *   so any client surfaces it, and in `structuredContent` for structured clients);
 * - thrown → `isError: true` with a redacted message (no leaked credentials).
 *
 * The data is embedded in the text block because, without an `outputSchema`,
 * MCP clients are not required to read `structuredContent`.
 */
export async function toolResult(
  body: () => Promise<{ summary: string; data: Record<string, unknown> }>,
): Promise<CallToolResult> {
  try {
    const { summary, data } = await body()
    const safe = toJsonSafe(data) as Record<string, unknown>
    return {
      content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(safe, null, 2)}` }],
      structuredContent: safe,
    }
  } catch (err) {
    return { content: [{ type: 'text', text: errorText(err) }], isError: true }
  }
}
