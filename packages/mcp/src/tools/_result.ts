import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { errorText } from '../redact.js'
import { toJsonSafe } from '../rows.js'

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
    // Compact JSON (no indentation): the data block is machine-read; the
    // human-readable gist is the `summary` line above it. Pretty-printing would
    // inflate the payload 30–50% against the client's per-result token budget.
    return {
      content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(safe)}` }],
      structuredContent: safe,
    }
  } catch (err) {
    return { content: [{ type: 'text', text: errorText(err) }], isError: true }
  }
}
