// ═════════════════════════════════════════════════════════════════
// v3.9.23 — Service LLM (Ollama Cloud + fallback Ollama lokal) — NEW.
// Spec docs/spec-v3.9.23-ai-summary.md §B/§D. Fitur 100% MANDIRI dari
// OpenClaw/gateway (keputusan Kanaka): ChatBareng call langsung ke provider,
// key disimpan ENCRYPTED di DB app sendiri (textCrypto), zero callback.
//
// FACTS terverifikasi (2026-09-25, jangan dipertanyakan ulang):
// - POST {cloudBaseUrl}/api/chat + Bearer key → 200, shape
//   {model, messages:[{role,content}], stream:false} → {message:{content}}.
// - GET {cloudBaseUrl}/api/tags + Bearer key → 200 {models:[{name,size,…}]}.
// - Key format bebas (bukan sk-); shape sama dgn local Ollama.
// - Key TIDAK PERNAH ke-log/print/response/error message (spec §G).
// ═════════════════════════════════════════════════════════════════
const prisma = require('../prisma')
const { encryptText, decryptTextSafe, isEncrypted } = require('./textCrypto')

const DEFAULT_CLOUD_BASE_URL = 'https://ollama.com'
const DEFAULT_CLOUD_MODEL = 'glm-5.3-flash'
const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11434'
const CHAT_TIMEOUT_MS = 60000
const LOCAL_PING_TIMEOUT_MS = 2000

// ─── Preset template summary (satu sumber, dipakai backend + validasi FE) ──
// Teks instruksi = spec §D. `standard` = 4 blok plain-text w/ heading.
const SUMMARY_PRESETS = {
  standard:
    'Buat ringkasan sesi customer service dari percakapan berikut dalam format plain text 4 blok, masing-masing diawali heading diikuti titik dua lalu isinya:\n' +
    'RINGKASAN: <2-4 kalimat kronologi percakapan>\n' +
    'KEBUTUHAN CUSTOMER: <poin kebutuhan/permintaan utama>\n' +
    'TINDAKAN CS: <yang sudah dilakukan agent>\n' +
    'STATUS & LANGKAH LANJUT: <status sekarang + next step konkret>',
  ringkas:
    'Buat ringkasan sesi customer service dari percakapan berikut: SATU paragraf 3-5 kalimat yang merangkum seluruh sesi (tanpa heading, tanpa bullet).',
  handoff:
    'Buat catatan serah terima shift (handoff) dari percakapan berikut untuk CS yang akan lanjut melayani. Sertakan: status percakapan sekarang, yang SUDAH dilakukan, yang BELUM selesai, dan instruksi konkret langkah berikutnya untuk CS penerima (gunakan bullet).',
  medis:
    'Buat ringkasan percakapan pasien/klinik dari percakapan berikut: keluhan/kebutuhan pasien, layanan atau jadwal yang ditanyakan, harga yang dibahas, dan tindak lanjut yang disarankan.',
  penjualan:
    'Buat ringkasan percakapan penjualan dari percakapan berikut: produk/layanan yang diminati, keberatan (objection) customer, harga/penawaran yang dibahas, dan next step closing.',
  keluhan:
    'Buat ringkasan percakapan keluhan (komplain) dari percakapan berikut: isi komplain, tingkat urgensi, solusi yang ditawarkan, dan status kepuasan customer saat ini.',
}

const PRESET_KEYS = Object.keys(SUMMARY_PRESETS)
const CUSTOM_TEXT_MAX = 1000

// RAIL WAJIB anti-halusinasi — SELALU ditambahkan setelah instruksi apapun (spec §D).
const RAIL_ANTI_HALUSINASI =
  'Gunakan HANYA isi percakapan berikut. JANGAN mengarang fakta yang tidak ada di percakapan. Jawab dalam Bahasa Indonesia.'

/**
 * getAiConfig() → { cloudBaseUrl, cloudModel, apiKey|null, localBaseUrl,
 * localModel|null, fallbackEnabled, defaultPreset, hasKey } ATAU null bila
 * row belum ada (fitur off). Dekrip on-demand; key tidak pernah di-log.
 */
