# Microsoft Entra ID Integration

ClauseFlow integrates with Microsoft Entra ID (formerly Azure AD) **per organization**.
Each organization registers its own application in its own tenant and connects it in
ClauseFlow — one deployment can serve many companies without any of them sharing an
app registration.

The integration does two things:

1. **Platform access** — "Continue with Microsoft" on the login page.
2. **Contract responsibility** — the tenant directory is synced so a contract can name
   the person accountable for it, and notifications follow that person (escalating to
   their Entra manager when they have left or are disabled).

Organizations are still created through the normal sign-up flow. Entra is connected
afterwards, from **Settings → Microsoft Entra ID**.

---

## What gets installed in your tenant

Granting admin consent creates ClauseFlow's **service principal** in your tenant — this
is what appears under *Enterprise applications* — and grants it these Microsoft Graph
**application** permissions:

| Permission | Why |
|---|---|
| `User.Read.All` | Read the directory user list that backs the responsible-party picker |
| `Directory.Read.All` | Read manager relationships, used for notification escalation |

Both are read-only. ClauseFlow never writes to your directory.

Interactive sign-in additionally uses the delegated scopes `openid profile email
offline_access User.Read`, which every user consents to implicitly by signing in.

---

## Setup

### 1. Register the application

In the Azure portal → **App registrations** → **New registration**:

- **Supported account types**: *Accounts in any organizational directory (multitenant)*
- **Redirect URI** (Web) — add both. ClauseFlow shows the exact values for your
  deployment on the settings page:
  - `https://<your-clauseflow-host>/api/auth/entra/callback` — sign-in
  - `https://<your-clauseflow-host>/api/entra/consent/callback` — admin consent

Then, on the new registration:

- **Certificates & secrets** → **New client secret** → copy the *Value* (not the ID).
- **API permissions** → **Add a permission** → *Microsoft Graph* → **Application
  permissions** → add `User.Read.All` and `Directory.Read.All`.

Do **not** click "Grant admin consent" in the portal — step 3 does it through
ClauseFlow so the tenant id is captured.

### 2. Connect it in ClauseFlow

**Settings → Microsoft Entra ID**, as an organization administrator:

| Field | Notes |
|---|---|
| Application (client) ID | The GUID from the app registration overview |
| Client secret | Stored AES-256-GCM encrypted; never returned by the API |
| Email domains | Comma separated, e.g. `acme.com, acme.co.uk` |
| Allow Microsoft sign-in | Shows the button for people on those domains |
| Create accounts on first sign-in | Just-in-time provisioning (on by default) |
| Role for new members | `viewer`, `member`, or `legal` — admins are promoted by hand |
| Sync the directory daily | Keeps the picker and escalation current |

**Email domains are a security control, not a convenience.** They decide which tenant
the login page routes an address to, and they are the guard on provisioning — a guest
account in your tenant from another domain is turned away rather than given a
ClauseFlow account. Subdomains of a listed domain match (`finance.acme.com` matches
`acme.com`); lookalikes do not (`notacme.com` does not).

### 3. Grant admin consent

Click **Grant admin consent**. A Global Administrator approves the request in
Microsoft, and ClauseFlow records the tenant id and queues a first directory sync.
The settings page polls until it lands.

---

## Signing in

The login page's Microsoft button uses **home-realm discovery**: the work email
typed into the form decides which organization — and which app registration — the
sign-in belongs to. That indirection exists because the credentials are per-org; there
is no single Microsoft endpoint to send everyone to.

The flow is OpenID Connect authorization code with PKCE. ClauseFlow verifies the ID
token's RS256 signature against the tenant's published JWKS, then checks `iss`, `aud`,
`tid`, `nonce`, and expiry before creating a session. State is single-use and stored
server-side.

On first sign-in, if auto-provisioning is on, the user gets a ClauseFlow account and a
membership in the organization with the configured default role. An existing
password-based account with the same address is linked rather than duplicated — safe
here because the address was asserted by the tenant this organization consented to, and
it passed the domain allowlist.

