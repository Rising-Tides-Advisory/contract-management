/**
 * Product name used in user-facing copy — page titles, in-app text, email
 * subjects and bodies, and the landing page wordmark.
 *
 * Self-hosters rebrand the whole install by setting NEXT_PUBLIC_APP_NAME.
 * The reference is written out literally rather than routed through `env()`
 * so Next inlines it into the client bundle; a dynamic `process.env[name]`
 * lookup resolves to undefined in the browser.
 *
 * Machine identifiers deliberately do NOT read from this. The MCP server name,
 * the storage bucket, the theme localStorage key, the default mail-from domain,
 * and the Sentry org/project are stable contracts — moving them with the brand
 * would orphan stored objects, reset user preferences, and break MCP clients
 * that already have the old server name in their config.
 */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME?.trim() || "Aakd"
