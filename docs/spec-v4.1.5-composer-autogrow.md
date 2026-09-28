# Spec v4.1.5 — FEATURE: Composer auto-grow textarea (max 6 baris, scroll internal) — pola WhatsApp Web

**Request (Kanaka, 2026-09-28 18:27):** "text field waktu ngechat itu bisa makin tinggi (sampai batas tertentu yang udah ditentukan) seiring dengan kita melakukan enter enter teks. Kan kayak di WhatsApp web, kalau kita enter, text area nya jadi lebih lebar. Tapi dia juga ada batasnya, kayak mungkin sekitar maksimal 6 baris, baru scroll sendiri."

**GO (Kanaka, 2026-09-28 18:37):** "iya betul di WhatsApp pakai shift enter. Okedeeh langsung terapkan" → **Opsi A**: **Enter = kirim** (pola WA Web), **Shift+Enter = baris baru**.

## State existing (sudah diverifikasi)
- `frontend/src/views/ChatDetail.vue`:725-735 — reply field `<input type="text">` single-line (ref=replyInputRef). Component emits `update:replyText` (input) + `reply-keydown` (keydown).
- `frontend/src/views/Dashboard.vue`:1025-1068 — `handleReplyKeydown(e)`: branch slash-flyout (Arrow/Enter/Esc/Space) atau else `if (e.key === 'Enter') { sendReply() }` (TENANT LOCKED = prevent). ComposerHeight pattern §3.2: `composerHeight.value = composerBar.value.offsetHeight || 72` (di-resize listener, line 1196).
- `frontend/src/views/ChatDetail.vue`:821 — emits termasuk `'reply-keydown'`.
- `frontend/src/views/Groups.vue`:267-270 — **precedent** persis: `onGroupReplyKeydown(e) { if (e.key === 'Enter' && !e.shiftKey) { ... } }` sudah pakai pola Enter=send, Shift+Enter=newline (konsisten untuk multi-line compose).
- Backend: gak ada perubahan — `chats.sendReply` di store menerima replyText multi-line apa adanya (WA/WhatsApp Web behavior sama).

## D1 — Composer reply field: <input type="text"> → <textarea auto-resize>
- Ganti di `views/ChatDetail.vue:725-735`:
  - Element: `<textarea ref="replyInputRef" ...></textarea>` (pertahankan ref + emit pattern identik).
  - Attributes: `rows="1"`, `:value="replyText"`, `@input="$emit('update:replyText', $event.target.value)"`, `@keydown="$emit('reply-keydown', $event)"`, `:placeholder="replyPlaceholder"`, `:disabled="sendingMedia"`.
  - Class baru (ganti `rounded-full` jadi rounded-lg supaya multiline natural; padding tetap comfortable):
    `w-full px-4 py-2.5 border border-[var(--md-sys-color-outline)] rounded-2xl text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] bg-transparent focus:ring-2 focus:ring-wa-green focus:border-transparent disabled:opacity-50 resize-none overflow-y-auto leading-snug max-h-[10.5rem]` (≈ 6 baris × 1.5rem line-height + 0.75rem extra).
  - **D1a — Auto-grow handler** (script setup): `function autoGrow(el) { if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, parseInt(getComputedStyle(el).maxHeight)) + 'px'; el.style.overflowY = el.scrollHeight > parseInt(getComputedStyle(el).maxHeight) ? 'auto' : 'hidden'; }`. Dipanggil:
    1. `@input="$emit('update:replyText', $event.target.value); autoGrow($event.target)"`.
    2. **watch replyText** (di ChatDetail) → autoGrow(replyInputRef.value) — biar reset ke 1 baris saat replyText di-clear eksternal (e.g. successful send, swap chat).
    3. **onMounted** (jika ada) → autoGrow(replyInputRef.value).
- **D1b — ComposerHeight aman**: `composerHeight.value = composerBar.value.offsetHeight || 72` di Dashboard sudah auto-update saat DOM layout berubah (visualViewport pattern §3.2 di line 1134+). TIDAK perlu ubah; tombol scroll-to-bottom & popover emoji tetep presisi.

## D2 — Enter = kirim, Shift+Enter = newline (parent handle)
- Edit `views/Dashboard.vue:1025-1068` di branch else (no flyout):
  - Sebelumnya: `if (e.key === 'Enter') { ... sendReply() ... }` — Enter selalu kirim.
  - Baru: `if (e.key === 'Enter' && !e.shiftKey) { if (tenantLocked.value) { e.preventDefault(); return; } sendReply(); return; }` — persis pola `onGroupReplyKeydown` di Groups.vue:267-270.
  - **Shift+Enter**: native textarea newline (default behavior), TIDAK ada preventDefault. Shift+Enter key hanya-fire keydown listener biasa; karena tidak preventDefault → newline masuk.
  - IME (komposisi karakter Asia): biarkan `e.isComposing` (atau `keyCode === 229`) tetap newline — tanpa ini, ngetik Mandarin/Jepang dengan Enter konfirmasi IME akan trigger kirim. Pola aman: `if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { ... }`. Konsisten dgn Groups.vue (yang sudah add `&& !e.shiftKey`).
