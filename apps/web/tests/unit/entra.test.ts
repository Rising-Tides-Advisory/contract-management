import { describe, expect, it, beforeEach, vi } from "vitest"
import {
  emailDomain,
  isBlockedTenant,
  matchesDomain,
  normalizeDomains,
} from "@/lib/entra/config"
import { createPkcePair, verifyIdToken, EntraAuthError, __resetJwksCacheForTests } from "@/lib/entra/oidc"
import { resolveResponsibleRecipients, shouldEscalateToManager } from "@/lib/entra/responsible"
import crypto from "node:crypto"

describe("entra/config — domain matching", () => {
  it("extracts the domain part of an address", () => {
    expect(emailDomain("Ada@Acme.com")).toBe("acme.com")
    expect(emailDomain("ada@finance.acme.co.uk")).toBe("finance.acme.co.uk")
  })

  it("rejects things that are not addresses", () => {
    expect(emailDomain("ada")).toBeNull()
    expect(emailDomain("@acme.com")).toBeNull()
    expect(emailDomain("ada@")).toBeNull()
    expect(emailDomain("ada@localhost")).toBeNull()
  })

  it("canonicalizes admin-entered domains", () => {
    expect(normalizeDomains(["@Acme.com", " acme.com ", "*.acme.com", "", "not a domain"]))
      .toEqual(["acme.com"])
  })

  it("matches subdomains but not lookalikes", () => {
    const domains = ["acme.com"]
    expect(matchesDomain("ada@acme.com", domains)).toBe(true)
    expect(matchesDomain("ada@finance.acme.com", domains)).toBe(true)
    // The important one: a domain that merely *ends with* the allowed string
    // must not pass, or anyone could register notacme.com and walk in.
    expect(matchesDomain("ada@notacme.com", domains)).toBe(false)
    expect(matchesDomain("ada@acme.com.evil.net", domains)).toBe(false)
  })

  it("matches nothing when no domains are configured", () => {
    expect(matchesDomain("ada@acme.com", [])).toBe(false)
  })

  it("blocks the consumer MSA tenant", () => {
    expect(isBlockedTenant("9188040d-6c67-4c5b-b112-36a304b66dad")).toBe(true)
    expect(isBlockedTenant("9188040D-6C67-4C5B-B112-36A304B66DAD")).toBe(true)
    expect(isBlockedTenant("11111111-2222-3333-4444-555555555555")).toBe(false)
    expect(isBlockedTenant(null)).toBe(false)
  })
})

describe("entra/oidc — PKCE", () => {
  it("derives an S256 challenge from the verifier", () => {
    const { verifier, challenge } = createPkcePair()
    expect(challenge).toBe(crypto.createHash("sha256").update(verifier).digest("base64url"))
    expect(verifier.length).toBeGreaterThanOrEqual(43)
  })

  it("produces a fresh verifier each time", () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier)
  })
})

// ─── ID token verification ────────────────────────────────────────────────────
// A throwaway RSA key stands in for the tenant's signing key; the JWKS endpoint
// is stubbed so the tests exercise our claim checks, not Microsoft's uptime.

const TENANT = "11111111-2222-3333-4444-555555555555"
const CLIENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const KID = "test-key-1"

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url")
}

function signIdToken(claims: Record<string, unknown>, kid = KID): string {
  const header = b64url({ alg: "RS256", typ: "JWT", kid })
  const payload = b64url(claims)
  const signature = crypto.sign(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
  )
  return `${header}.${payload}.${signature.toString("base64url")}`
}

function baseClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    aud: CLIENT_ID,
    tid: TENANT,
    oid: "objectid-1",
    sub: "subject-1",
    nonce: "nonce-1",
    email: "Ada@acme.com",
    name: "Ada Lovelace",
    preferred_username: "ada@acme.com",
    exp: now + 600,
    nbf: now - 60,
    ...overrides,
  }
}

function verify(token: string, nonce = "nonce-1") {
  return verifyIdToken({ idToken: token, tenantId: TENANT, clientId: CLIENT_ID, nonce })
}

