# Deploying to Vercel (Neon or Supabase + Cloudflare R2 + Postmark)

This is the managed-services path: Vercel runs the Next.js app, a managed Postgres
with pgvector (Neon or Supabase) holds the data, Cloudflare R2 stores contract
files, and Postmark sends mail.
Nothing here is self-hosted except the BullMQ worker, which cannot run on Vercel.

For the fully self-hosted Docker path, see [self-hosting.md](./self-hosting.md).

---

## Why the worker needs a separate host

Vercel functions are request-scoped and die when the response is sent. The BullMQ
worker is a long-lived process that polls Redis and runs multi-minute jobs (PDF text
extraction, embeddings, AI extraction, the daily alerts cron). It has to run somewhere
that keeps a process alive — Fly.io, Railway, Render, or any small VM.

The repo already ships `fly.toml` pointing at `apps/web/Dockerfile.worker` for this.

Without a running worker the app still works, but uploads are never text-extracted,
embeddings and AI extraction never run, renewal alerts never fire, and Entra
directory syncs are queued and never processed.

**The worker does not deploy itself.** Vercel redeploys the app on every push to
`main`, but nothing redeploys the worker — there is no CI job for it. Any change
under `apps/web/worker.ts` or the `lib/` code it imports, and in particular any
*new* queue, only reaches production when someone runs `fly deploy` (or the
equivalent for whatever host you use). A worker built before a queue existed
silently ignores that queue's jobs: they enqueue successfully and are never
consumed, which looks like a feature that does nothing rather than an error.

```bash
fly deploy -c fly.toml          # from the repo root, after any worker change
fly logs -a aakd-worker         # confirm it booted and registered its crons
```

---

## 1. Database (Neon or Supabase)

The app always needs **two** connection strings, and they are not interchangeable:

| Canonical env var | Connection | Used for |
|---|---|---|
| `DATABASE_URL` | Pooled | Every runtime query |
| `DIRECT_URL` | Direct / unpooled | `prisma migrate` only |

Both are required on any host that fronts Postgres with a transaction pooler.
`prisma migrate deploy` takes a Postgres advisory lock and issues DDL — neither
survives one — so migrations pointed at the pooled URL hang or fail.
`prisma.config.ts` resolves the direct URL for exactly this reason.

Enable **pgvector** before migrating either way: migration
`20260507140000_m3_embeddings` runs `CREATE EXTENSION IF NOT EXISTS vector`, which
needs the extension available on the instance.

### Neon

Install the Neon integration from the Vercel marketplace and connect the project.
**Leave the Custom Prefix field empty.** The prefix exists for running several
databases in one Vercel project (`PRIMARY_`, `ANALYTICS_`); with one database it only
renames the variables away from the defaults the app already reads. If the field
insists on a value, use `DATABASE` — that yields `DATABASE_URL`, the canonical name.

The integration then injects:

| Injected name | Connection | Read by the app as |
|---|---|---|
| `DATABASE_URL` | Pooled (host contains `-pooler`) | `DATABASE_URL` |
| `DATABASE_URL_UNPOOLED` | Direct | `DIRECT_URL` (alias) |

Note Neon distinguishes the two by **hostname**, not port — both are 5432, and the
pooled host has `-pooler` in it. Do not assume the Supabase port convention.

### Supabase

**Project → Connect**, then copy the transaction pooler string (port 6543, append
`?pgbouncer=true`) to `DATABASE_URL` and the direct string (port 5432) to `DIRECT_URL`.

Linking through the Vercel↔Supabase integration instead injects
`POSTGRES_PRISMA_URL` and `POSTGRES_URL_NON_POOLING`, both accepted as aliases.

### Swapping hosts later

The app only ever reads `DATABASE_URL` and `DIRECT_URL`. Everything else is an alias
resolved in `lib/db/connection.ts`, canonical names first. To move hosts, point those
two names at the new database — no application code changes. If a new host injects
names not on the alias list, add them there rather than renaming anything in the app.

### Connection pool sizing

Leave `DATABASE_POOL_SIZE` unset. On Vercel it defaults to **1**: every concurrent
lambda instance opens its own `pg` pool, so a pool of 20 multiplies into hundreds of
client connections and exhausts the Supabase pooler. The pooler is doing the real
pooling. Long-lived processes (the worker, Docker, local dev) default to 20.

### Migrations

Production builds apply pending migrations automatically. `apps/web/scripts/build-migrate.mjs`
runs `prisma migrate deploy` before `next build`, so a deploy never ships code
expecting a table the database does not have.

It only runs when **all** of these hold, and logs which guard stopped it otherwise:

