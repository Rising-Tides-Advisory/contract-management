/**
 * S3-compatible storage client.
 *
 * Works against AWS S3, Cloudflare R2, and MinIO. Provider is inferred from the
 * resolved endpoint — R2 needs two things AWS S3 does not:
 *
 *   region "auto"          R2 has no regions; the SDK still requires a value for
 *                          SigV4 signing and rejects anything else.
 *   checksums WHEN_REQUIRED  Since v3.729 the AWS SDK adds a CRC32 trailer to every
 *                          PutObject by default. R2's S3 API does not accept the
 *                          streaming-trailer form, so uploads fail with an
 *                          unsigned-payload error unless checksums are opt-in.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { env } from "@/lib/env"

let _s3: S3Client | null = null

/**
 * Resolves the S3 endpoint. Cloudflare exposes an account id rather than a URL,
 * so the R2 endpoint is derived when only the account id is present.
 * Empty/unset means AWS S3 (the SDK derives the endpoint from the region).
 */
function getEndpoint(): string | undefined {
  const explicit = env("STORAGE_ENDPOINT", "R2_ENDPOINT")
  if (explicit) return explicit

  const accountId = env("R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID")
  return accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined
}

function isR2(endpoint: string | undefined): boolean {
  return !!endpoint && endpoint.includes("r2.cloudflarestorage.com")
}

function getS3(): S3Client {
  if (!_s3) {
    const endpoint = getEndpoint()
    const r2 = isR2(endpoint)

    _s3 = new S3Client({
      region: env("STORAGE_REGION", "R2_REGION") ?? (r2 ? "auto" : "us-east-1"),
      endpoint,
      // Path-style addressing for R2 and MinIO; AWS S3 uses virtual-hosted style.
      forcePathStyle: !!endpoint,
      credentials: {
        accessKeyId: env("STORAGE_ACCESS_KEY", "R2_ACCESS_KEY_ID") ?? "",
        secretAccessKey: env("STORAGE_SECRET_KEY", "R2_SECRET_ACCESS_KEY") ?? "",
      },
      ...(r2
        ? {
            requestChecksumCalculation: "WHEN_REQUIRED" as const,
            responseChecksumValidation: "WHEN_REQUIRED" as const,
          }
        : {}),
    })
  }
  return _s3
}

function getBucket(): string {
  return env("STORAGE_BUCKET", "R2_BUCKET", "R2_BUCKET_NAME") ?? "aakd"
}

/** True when object storage has credentials configured. */
export function isStorageConfigured(): boolean {
  return (
    !!env("STORAGE_ACCESS_KEY", "R2_ACCESS_KEY_ID") &&
    !!env("STORAGE_SECRET_KEY", "R2_SECRET_ACCESS_KEY")
  )
}

export const storage = {
  async upload(key: string, body: Buffer | Uint8Array, contentType: string): Promise<string> {
    await getS3().send(new PutObjectCommand({ Bucket: getBucket(), Key: key, Body: body, ContentType: contentType }))
    return key
  },

  async getSignedDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    return getSignedUrl(getS3(), new GetObjectCommand({ Bucket: getBucket(), Key: key }), { expiresIn })
  },

  async delete(key: string): Promise<void> {
    await getS3().send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }))
  },

  storageKey(organizationId: string, contractId: string, filename: string): string {
    const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_")
    return `orgs/${organizationId}/contracts/${contractId}/${Date.now()}_${sanitized}`
  },
}
