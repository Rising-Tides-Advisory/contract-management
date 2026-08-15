/**
 * Environment variable resolution with provider aliases.
 *
 * Deployments rarely get to choose their variable names: the Vercel↔Supabase
 * integration injects POSTGRES_PRISMA_URL / POSTGRES_URL_NON_POOLING, Cloudflare
 * hands out R2_ACCESS_KEY_ID, Postmark calls its credential a server token. Rather
 * than force every deployment to re-key those into ClauseFlow's canonical names,
 * each subsystem resolves the first non-empty match from an ordered alias list.
 *
 * The canonical name always wins, so an explicit override still takes precedence
 * over anything an integration injected.
 */

/** Returns the first env var that is set and non-empty, or undefined. */
export function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined && value.trim() !== "") return value
  }
  return undefined
}

/** True when running on Vercel (serverless — short-lived, highly parallel processes). */
export function isServerless(): boolean {
  return !!process.env.VERCEL
}
