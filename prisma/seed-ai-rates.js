// v3.9.24 — Seed idempoten: 17 rate model AI (per 1M token, USD) ke AiModelRate.
// Sumber harga: ollama.com/pricing (fetch 2026-09-26 02:19, spec docs/spec-v3.9.24-
// ai-usage.md §7). cachedPerM NULL (mistral-large-3, nemotron-3-nano) = pakai rate
// input utk token cached (konservatif, D7). usdToIdr TIDAK di-set di sini (default
// kolom sudah 16000). Idempoten: upsert per model — aman dijalankan berulang.
// Usage: node prisma/seed-ai-rates.js [path-db-copy]   (argumen = override DB copy)
const path = require('path')
process.env.NODE_ENV = process.env.NODE_ENV || 'production'
const { PrismaClient } = require('@prisma/client')

const AI_RATES_SEED = [
  { model: 'glm-5.3-flash', inputPerM: 0.15, cachedPerM: 0.03, outputPerM: 0.5 },
  { model: 'glm-5.3', inputPerM: 1.4, cachedPerM: 0.26, outputPerM: 4.4 },
  { model: 'glm-5.2', inputPerM: 1.4, cachedPerM: 0.26, outputPerM: 4.4 },
  { model: 'kimi-k3', inputPerM: 3.0, cachedPerM: 0.3, outputPerM: 15.0 },
  { model: 'kimi-k2.6', inputPerM: 0.95, cachedPerM: 0.16, outputPerM: 4.0 },
  { model: 'kimi-k2.7-code', inputPerM: 0.95, cachedPerM: 0.19, outputPerM: 4.0 },
  { model: 'deepseek-v4.1-flash', inputPerM: 0.3, cachedPerM: 0.006, outputPerM: 1.2 },
  { model: 'deepseek-v4-pro', inputPerM: 1.32, cachedPerM: 0.044, outputPerM: 3.96 },
  { model: 'minimax-m3', inputPerM: 0.6, cachedPerM: 0.12, outputPerM: 2.4 },
  { model: 'minimax-m2.7', inputPerM: 0.3, cachedPerM: 0.06, outputPerM: 1.2 },
  { model: 'gpt-oss:120b', inputPerM: 0.15, cachedPerM: 0.014, outputPerM: 0.6 },
  { model: 'gpt-oss:20b', inputPerM: 0.07, cachedPerM: 0.035, outputPerM: 0.3 },
  { model: 'gemma4', inputPerM: 0.14, cachedPerM: 0.05, outputPerM: 0.4 },
  { model: 'mistral-large-3', inputPerM: 0.5, cachedPerM: null, outputPerM: 1.5 },
  { model: 'nemotron-3-nano', inputPerM: 0.06, cachedPerM: null, outputPerM: 0.24 },
  { model: 'nemotron-3-super', inputPerM: 0.015, cachedPerM: 0.015, outputPerM: 0.6 },
  { model: 'nemotron-3-ultra', inputPerM: 0.1, cachedPerM: 0.1, outputPerM: 3.0 },
]

// Default: DB produksi dari .env (DATABASE_URL). Override via argumen utk DB copy
// (pola seed-api-access.js).
const prisma = new PrismaClient({
  datasources: process.argv[2] ? { db: { url: 'file:' + process.argv[2] } } : undefined,
})

async function main() {
  let created = 0
  let updated = 0
  for (const r of AI_RATES_SEED) {
    const existing = await prisma.aiModelRate.findUnique({ where: { model: r.model } })
    if (!existing) {
      await prisma.aiModelRate.create({ data: r })
      console.log(`[Seed] create: ${r.model} (in ${r.inputPerM} / cached ${r.cachedPerM ?? 'null'} / out ${r.outputPerM} per 1M)`)
      created++
    } else {
      await prisma.aiModelRate.update({ where: { model: r.model }, data: r })
      console.log(`[Seed] update: ${r.model}`)
      updated++
    }
  }
  console.log(`[Seed] AI rates selesai — ${created} created, ${updated} updated (${AI_RATES_SEED.length} model target)`)
}

main()
  .catch((e) => {
    console.error('[Seed] error:', e.message)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())