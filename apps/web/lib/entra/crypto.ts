// Re-export from the M5 notification crypto — same AES-256-GCM helper and the
// same NOTIFICATION_ENCRYPTION_KEY, which is how the CRM integration stores its
// tokens too. Aliased here so Entra call sites read as "client secret", not
// "notification payload".
export { encrypt as encryptSecret, decrypt as decryptSecret } from "@/lib/notifications/crypto"
