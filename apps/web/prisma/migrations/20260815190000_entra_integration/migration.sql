-- Microsoft Entra ID integration, scoped per organization.
--
-- Each org registers its own multi-tenant app registration and grants admin
-- consent, which installs ClauseFlow in their tenant as an enterprise app.
-- The integration powers two things: sign-in to the platform, and resolving
-- who is responsible for a contract so notifications follow that person.

CREATE TABLE "EntraIntegration" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "tenantId" TEXT,
    "tenantName" TEXT,
    "consentGrantedAt" TIMESTAMP(3),
    "consentGrantedById" TEXT,
    "consentError" TEXT,
    "ssoEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "autoProvision" BOOLEAN NOT NULL DEFAULT true,
    "defaultRole" TEXT NOT NULL DEFAULT 'member',
    "directorySyncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "lastSyncUserCount" INTEGER,
    "connectedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntraIntegration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EntraIntegration_organizationId_key" ON "EntraIntegration"("organizationId");
CREATE INDEX "EntraIntegration_tenantId_idx" ON "EntraIntegration"("tenantId");

ALTER TABLE "EntraIntegration" ADD CONSTRAINT "EntraIntegration_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EntraIntegration" ADD CONSTRAINT "EntraIntegration_connectedById_fkey"
    FOREIGN KEY ("connectedById") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EntraIntegration" ADD CONSTRAINT "EntraIntegration_consentGrantedById_fkey"
    FOREIGN KEY ("consentGrantedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Synced snapshot of the tenant directory. `objectId` is the immutable Entra
-- user id, so a UPN or display-name change does not orphan the row.
CREATE TABLE "EntraDirectoryUser" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "userPrincipalName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "mail" TEXT,
    "jobTitle" TEXT,
    "department" TEXT,
    "officeLocation" TEXT,
    "accountEnabled" BOOLEAN NOT NULL DEFAULT true,
    "managerObjectId" TEXT,
    "notifyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "userId" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntraDirectoryUser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EntraDirectoryUser_integrationId_objectId_key"
    ON "EntraDirectoryUser"("integrationId", "objectId");
CREATE INDEX "EntraDirectoryUser_organizationId_userId_idx"
    ON "EntraDirectoryUser"("organizationId", "userId");
CREATE INDEX "EntraDirectoryUser_organizationId_managerObjectId_idx"
    ON "EntraDirectoryUser"("organizationId", "managerObjectId");
CREATE INDEX "EntraDirectoryUser_organizationId_mail_idx"
    ON "EntraDirectoryUser"("organizationId", "mail");
CREATE INDEX "EntraDirectoryUser_organizationId_displayName_idx"
    ON "EntraDirectoryUser"("organizationId", "displayName");

ALTER TABLE "EntraDirectoryUser" ADD CONSTRAINT "EntraDirectoryUser_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EntraDirectoryUser" ADD CONSTRAINT "EntraDirectoryUser_integrationId_fkey"
    FOREIGN KEY ("integrationId") REFERENCES "EntraIntegration"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EntraDirectoryUser" ADD CONSTRAINT "EntraDirectoryUser_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Contract → responsible party. Nullable: contracts predating the integration
-- (and orgs without Entra) keep falling back to Contract.ownerId.
ALTER TABLE "Contract" ADD COLUMN "responsiblePartyId" TEXT;

CREATE INDEX "Contract_responsiblePartyId_idx" ON "Contract"("responsiblePartyId");

ALTER TABLE "Contract" ADD CONSTRAINT "Contract_responsiblePartyId_fkey"
    FOREIGN KEY ("responsiblePartyId") REFERENCES "EntraDirectoryUser"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
