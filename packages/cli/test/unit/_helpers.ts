/** Await a promise that MUST reject; returns the typed Error (fails loudly on fulfill). */
export async function rejection(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error('expected promise to reject, but it fulfilled')
    },
    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  )
}
