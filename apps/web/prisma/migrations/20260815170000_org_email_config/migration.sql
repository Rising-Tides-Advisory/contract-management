-- Per-org Postmark configuration.
--
-- Org-scoped mail (invitations, alerts, approvals, event notifications) sends
-- through the org's own Postmark server so it comes from their verified domain.
-- System mail (password reset) has no org context and always uses the
-- server-level POSTMARK_* env vars.
CREATE TABLE "OrgEmailConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "messageStream" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgEmailConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrgEmailConfig_organizationId_key" ON "OrgEmailConfig"("organizationId");

ALTER TABLE "OrgEmailConfig" ADD CONSTRAINT "OrgEmailConfig_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
