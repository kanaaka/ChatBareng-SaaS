-- CreateTable
CREATE TABLE "Blast" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT,
    "message" TEXT NOT NULL,
    "totalSent" INTEGER NOT NULL DEFAULT 0,
    "totalFailed" INTEGER NOT NULL DEFAULT 0,
    "totalRecipients" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "delayPerMsg" INTEGER NOT NULL DEFAULT 5,
    "delayPerGroup" INTEGER NOT NULL DEFAULT 60,
    "groupSize" INTEGER NOT NULL DEFAULT 100,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdBy" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Blast_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BlastLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "blastId" INTEGER NOT NULL,
    "chatId" TEXT,
    "phoneNumber" TEXT,
    "contactName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "sentAt" DATETIME,
    CONSTRAINT "BlastLog_blastId_fkey" FOREIGN KEY ("blastId") REFERENCES "Blast" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
