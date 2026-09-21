-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'cs',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLogin" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'active'
);

-- CreateTable
CREATE TABLE "Chat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactName" TEXT,
    "contactPhone" TEXT NOT NULL,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "assignedToId" INTEGER,
    "lastMessageAt" DATETIME,
    "lastMessagePreview" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Chat_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "chatId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "content" TEXT,
    "mediaPath" TEXT,
    "mediaType" TEXT,
    "mediaMime" TEXT,
    "mediaSize" INTEGER,
    "senderName" TEXT NOT NULL,
    "senderId" INTEGER,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "waMessageId" TEXT,
    "purged" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Message_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PurgeLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "purgeDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgedById" INTEGER NOT NULL,
    "chatCount" INTEGER NOT NULL,
    "messageCount" INTEGER NOT NULL,
    "reason" TEXT,
    CONSTRAINT "PurgeLog_purgedById_fkey" FOREIGN KEY ("purgedById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
