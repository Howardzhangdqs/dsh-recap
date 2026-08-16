/**
 * Package-owned invariant companion for `dsh-recap`.
 * @module dsh-recap/invariant
 */

/* jscpd:ignore-start */
import type { Context } from './context-types.ts'

const PACKAGE_NAME = 'dsh-recap'

/** Cordis companion plugin name. */
export const name = 'dsh-recap-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant beyond ownership reservation: the recap chain owns no
 * service state or event protocol of its own — capture is a read-only event
 * fold asserted by the capture spec, generation is an auxiliary llm call
 * asserted by the generator spec, and persistence semantics are asserted by
 * the store spec.
 */
const install: () => void = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
