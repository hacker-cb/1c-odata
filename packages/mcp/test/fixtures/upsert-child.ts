/**
 * A separate process changing a shared data dir (#269), run by
 * `data-dir-lock.test.ts` under `node --import tsx`:
 *   upsert-child.ts <dataDir> <name>[,<name>…]
 * Prints `ready` before its first change, then adds each connection — without a
 * password, so no keychain is touched.
 */
import { upsertConnection } from '../../src/connections.js'

const [dataDir, names] = process.argv.slice(2)
if (dataDir === undefined || names === undefined) throw new Error('usage: upsert-child.ts <dataDir> <names>')
process.stdout.write('ready\n')
for (const name of names.split(',')) {
  await upsertConnection({
    dataDir,
    name,
    baseUrl: `http://${name}.test/odata/standard.odata`,
    login: 'u',
    serverTimezone: 'Europe/Moscow',
    insecure: true,
  })
}