async function getAiConfig() {
  let row
  try {
    row = await prisma.aiConfig.findUnique({ where: { id: 1 } })
  } catch (e) {
    console.error('[LLM] getAiConfig error:', e.message)
    return null
  }
  if (!row) return null
  let apiKey = null
  if (row.apiKeyEnc) {
    const plain = decryptTextSafe(row.apiKeyEnc)
    if (typeof plain === 'string' && plain && plain !== '[decrypt gagal]') apiKey = plain
  }
  return {
    cloudBaseUrl: (row.cloudBaseUrl || DEFAULT_CLOUD_BASE_URL).replace(/\/+$/, ''),
    cloudModel: row.cloudModel || DEFAULT_CLOUD_MODEL,
    apiKey,
    localBaseUrl: (row.localBaseUrl || DEFAULT_LOCAL_BASE_URL).replace(/\/+$/, ''),
    localModel: row.localModel || null,
    fallbackEnabled: !!row.fallbackEnabled,
    defaultPreset: row.defaultPreset || 'standard',
    hasKey: !!apiKey,
  }
}

/**
 * aiChat({messages, timeoutMs}) → POST {base}/api/chat.
 * Return { ok:true, content, model, latencyMs, viaFallback? }
 *    atau { ok:false, code: NO_CONFIG|AUTH_401|TIMEOUT|NETWORK|UPSTREAM_5XX, message, latencyMs, viaFallback? }.
 * Fallback logic: primary gagal (NETWORK/TIMEOUT/5XX) + fallbackEnabled + local
 * reachable (ping /api/tags 2s) → retry 1x ke local, flag viaFallback:true.
 */
async function aiChat({ messages, model = null, timeoutMs = CHAT_TIMEOUT_MS, fallback = true }) {
  const cfg = await getAiConfig()
  if (!cfg || !cfg.cloudBaseUrl || !cfg.cloudModel || !cfg.apiKey) {
    return { ok: false, code: 'NO_CONFIG', message: 'AI belum dikonfigurasi. Hubungi admin platform.' }
  }
  const primaryModel = model || cfg.cloudModel
  const primary = await chatOnce({
    baseUrl: cfg.cloudBaseUrl,
    apiKey: cfg.apiKey,
    model: primaryModel,
    messages,
    timeoutMs,
  })
  if (primary.ok) return { ...primary, viaFallback: false }

  // Fallback path — HANYA utk failure teknis (bukan 401 auth / NO_CONFIG).
  const canFallback =
    fallback && cfg.fallbackEnabled && cfg.localBaseUrl && ['NETWORK', 'TIMEOUT', 'UPSTREAM_5XX'].includes(primary.code)
  if (!canFallback) return primary

  const reachable = await pingLocal(cfg.localBaseUrl)
  if (!reachable) {
    return {
      ...primary,
      message: `AI cloud gagal (${primary.code}) dan fallback lokal tidak terdeteksi di ${cfg.localBaseUrl}.`,
    }
  }
  const localModel = cfg.localModel || primaryModel
  const retry = await chatOnce({
    baseUrl: cfg.localBaseUrl,
    apiKey: null, // lokal tanpa Bearer
    model: localModel,
    messages,
    timeoutMs,
  })
  if (retry.ok) return { ...retry, viaFallback: true }
  return {
    ok: false,
    code: retry.code,
    message: `AI cloud gagal (${primary.code}) dan fallback lokal juga gagal (${retry.code}).`,
    latencyMs: (primary.latencyMs || 0) + (retry.latencyMs || 0),
    viaFallback: true,
  }
}

/** Satu call chat ke satu baseUrl. Error → {ok:false, code, message} (key tidak pernah dilog). */
async function chatOnce({ baseUrl, apiKey, model, messages, timeoutMs }) {
  const started = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs || CHAT_TIMEOUT_MS))
  try {
    const headers = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, stream: false }),
      signal: ctrl.signal,
    })
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'AUTH_401', message: 'API key tidak valid atau tidak punya akses model ini.', latencyMs }
    }
    if (res.status >= 500) {
      return { ok: false, code: 'UPSTREAM_5XX', message: 'Server AI bermasalah (5xx) — coba lagi nanti.', latencyMs }
    }
    if (!res.ok) {
      return { ok: false, code: 'NETWORK', message: `Server AI menolak request (HTTP ${res.status}).`, latencyMs }
    }
    const data = await res.json().catch(() => null)
    const content = typeof data?.message?.content === 'string' ? data.message.content : null
    if (content == null) {
      return { ok: false, code: 'NETWORK', message: 'Respon AI tidak dikenali (message.content kosong).', latencyMs }
    }
    return { ok: true, content, model: data?.model || model, latencyMs }
  } catch (e) {
    const latencyMs = Date.now() - started
    if (e?.name === 'AbortError') {
      return { ok: false, code: 'TIMEOUT', message: 'AI tidak merespons dalam batas waktu — coba lagi.', latencyMs }
    }
    return { ok: false, code: 'NETWORK', message: 'Tidak bisa terhubung ke server AI (jaringan).', latencyMs }
  } finally {
    clearTimeout(timer)
  }
}

