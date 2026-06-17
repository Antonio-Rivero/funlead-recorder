-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Recording" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Untitled recording',
    "shareToken" TEXT NOT NULL,
    "blobUrl" TEXT NOT NULL,
    "blobPathname" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'screen',
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "mimeType" TEXT NOT NULL DEFAULT 'video/webm',
    "status" TEXT NOT NULL DEFAULT 'ready',
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "posterUrl" TEXT,
    "expiresAt" TIMESTAMP(3),
    "passwordHash" TEXT,
    "disabledAt" TIMESTAMP(3),
    "description" TEXT,
    "ctaLabel" TEXT,
    "ctaUrl" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "transcript" TEXT,
    "transcriptStatus" TEXT,
    "transcriptPublic" BOOLEAN NOT NULL DEFAULT false,
    "ctaClicks" INTEGER NOT NULL DEFAULT 0,
    "folderId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "endCardTitle" TEXT,
    "endCardCtaLabel" TEXT,
    "endCardCtaUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordingReaction" (
    "id" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "viewerId" TEXT,
    "atSec" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecordingReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordingFolder" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecordingFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordingView" (
    "id" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "maxPositionSec" INTEGER NOT NULL DEFAULT 0,
    "watchedSec" INTEGER NOT NULL DEFAULT 0,
    "durationSecAtView" INTEGER NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "referrer" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "country" TEXT,
    "city" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecordingView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordingComment" (
    "id" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "authorEmail" TEXT,
    "viewerId" TEXT,
    "atSec" INTEGER,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RecordingComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Recording_shareToken_key" ON "Recording"("shareToken");

-- CreateIndex
CREATE INDEX "Recording_shareToken_idx" ON "Recording"("shareToken");

-- CreateIndex
CREATE INDEX "Recording_folderId_idx" ON "Recording"("folderId");

-- CreateIndex
CREATE INDEX "RecordingReaction_recordingId_idx" ON "RecordingReaction"("recordingId");

-- CreateIndex
CREATE INDEX "RecordingView_recordingId_createdAt_idx" ON "RecordingView"("recordingId", "createdAt");

-- CreateIndex
CREATE INDEX "RecordingView_recordingId_viewerId_idx" ON "RecordingView"("recordingId", "viewerId");

-- CreateIndex
CREATE UNIQUE INDEX "RecordingView_recordingId_sessionId_key" ON "RecordingView"("recordingId", "sessionId");

-- CreateIndex
CREATE INDEX "RecordingComment_recordingId_createdAt_idx" ON "RecordingComment"("recordingId", "createdAt");