describe("entra/oidc — verifyIdToken", () => {
  beforeEach(() => {
    __resetJwksCacheForTests()
    const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ keys: [{ kid: KID, kty: "RSA", n: jwk.n, e: jwk.e }] }), {
          status: 200,
        }),
      ),
    )
  })

  it("accepts a well-formed token and lowercases the email", async () => {
    const claims = await verify(signIdToken(baseClaims()))
    expect(claims.email).toBe("ada@acme.com")
    expect(claims.oid).toBe("objectid-1")
    expect(claims.tid).toBe(TENANT)
  })

  it("falls back to preferred_username when the email claim is absent", async () => {
    const claims = await verify(signIdToken(baseClaims({ email: undefined })))
    expect(claims.email).toBe("ada@acme.com")
  })

  it("rejects a token from a different tenant", async () => {
    const other = "99999999-9999-9999-9999-999999999999"
    await expect(
      verify(signIdToken(baseClaims({ tid: other }))),
    ).rejects.toMatchObject({ reason: "tenant_mismatch" })
  })

  it("rejects a token minted for a different application", async () => {
    await expect(
      verify(signIdToken(baseClaims({ aud: "someone-elses-client-id" }))),
    ).rejects.toMatchObject({ reason: "audience_mismatch" })
  })

  it("rejects a token whose issuer is not this tenant's authority", async () => {
    await expect(
      verify(signIdToken(baseClaims({ iss: "https://evil.example.com/v2.0" }))),
    ).rejects.toMatchObject({ reason: "issuer_mismatch" })
  })

  it("rejects a replayed token with a stale nonce", async () => {
    await expect(
      verify(signIdToken(baseClaims({ nonce: "someone-elses-nonce" }))),
    ).rejects.toMatchObject({ reason: "nonce_mismatch" })
  })

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000)
    await expect(
      verify(signIdToken(baseClaims({ exp: now - 3600 }))),
    ).rejects.toMatchObject({ reason: "token_expired" })
  })

  it("rejects a tampered payload", async () => {
    const token = signIdToken(baseClaims())
    const [header, , signature] = token.split(".")
    const forged = b64url(baseClaims({ email: "attacker@acme.com" }))
    await expect(verify(`${header}.${forged}.${signature}`)).rejects.toMatchObject({
      reason: "invalid_token",
    })
  })

  it("rejects a token signed with an unknown key", async () => {
    await expect(verify(signIdToken(baseClaims(), "unknown-kid"))).rejects.toBeInstanceOf(
      EntraAuthError,
    )
  })

  it("rejects unsigned (alg: none) tokens", async () => {
    const header = b64url({ alg: "none", typ: "JWT", kid: KID })
    const payload = b64url(baseClaims())
    await expect(verify(`${header}.${payload}.`)).rejects.toMatchObject({
      reason: "invalid_token",
    })
  })
})

// ─── Responsible-party resolution ─────────────────────────────────────────────

type FakeDb = Parameters<typeof resolveResponsibleRecipients>[0]

function fakeDb(opts: {
  contract?: Record<string, unknown> | null
  directoryByOwner?: Record<string, unknown> | null
  manager?: Record<string, unknown> | null
}): FakeDb {
  return {
    contract: { findUnique: async () => opts.contract ?? null },
    entraDirectoryUser: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        where.objectId ? (opts.manager ?? null) : (opts.directoryByOwner ?? null),
    },
  } as unknown as FakeDb
}

const person = (over: Record<string, unknown> = {}) => ({
  id: "dir-1",
  objectId: "oid-1",
  displayName: "Ada Lovelace",
  mail: "ada@acme.com",
  userPrincipalName: "ada@acme.com",
  accountEnabled: true,
  notifyEnabled: true,
  managerObjectId: null,
  userId: null,
  ...over,
})