| Condition | Why |
|---|---|
| `SKIP_BUILD_MIGRATE` unset | Escape hatch — set it in Vercel to disable without a code change |
| Running on Vercel | A local `pnpm build` must never migrate a remote database |
| `VERCEL_ENV === "production"` | Preview shares one database with production here, so migrating on preview would migrate production |

A missing direct URL or a failed migration **fails the build** — deploying against
an un-migrated schema is worse than not deploying.

> If the build fails with "No direct database URL available at build time" while
> the variables are set on the project, the likely cause is that they are marked
> **Sensitive** in Vercel. Either unmark the direct-connection variable, or set
> `SKIP_BUILD_MIGRATE=1` and migrate manually.

To run them by hand — always the direct/unpooled URL, never the pooled one:

```bash
DIRECT_URL='postgresql://...' pnpm --filter web db:migrate:prod
```

Once previews get their own Neon database branch, drop the `VERCEL_ENV` guard so
preview deploys migrate their own branch.

---

## 2. Cloudflare R2 (file storage)

1. Create a bucket.
2. **R2 → Manage API tokens → Create API token**, scoped **Object Read & Write** on
   that bucket. The secret is shown once.
3. Set:

```
R2_ACCOUNT_ID=<32-char hex account id>
R2_ACCESS_KEY_ID=<from the token>
R2_SECRET_ACCESS_KEY=<from the token>
R2_BUCKET=<bucket name>
```

Leave the `STORAGE_*` variables unset — explicit `STORAGE_*` values take precedence
over the `R2_*` aliases, so a leftover `STORAGE_ENDPOINT` pointing at MinIO will
silently win.