- **PENTING — handler slash-flyout Enter**: di branch `if (showTemplateFlyout.value) { if (e.key === 'Enter') { e.preventDefault(); insertTemplateFromFlyout(selected) } }` — TIDAK perlu `!e.shiftKey` di sini, karena konteks user lagi milih template (mau Enter=select), dan Shift+Enter pas milih template = newline di textarea → close flyout + newline, gak masuk akal. Biarkan.
- `onTyping()` di akhir tetap terpanggil (konsisten: bracket tracking per char yang user ketik).

## D3 — Konsistensi Groups.vue (composer group, udah multi-line)
- Sudah pakai pola Enter=send, Shift+Enter=newline (line 268). Kalau pakai `<input type="text">` saat ini di Groups.vue → cek apakah perlu di-upgrade jadi `<textarea>` + auto-grow juga. **Spec**: JANGAN ubah Groups.vue dalam fitur ini (cuma ChatBareng agent). Kalau Groups perlu, itu task terpisah. Note di changelog: "Groups.vue di luar scope; konsistensi untuk nanti".

## D4 — Pre-existing keys
- Escape (sedang edit di textarea): native Escape = blur atau gak ngapa-ngapain; **TIDAK** auto-close flyout/template. Konsisten WA Web.
- Slash flyout (groups) & template flyout: pola keyboard navigation tidak berubah (Arrow/Enter/Esc/Space).
- IME (key === 'Process' saat composing): TIDAK trigger send. `isComposing` guard.

## NON-GOALS
- Tidak ada perubahan backend (multi-line sudah jalan dari v0.x).
- Tidak ada migration / db change.
- Tidak mengubah palette / theme / warna tombol kirim.
- Tidak mengubah popover emoji picker (tetap absolute di atas composer).
- Tidak mengubah Groups.vue (di luar scope; tinggalin untuk task berikutnya jika perlu).
- CB-AI/autoReply/aiKnowledge = LOCKED (Kanaka 11:27) — jangan disentuh.

## Constraints (lesson wajib)
- Prod 5047 TIDAK BOLEH disentuh (build doang, ZERO backend restart). Pola seperti v4.1.3 & v4.1.3.1: FE-only → build → public/ → static serve, zero-downtime.
- NEVER `--force-reset`/`--accept-data-loss`/`DROP`/`rm` on any DB.
- Jangan install/uninstall node_modules. Jangan jalankan prisma command apapun.
- JANGAN commit/tag — parent yang deploy + finalisasi (lesson v4.1.3/3.1/4).
- Akhiri dengan `git status --short` — konfirmasi hanya file di bawah.

## Deliverable Dory (OUTPUT WAJIB di akhir turn)
1. File berubah: `frontend/src/views/ChatDetail.vue` (D1 textarea + autoGrow), `frontend/src/views/Dashboard.vue` (D2 Enter=send Shift=newline + IME guard), `CHANGELOG.md` (header paling atas `# v4.1.5 — FEATURE: Composer auto-grow textarea (max 6 baris, scroll internal, pola WhatsApp Web) (request Kanaka 2026-09-28 18:27, GO 18:37)` + 1 paragraf ringkas).
2. Verifikasi: `node --check frontend/src/views/ChatDetail.vue` (skip — n/a utk .vue; build vite adalah gate); `cd frontend && npx vite build --outDir /tmp/cb-autogrow-dist-test --emptyOutDir` exit 0 + grep bukti "max-h-\[10.5rem\]" + "autoGrow" di chunk hasil.
3. `git status --short` (project dir).
4. Konfirmasi eksplisit: prod 5047 tidak disentuh, 0 backend/CB-AI, tidak commit, tidak install deps.

## Konvensi rollback
- Kalau ComposerHeight gak ke-update pas autoGrow → fallback: pakai `setTimeout(() => composerHeight.value = composerBar.value?.offsetHeight || 72, 0)` di input handler (microtask, gak ganggu perf).
- Kalau `max-h` CSS gak konsisten lintas browser → gunakan JS-computed: `el.style.maxHeight = '10.5rem'` (langsung set di style attribute dari setup, biar pasti).