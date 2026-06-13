import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { errorText } from '../redact.js'

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
    return {
      content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
      structuredContent: data,
    }
  } catch (err) {
    return { content: [{ type: 'text', text: errorText(err) }], isError: true }
  }
}