The endpoint is derived as `https://<account-id>.r2.cloudflarestorage.com`. The client
detects R2 and applies two settings automatically: `region: "auto"` (R2 has no regions
but SigV4 still requires a value) and checksum calculation set to `WHEN_REQUIRED`
(since v3.729 the AWS SDK adds a CRC32 streaming trailer to every `PutObject`, which
R2's S3 API rejects).

Keep the bucket **private**. Downloads go through presigned URLs generated by the app,
so there is no reason to expose a public bucket.

---

## 3. Postmark (email)

1. **Servers → your server → API Tokens** → copy the **Server API Token**.
2. **Sender Signatures → Domains** → add your domain and publish the DKIM and
   Return-Path DNS records Postmark gives you.
3. Set:

```
POSTMARK_SERVER_TOKEN=<server API token>
POSTMARK_MESSAGE_STREAM=outbound
EMAIL_FROM=noreply@yourdomain.com
ALERT_EMAIL_TO=you@yourdomain.com
```

`EMAIL_FROM` must be on the verified domain — Postmark rejects mail from an
unverified sender. `outbound` is the transactional stream every Postmark server ships
with; only change it if you created a custom stream.

Postmark takes precedence over the `SMTP_*` block. With neither configured, email is
disabled and every send is a no-op — in-app, Slack, and Teams notifications still fire.

---

## 4. Redis

BullMQ needs Redis reachable from both Vercel and the worker host. Upstash works:

```
REDIS_URL=rediss://default:<password>@<host>.upstash.io:6379
```

The `rediss://` scheme enables TLS automatically in both the app and the worker.

---

## 5. Vercel project settings

- **Root directory:** `apps/web`. Vercel detects the pnpm workspace and installs from
  the repo root, then builds in that directory. Leaving it at the repository root also
  works — the root `build` script filters to the `web` workspace either way.
- **Build command:** default (`pnpm run build`). Either root directory resolves to the
  `web` workspace's build script, which runs `prisma generate` before `next build`.
  That generate step is not optional: pnpm 10 blocks dependency build scripts by
  default, so Prisma's postinstall never fires, and without it the build fails with
  `implicitly has an 'any' type` errors from ungenerated client types.

### Environment variables

Set these in **Project → Settings → Environment Variables**, or attach them from a
Shared Environment Variable group at the team level.

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Pooled connection. Supabase: port 6543 + `?pgbouncer=true`. Neon: injected automatically. |
| `DIRECT_URL` | Direct connection. Neon injects it as `DATABASE_URL_UNPOOLED` (accepted as an alias). |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | Your production URL |
| `NEXT_PUBLIC_APP_URL` | Same as `BETTER_AUTH_URL` |
| `INTERNAL_APP_URL` | Same as `BETTER_AUTH_URL` on Vercel — there is no container-internal address |
| `R2_ACCOUNT_ID` · `R2_ACCESS_KEY_ID` · `R2_SECRET_ACCESS_KEY` · `R2_BUCKET` | Storage |
| `POSTMARK_SERVER_TOKEN` · `EMAIL_FROM` | Email |
| `REDIS_URL` | `rediss://` for Upstash |
| `ENCRYPTION_KEY` | Encrypts stored API keys |
| `NOTIFICATION_ENCRYPTION_KEY` | 32 bytes hex: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ANTHROPIC_API_KEY` | Optional — AI features degrade gracefully without it |
| `DOCUSEAL_API_KEY` · `DOCUSEAL_WEBHOOK_SECRET` | Optional — required for signing |

The worker host needs the same values, minus the `NEXT_PUBLIC_*` and auth URL entries.

---

## 6. The worker host

The worker is one long-lived process built from `apps/web/Dockerfile.worker`. It
listens on no ports and serves no traffic — it polls Redis, runs jobs, and holds the
five repeating crons (renewal alerts, obligation checks, signing sync, Salesforce
poll, Entra directory sync). Any host that keeps a container running works; nothing
below is Fly-specific beyond the CLI.

Give it `DATABASE_URL`, `DIRECT_URL`, `REDIS_URL`, `NOTIFICATION_ENCRYPTION_KEY`,
`ENCRYPTION_KEY`, the storage credentials, and — if you want mail — the Postmark or
SMTP block. It does not need `NEXT_PUBLIC_APP_URL`, `BETTER_AUTH_URL`, or
`INTERNAL_APP_URL`. `DATABASE_POOL_SIZE` should be left unset: the worker is a
long-lived process and wants the default of 20, not the 1 that suits Vercel.

**Fly** — `fly.toml` already points at the worker Dockerfile:

```bash
fly launch --no-deploy -c fly.toml     # first time only
fly secrets set DATABASE_URL=... REDIS_URL=... NOTIFICATION_ENCRYPTION_KEY=...
fly deploy -c fly.toml
```

**Railway** — `railway.json` in the repo root already selects the Dockerfile builder,
pins the worker Dockerfile, and sets an always-on restart policy, so a service created
from this repo picks it up with no further build configuration. Leave the service's
**root directory** at the repo root: the Dockerfile copies from `apps/web/` and
`worker/`, so a narrower context fails to build. Add the env vars below, and leave the
health check unset — the worker never opens a port, so a port-based check restarts it
forever. Railway redeploys on every push to `main`, which is the point: the worker
cannot fall behind the app.

If you later run a second Railway service from this repo, point that one at its own
config with **Settings → Config-as-code → Config file path**, since a bare
`railway.json` at the root applies to every service that does not override it.

**Render** — create a Background Worker from this repo with the Dockerfile path set to
`apps/web/Dockerfile.worker` and the build context at the repo root, add the same env
vars, and leave the health check unset for the same reason.

**Any VM with Docker** —

```bash
docker build -f apps/web/Dockerfile.worker -t clauseflow-worker .
docker run -d --restart=always --env-file worker.env clauseflow-worker
```

Confirm it came up by looking for the cron registrations in the logs:

```
[alerts] Daily cron registered (0 9 * * *)
[obligations] Daily cron registered (0 9 * * *)
[entra.sync] Daily cron registered (0 4 * * *)
```

If those lines are absent the process is not booting; if they are present but jobs
never complete, it cannot reach Redis or Postgres.

---

## Verifying the deployment

1. Register an account — proves `DATABASE_URL` and `BETTER_AUTH_SECRET` work.
2. Trigger a password reset — proves Postmark works. Check Postmark's **Activity** tab
   for the delivery.
3. Upload a PDF, then download it — proves R2 credentials and presigning work.
4. Confirm the contract's text was extracted — proves the worker and `REDIS_URL` work.
   If the file uploads but never extracts, the worker is not running or cannot reach Redis.
5. Run the isolation test before shipping: `pnpm test:isolation`.

## Troubleshooting

**Build fails with `implicitly has an 'any' type`** — `prisma generate` did not run.
Confirm the build command resolves to the workspace `build` script.

**Migrations hang** — the direct URL is pointing at the pooled connection. On Supabase
that means port 6543 instead of 5432; on Neon it means the host with `-pooler` in it.

**`Max client connections reached`** — `DATABASE_POOL_SIZE` is set too high for
serverless. Unset it and let it default to 1 on Vercel.

**Uploads fail with a checksum or unsigned-payload error** — a stale `STORAGE_ENDPOINT`
is overriding the R2 endpoint, so the R2-specific checksum handling never activates.

**Email silently does nothing** — neither `POSTMARK_SERVER_TOKEN` nor `SMTP_HOST` is
set. The worker logs a warning at startup when email is unconfigured.