/** Ping Ollama lokal: GET {localBaseUrl}/api/tags timeout 2s → bool. */
async function pingLocal(localBaseUrl) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), LOCAL_PING_TIMEOUT_MS)
  try {
    const res = await fetch(`${localBaseUrl}/api/tags`, { signal: ctrl.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * aiListModels({baseUrl, apiKey}) → GET {baseUrl}/api/tags
 * → {ok:true, models:[{name, sizeBytes}]} | {ok:false, code, message}.
 */
async function aiListModels({ baseUrl, apiKey }) {
  if (!baseUrl) return { ok: false, code: 'NO_CONFIG', message: 'Base URL belum diisi.' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const headers = {}
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tags`, { headers, signal: ctrl.signal })
    if (res.status === 401) return { ok: false, code: 'AUTH_401', message: 'API key tidak valid.' }
    if (res.status >= 500) return { ok: false, code: 'UPSTREAM_5XX', message: 'Server AI bermasalah (5xx).' }
    if (!res.ok) return { ok: false, code: 'NETWORK', message: `Server menolak request (HTTP ${res.status}).` }
    const data = await res.json().catch(() => null)
    const list = Array.isArray(data?.models) ? data.models : null
    if (!list) return { ok: false, code: 'NETWORK', message: 'Daftar model tidak valid dari server.' }
    return {
      ok: true,
      models: list.map((m) => ({
        name: String(m?.name || m?.model || '').trim(),
        sizeBytes: Number(m?.size) || 0,
      })).filter((m) => m.name),
    }
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, code: 'TIMEOUT', message: 'Timeout mengambil daftar model.' }
    return { ok: false, code: 'NETWORK', message: 'Tidak bisa terhubung ke server AI (jaringan).' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * aiTestConnection({baseUrl, apiKey, model}) → 1 call mini.
 * → {ok:true, latencyMs, model} | {ok:false, code, message, latencyMs}.
 */
async function aiTestConnection({ baseUrl, apiKey, model, timeoutMs = 30000 }) {
  const r = await chatOnce({
    baseUrl: String(baseUrl || '').replace(/\/+$/, ''),
    apiKey,
    model,
    messages: [{ role: 'user', content: 'Balas persis satu kata: siap' }],
    timeoutMs,
  })
  if (r.ok) return { ok: true, latencyMs: r.latencyMs, model: r.model }
  return { ok: false, code: r.code, message: r.message, latencyMs: r.latencyMs }
}

/**
 * Resolusi template summary (spec §D):
 *   TenantSummaryTemplate customText non-kosong → 'custom'
 *   else presetKey tenant → preset itu
 *   tenant tanpa row → AiConfig.defaultPreset (fallback 'standard').
 * Return { kind:'preset'|'custom', presetKey, customText, prompt }.
 */
function resolveTemplate(tplRow, aiCfg) {
  const custom = typeof tplRow?.customText === 'string' ? tplRow.customText.trim() : ''
  if (custom) {
    return { kind: 'custom', presetKey: null, customText: custom, prompt: custom }
  }
  let preset = tplRow?.presetKey && PRESET_KEYS.includes(tplRow.presetKey) ? tplRow.presetKey : null
  if (!preset) {
    const dp = aiCfg?.defaultPreset
    preset = dp && PRESET_KEYS.includes(dp) ? dp : 'standard'
  }
  return { kind: 'preset', presetKey: preset, customText: null, prompt: SUMMARY_PRESETS[preset] }
}

/** System prompt final = template aktif + RAIL WAJIB (selalu ditambahkan). */
function buildSystemPrompt(template) {
  return `${template.prompt}\n\n${RAIL_ANTI_HALUSINASI}`
}

module.exports = {
  DEFAULT_CLOUD_BASE_URL,
  DEFAULT_CLOUD_MODEL,
  DEFAULT_LOCAL_BASE_URL,
  CHAT_TIMEOUT_MS,
  SUMMARY_PRESETS,
  PRESET_KEYS,
  CUSTOM_TEXT_MAX,
  RAIL_ANTI_HALUSINASI,
  getAiConfig,
  aiChat,
  aiListModels,
  aiTestConnection,
  pingLocal,
  resolveTemplate,
  buildSystemPrompt,
  encryptText, // re-export utk endpoint SA (simpan key ENCRYPTED)
  isEncrypted,
}