Personal Microsoft accounts (the `9188040d-…` consumer tenant) are rejected.

---

## Contract responsibility and the notification path

Every contract has an **owner** (a ClauseFlow account) and, optionally, a
**responsible party** picked from the synced directory. Responsibility resolves in this
order:

1. The contract's explicit responsible party, when one is set.
2. The directory entry linked to the contract's owner.

The linked entry is what makes the common case work: the owner is a ClauseFlow account,
but the real mailbox and the reporting line only exist in Entra.

Notifications then behave like this:

- The responsible party is notified **alongside** the owner, not instead of them.
- Someone in the directory with **no ClauseFlow account** is still emailed. That is the
  point — legal frequently names a business owner who has never signed in. Those emails
  carry a one-click unsubscribe that flips an opt-out on the directory record.
- If the responsible party's Entra account is **disabled** or they have dropped out of
  the directory, the notification escalates to their **manager**.
- On `contract.expired` and `obligation.overdue` — the two events that mean nobody acted
  in time — the manager is notified as well as the responsible party.
- A disabled manager is a dead end rather than a chain to walk; reporting lines mid-reorg
  loop often enough that following them recursively is worse than stopping.

Outbound webhook payloads include a `data.responsibleParty` object (`name`, `email`) or
`null`.

---

## Directory sync

| | |
|---|---|
| Schedule | Daily at 04:00 UTC (`entra.sync_directory` queue) |
| Manual | **Sync now** on the settings page, or `POST /api/entra/sync` (queues the job, returns 202) |
| Scope | Members only — B2B guests are excluded |
| Fields | object id, UPN, display name, mail, job title, department, office, account state, manager |

People who disappear from the directory are marked disabled rather than deleted.
Deleting them would clear `Contract.responsiblePartyId` and erase who was accountable —
exactly the history this feature exists to keep.

If Graph returns 401 or 403, ClauseFlow treats consent as revoked: it clears the consent
timestamp, the settings page flips back to "Reconnect", and Microsoft sign-in stops
routing people to a tenant that would reject them.

---

## API

All endpoints require an authenticated session or API key. Configuration endpoints
require the `admin` role; the directory search is open to any member.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/entra` | Connection status + the redirect URIs and Graph permissions to register |
| `PUT` | `/api/entra` | Save credentials and sign-in policy |
| `DELETE` | `/api/entra` | Disconnect and drop the synced directory |
| `GET` | `/api/entra/consent` | Redirect into the admin-consent flow |
| `GET` | `/api/entra/consent/callback` | Microsoft's return target (not called directly) |
| `POST` | `/api/entra/sync` | Queue a directory sync (202; max 2 per 30s per org) |
| `GET` | `/api/entra/directory?q=&limit=` | Search the synced directory |
| `POST` | `/api/auth/entra/discover` | Home-realm discovery — returns the authorization URL |
| `GET` | `/api/auth/entra/callback` | Sign-in return target (not called directly) |

Set a contract's responsible party through the normal contract endpoint:

```http
PATCH /api/contracts/{id}
Content-Type: application/json

{ "responsiblePartyId": "<EntraDirectoryUser id>" }
```

Pass `null` to clear it and hand the notification path back to the owner.

---

## Configuration and security notes

- **No environment variables.** Entra is configured entirely per organization in the
  database. The only related server setting is `NOTIFICATION_ENCRYPTION_KEY`, the
  AES-256-GCM key that also protects CRM tokens and webhook secrets. Rotating it makes
  every stored client secret unreadable and every integration has to be reconnected.
- **One tenant, one organization.** A tenant already connected to another organization
  on the same deployment is rejected at consent time, because sign-in resolves an
  organization from the tenant and a second claim would make that ambiguous.
- **Client secrets are never returned** by the API; the settings page only reports
  whether one is stored.
- **Changing the client id clears consent**, because the service principal in the
  tenant is tied to the application id.
- Discovery is rate limited (10/min per IP) — unauthenticated by necessity, it would
  otherwise be an oracle for which domains use ClauseFlow.