describe("entra/responsible", () => {
  it("returns nothing when the org has no directory", async () => {
    const db = fakeDb({
      contract: { organizationId: "org", ownerId: "u1", responsiblePartyId: null, responsibleParty: null },
      directoryByOwner: null,
    })
    expect(await resolveResponsibleRecipients(db, "c1")).toEqual([])
  })

  it("prefers the explicit responsible party over the owner", async () => {
    const db = fakeDb({
      contract: {
        organizationId: "org",
        ownerId: "u1",
        responsiblePartyId: "dir-9",
        responsibleParty: person({ id: "dir-9", displayName: "Grace", mail: "grace@acme.com" }),
      },
      directoryByOwner: person(),
    })
    const out = await resolveResponsibleRecipients(db, "c1")
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ email: "grace@acme.com", reason: "responsible_party" })
  })

  it("falls back to the directory row linked to the owner", async () => {
    const db = fakeDb({
      contract: { organizationId: "org", ownerId: "u1", responsiblePartyId: null, responsibleParty: null },
      directoryByOwner: person({ userId: "u1" }),
    })
    const out = await resolveResponsibleRecipients(db, "c1")
    expect(out[0]).toMatchObject({ email: "ada@acme.com", reason: "owner_directory", userId: "u1" })
  })

  it("uses the UPN when the mailbox address is missing", async () => {
    const db = fakeDb({
      contract: {
        organizationId: "org",
        ownerId: "u1",
        responsiblePartyId: "dir-1",
        responsibleParty: person({ mail: null, userPrincipalName: "Ada@Acme.com" }),
      },
    })
    const out = await resolveResponsibleRecipients(db, "c1")
    expect(out[0].email).toBe("ada@acme.com")
  })

  it("escalates to the manager when the responsible party has left", async () => {
    const db = fakeDb({
      contract: {
        organizationId: "org",
        ownerId: "u1",
        responsiblePartyId: "dir-1",
        responsibleParty: person({ accountEnabled: false, managerObjectId: "oid-boss" }),
      },
      manager: person({ id: "dir-2", displayName: "Boss", mail: "boss@acme.com" }),
    })
    const out = await resolveResponsibleRecipients(db, "c1")
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ email: "boss@acme.com", reason: "manager_escalation" })
  })

  it("adds the manager alongside the responsible party when asked to escalate", async () => {
    const db = fakeDb({
      contract: {
        organizationId: "org",
        ownerId: "u1",
        responsiblePartyId: "dir-1",
        responsibleParty: person({ managerObjectId: "oid-boss" }),
      },
      manager: person({ id: "dir-2", displayName: "Boss", mail: "boss@acme.com" }),
    })
    const out = await resolveResponsibleRecipients(db, "c1", { includeManager: true })
    expect(out.map((r) => r.email)).toEqual(["ada@acme.com", "boss@acme.com"])
  })

  it("drops someone who unsubscribed without promoting their manager", async () => {
    const db = fakeDb({
      contract: {
        organizationId: "org",
        ownerId: "u1",
        responsiblePartyId: "dir-1",
        responsibleParty: person({ notifyEnabled: false, managerObjectId: "oid-boss" }),
      },
      manager: person({ id: "dir-2", mail: "boss@acme.com" }),
    })
    expect(await resolveResponsibleRecipients(db, "c1")).toEqual([])
  })

  it("skips a disabled manager rather than walking further up", async () => {
    const db = fakeDb({
      contract: {
        organizationId: "org",
        ownerId: "u1",
        responsiblePartyId: "dir-1",
        responsibleParty: person({ accountEnabled: false, managerObjectId: "oid-boss" }),
      },
      manager: person({ id: "dir-2", accountEnabled: false, mail: "boss@acme.com" }),
    })
    expect(await resolveResponsibleRecipients(db, "c1")).toEqual([])
  })

  it("de-duplicates when the manager is also the responsible party", async () => {
    const db = fakeDb({
      contract: {
        organizationId: "org",
        ownerId: "u1",
        responsiblePartyId: "dir-1",
        responsibleParty: person({ managerObjectId: "oid-self" }),
      },
      manager: person({ id: "dir-1", mail: "ada@acme.com" }),
    })
    const out = await resolveResponsibleRecipients(db, "c1", { includeManager: true })
    expect(out).toHaveLength(1)
  })

  it("escalates only on the events that mean nobody acted", () => {
    expect(shouldEscalateToManager("contract.expired")).toBe(true)
    expect(shouldEscalateToManager("obligation.overdue")).toBe(true)
    expect(shouldEscalateToManager("contract.uploaded")).toBe(false)
    expect(shouldEscalateToManager("contract.expiring_soon")).toBe(false)
  })
})
