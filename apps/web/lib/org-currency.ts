/**
 * Server-side access to an org's currency settings.
 *
 * Split from `lib/currencies.ts` so that module stays pure data and remains
 * importable from client components — this one touches Prisma.
 */

import { prisma } from "@/lib/db/client"
import { logger } from "@/lib/logger"
import {
  readCurrencySettings,
  DEFAULT_ENABLED_CURRENCIES,
  FALLBACK_CURRENCY,
  type OrgCurrencySettings,
} from "@/lib/currencies"

/**
 * Never throws. Currency is a display preference, so a metadata read that fails
 * must not take down contract creation — it falls back to the built-in list.
 */
export async function getOrgCurrencySettings(
  organizationId: string,
): Promise<OrgCurrencySettings> {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { metadata: true },
    })
    const meta = org?.metadata
      ? (JSON.parse(org.metadata) as Record<string, unknown>)
      : {}
    return readCurrencySettings(meta)
  } catch (err) {
    logger.error(
      { err, organizationId },
      "[org-currency] Failed to read currency settings; using defaults",
    )
    return {
      enabled: [...DEFAULT_ENABLED_CURRENCIES],
      default: FALLBACK_CURRENCY,
    }
  }
}

/** The org's default currency, for routes that only need the one value. */
export async function getDefaultCurrency(organizationId: string): Promise<string> {
  return (await getOrgCurrencySettings(organizationId)).default
}
