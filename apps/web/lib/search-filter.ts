/**
 * The substring filter used everywhere a text query is matched without the
 * full-text index.
 *
 * The Postgres FTS index (`Contract.search_tsv`, see the add_fts_gin_index
 * migration) covers title + counterpartyName + notes, but every non-FTS path
 * used to match `title` alone. That made a counterparty invisible to the
 * contracts-list search box, and invisible to /api/search too whenever the FTS
 * query fell through — searching for a counterparty returned nothing even
 * though the contract was right there.
 *
 * `extractedText` is deliberately opt-in: it holds the whole document body and
 * is not indexed, so it is only widened into as a last resort rather than on
 * every keystroke.
 */

export interface ContractTextFilter {
  OR: Array<Record<string, { contains: string; mode: "insensitive" }>>
}

export function contractTextFilter(
  query: string,
  { includeExtractedText = false }: { includeExtractedText?: boolean } = {},
): ContractTextFilter {
  const contains = { contains: query, mode: "insensitive" as const }
  const fields = ["title", "counterpartyName", "notes"]
  if (includeExtractedText) fields.push("extractedText")
  return { OR: fields.map((field) => ({ [field]: contains })) }
}
