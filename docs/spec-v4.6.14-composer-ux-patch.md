# Spec v4.6.14 — FEATURE: Quick Message `/` Anywhere + Auto-Focus Composer + Mobile QueueBanner Hide + Media Attach Preview Modal (FE-only)

**Request (Kanaka, 2026-11-13 10:55 & 11:07):**
1. Fitur quick message `/` ke-trigger juga saat diketik di tengah/akhir chat maupun setelah baris baru (tidak cuma kalau jadi awalan chat atau habis spasi).
2. Saat klik chat di chat list (sebelah kiri), fokus otomatis masuk ke typing box di Desktop supaya bisa langsung ketik tanpa klik manual (di Mobile tidak perlu auto-focus).
3. Di tampilan Mobile, banner "Take / Ambil" chat (`QueueBanner`) disembunyikan saat user sudah masuk ke dalam ruang chat (`isMobileDetail`), supaya hanya muncul di halaman Chat List dan tidak menutupi text field bawah.
4. Saat attach file/gambar dari tombol Attach (📎) atau paste gambar (`Ctrl+V`), jangan langsung terkirim — tampilkan Modal Preview + input Caption (opsional) terlebih dahulu seperti perilaku insert media dari `TanganKanan.vue`.

## Scope (FE-only — 0 backend, 0 DB, 0 migration, 0 dependency baru)
- EDIT `frontend/src/views/Dashboard.vue`
- EDIT `frontend/src/views/ChatDetail.vue`
- EDIT `frontend/src/views/Groups.vue` (paritas auto-focus desktop & media preview modal)
- EDIT `CHANGELOG.md` (tambahkan section `# v4.6.14 (pending) — Composer UX: Slash Template Anywhere, Auto-Focus Desktop, Mobile QueueBanner Guard & Media Attach Preview Modal — 2026-11-13` di paling atas)

---

## Desain Teknis (Terkunci)

### D1 — Quick Message `/` Trigger di Mana Saja (Tengah/Akhir Teks & Multiline)
**Masalah saat ini (`Dashboard.vue` ~1031–1118):**
- Deteksi `watch(replyText)` dan `insertTemplateFromFlyout(tpl)` memakai `beforeCursor.lastIndexOf(' ') + 1`. Akibatnya:
  1. Jika user menekan `Shift+Enter` (baris baru `\n`) lalu mengetik `/promo`, `lastIndexOf(' ')` tidak menemukan `\n` sehingga `currentWord` berisi `"baris1\n/promo"` → `startsWith('/')` bernilai `false` (tidak trigger!).
  2. Jika user mengetik `/` di tengah/akhir kalimat (baik setelah spasi, baris baru, maupun menempel setelah tanda baca/kata), atau saat kursor digeser di dalam textarea, deteksi gagal karena hanya membaca `watch(replyText)` tanpa meng-handle posisi slash terakhir sebelum kursor.

**Solusi (`Dashboard.vue`):**
1. Buat helper `findSlashToken(text, cursorPos)`:
   - Ambil `beforeCursor = text.substring(0, cursorPos)`.
   - Cari indeks `/` terakhir di `beforeCursor`: `const slashIdx = beforeCursor.lastIndexOf('/')`.
   - Jika `slashIdx === -1`, return `null`.
   - Ambil substring dari `slashIdx` sampai `cursorPos`: `const token = beforeCursor.substring(slashIdx)`.
   - **Syarat valid token `/`:**
     - Tidak boleh mengandung spasi atau newline di dalam `token` (yaitu `!/\s/.test(token)` — begitu user mengetik spasi setelah keyword, flyout tertutup).
     - Agar tidak false-trigger pada URL (misal `https://...` atau `parahita.co.id/promo` atau tanggal `12/11/2026`): karakter tepat sebelum `slashIdx` (jika `slashIdx > 0`, yaitu `prevChar = beforeCursor[slashIdx - 1]`) TIDAK boleh berupa `:` atau `/` atau angka/huruf URL. ATAU sesuai permintaan Kanaka ("mau selipin template message di akhir teks / tengah chat"): izinkan `/` di awal string (`slashIdx === 0`), setelah whitespace apa pun (`/\s/.test(prevChar)` termasuk spasi `' '` dan newline `'\n'`), ATAU setelah karakter non-URL (selama sebelum `slashIdx` bukan bagian dari `http://` / `https://`, yaitu `!/https?:\/\/\S*$/i.test(beforeCursor.substring(0, slashIdx))`).
     - Dengan guard `!/https?:\/\/\S*$/i.test(beforeCursor.substring(0, slashIdx))` dan `!/\s/.test(token)`: ketik `"Halo kak /"` (dengan spasi), `"Halo kak/"` (tanpa spasi di akhir kata), atau habis `Shift+Enter` `"\n/"` **semuanya ke-trigger**! Sedangkan ketik `"https://parahita.co.id/lab"` tidak akan bocor men-trigger flyout.
   - Return `{ slashIdx, query: token.toLowerCase(), rawToken: token }`.
2. Di `watch(replyText)` (atau fungsi `updateSlashFlyout()`):
   - Gunakan `findSlashToken(newVal, cursorPos)`.
   - Jika ketemu token (`token.length >= 1`):
     - `const q = query.substring(1)` (teks setelah `/`).
     - Filter `allTemplates.value`: cocokkan `t.keyword.toLowerCase().includes(query)` atau `t.keyword.toLowerCase().replace(/^\//, '').includes(q)` atau `t.name.toLowerCase().includes(q)`.
     - Ambil `.slice(0, 8)` (atau 5 seperti existing). Set `templateMatches.value`, `showTemplateFlyout.value = matches.length > 0`, `selectedTemplateIndex.value = 0`.
3. Di `insertTemplateFromFlyout(tpl)`:
   - Gunakan `findSlashToken(replyText.value, cursorPos)` untuk mendapatkan `slashIdx`.
   - Fallback jika `null`: `slashIdx = Math.max(beforeCursor.lastIndexOf(' '), beforeCursor.lastIndexOf('\n')) + 1`.
   - Ganti tepat dari `slashIdx` sampai `cursorPos` dengan `tpl.content`:
     ```js
     const prefix = replyText.value.substring(0, slashIdx)
     // Jika karakter sebelum '/' bukan whitespace dan bukan awal string, tambahkan 1 spasi pemisah bila perlu?
     // Tidak perlu mengubah prefix jika sudah ada spasi; langsung sambung prefix + tpl.content + afterCursor
     replyText.value = prefix + tpl.content + afterCursor
     ```
   - Tutup flyout (`showTemplateFlyout.value = false; templateMatches.value = []`).
   - `nextTick`: fokus kembali ke `input` (`replyInputRef`), set posisi kursor tepat di `slashIdx + tpl.content.length`, dan panggil autoGrow.

---

### D2 — Auto-Focus ke Typing Box Saat Klik Chat List (Desktop Only)
**Masalah saat ini:**
- Di `Dashboard.vue`, `selectChat(chat)` memuat detail chat dan memanggil `scrollToBottom()`, tetapi tidak memanggil `chatDetailRef.value?.focusReply()`. CS harus mengklik manual ke dalam textarea sebelum mengetik.
- Selain itu, saat `selectChat(chat)` dipanggil pertama kali dari state `currentChat === null`, `ChatDetail` baru di-mount setelah `currentChat.value` terisi, sehingga fokus perlu dipanggil di dalam `nextTick()`.

**Solusi (`Dashboard.vue`, `ChatDetail.vue`, `Groups.vue`):**
1. Di `ChatDetail.vue`:
   - Method `focusReply()` yang sudah di-`defineExpose` diperkuat:
     ```js
     function focusReply() {
       if (isMobile.value) return // Mobile: jangan auto-focus supaya keyboard tidak pop-up menutupi layar
       nextTick(() => {
         if (replyInputRef.value && !replyInputRef.value.disabled) {
           replyInputRef.value.focus()
         }
       })
     }
     ```
   - Tambahkan juga di `watch(() => props.chat?.id)` dan `onMounted()` di `ChatDetail.vue`: jika `!isMobile.value`, panggil `focusReply()`.
2. Di `Dashboard.vue`:
   - Di akhir `selectChat()` (setelah `currentChat.value = chats.currentChat` dan `scrollToBottom()`) serta di akhir `handleAssign()` (saat CS klik Take chat):
     ```js
     if (!isMobile.value) {
       nextTick(() => chatDetailRef.value?.focusReply())
     }
     ```
3. Di `Groups.vue`:
   - Tambahkan `ref="chatDetailRef"` pada `<ChatDetail ... />` dan di akhir `fetchGroupChat(chatId)` panggil `if (!isMobileViewport()) nextTick(() => chatDetailRef.value?.focusReply())`.

---

### D3 — Sembunyikan `QueueBanner` di Mobile Saat Di Dalam Ruang Chat
**Masalah saat ini (`Dashboard.vue:297`):**
- `<QueueBanner v-if="!auth.isRelay" :count="queueCount" :taking="chats.taking" @take="handleTakeNext" />` tidak memiliki guard `!isMobileDetail`, berbeda dengan `<Homerow :visible="!isMobileDetail" />` tepat di bawahnya.
- Akibatnya, saat CS membuka ruang chat di layar mobile (`isMobileDetail === true`), banner fixed bottom "📨 X chat baru di antrean [Take]" tetap muncul melayang di atas area composer/text field.

**Solusi (`Dashboard.vue:297`):**
- Ubah direktif `v-if` pada `<QueueBanner>` menjadi:
  ```html
  <QueueBanner v-if="!auth.isRelay && !isMobileDetail" :count="queueCount" :taking="chats.taking" @take="handleTakeNext" />
  ```
- Di Desktop tidak terpengaruh sama sekali (banner antrean desktop ada di dalam kolom kiri `ChatListPane`).

---

### D4 — Modal Preview & Input Caption Saat Attach File/Gambar (Mirip `TanganKanan.vue`)
**Masalah saat ini (`ChatDetail.vue` & `Dashboard.vue`):**
- Di `ChatDetail.vue`, `<input ref="fileInputRef" type="file" ... @change="$emit('upload-media', $event)" />` langsung men-trigger `handleFileUpload(event)` di `Dashboard.vue` yang seketika mengirim file via `POST /api/chats/:id/media` tanpa preview maupun kesempatan mengisi/mengedit caption.

**Solusi (`ChatDetail.vue`, `Dashboard.vue`, `Groups.vue`):**
1. **Tangkap Pemilihan File & Paste di `ChatDetail.vue`:**
   - Ubah `@change` pada `<input ref="fileInputRef" type="file">` menjadi `@change="onFileSelected($event)"`.
   - Tambahkan juga `@paste="onReplyPaste($event)"` pada `<textarea ref="replyInputRef">`: jika clipboard mengandung file gambar/media (`e.clipboardData?.files?.length > 0`), `e.preventDefault()` dan buka modal preview untuk file tersebut!
   - Buat state lokal di `ChatDetail.vue`:
     - `pendingMediaFile = ref(null)` (`File` object)
     - `pendingMediaPreviewUrl = ref(null)` (ObjectURL / DataURL untuk `image/*`, `null` untuk non-image; jangan lupa `URL.revokeObjectURL` saat bersih-bersih)
     - `pendingMediaCaption = ref('')`
     - `captionInputRef = ref(null)`
   - Saat `onFileSelected(event)` atau `onReplyPaste(event)` menerima `file`:
     - Jika `props.sendDisabled` atau `props.sendingMedia`, abaikan.
     - Simpan `pendingMediaFile.value = file`.
     - Prefill `pendingMediaCaption.value = props.replyText || ''` (kalau CS sudah sempat mengetik teks di composer, pindahkan ke input caption modal agar tidak hilang).
     - Jika `file.type.startsWith('image/')`, buat preview URL (`URL.createObjectURL(file)`).
     - Reset `event.target.value = ''` agar file yang sama bisa dipilih ulang jika dibatalkan.
     - `nextTick(() => captionInputRef.value?.focus())`.
2. **UI Modal Preview + Caption di `ChatDetail.vue` (Gaya `TanganKanan.vue`):**
   - Render modal overlay (`v-if="pendingMediaFile"`, `fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4`, klik backdrop = batal):
     - Card putih/surface (`bg-[var(--md-sys-color-surface-container)] text-[var(--md-sys-color-on-surface)] rounded-xl shadow-xl w-96 max-w-full p-4`):
       - **Header:** `"Kirim {{ pendingMediaFile.type.startsWith('image/') ? 'gambar' : 'file' }} ke {{ chat.contactName || chat.contactPhone }}?"` + tombol `✕`.
       - **Preview Box:**
         - Jika gambar (`pendingMediaPreviewUrl`): `<img :src="pendingMediaPreviewUrl" class="w-full max-h-56 object-contain bg-black/5 rounded-lg mb-2" :alt="pendingMediaFile.name" />` + info kecil nama file & ukuran.
         - Jika bukan gambar (PDF/video/audio/dokumen): box kartu berikon (`🎬` video / `🎵` audio / `📄` dokumen) + nama file (`pendingMediaFile.name`) + ukuran file dalam KB/MB.
       - **Input Caption:**
         - Label: `Caption (opsional)`
         - `<textarea ref="captionInputRef" v-model="pendingMediaCaption" rows="2" placeholder="Tambahkan caption..." @keydown="onCaptionKeydown" class="w-full px-3 py-2 text-sm border border-[var(--md-sys-color-outline)] rounded-lg bg-transparent text-[var(--md-sys-color-on-surface)] focus:ring-2 focus:ring-wa-green focus:border-transparent resize-none mb-3"></textarea>`
         - `onCaptionKeydown(e)`: `Enter` tanpa `Shift` (`!e.shiftKey && !e.isComposing`) → `e.preventDefault(); confirmSendMedia()`; `Escape` → `cancelSendMedia()`.
       - **Tombol Aksi:**
         - Tombol **Send / Kirim** (`bg-wa-green text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-green-600 disabled:opacity-50 flex-1`, `:disabled="sendingMedia"`, `@click="confirmSendMedia"`).
         - Tombol **Cancel / Batal** (`bg-gray-200 text-gray-700 rounded-lg px-4 py-2 text-sm hover:bg-gray-300`, `@click="cancelSendMedia"`).
   - Saat pindah chat (`watch(() => props.chat?.id)`), panggil `cancelSendMedia()` agar modal tertutup bersih.
3. **Kirim Media ke Parent (`upload-media` Emit Contract Backward-Compatible):**
   - Di `confirmSendMedia()`:
     - Emit `'upload-media'` dengan payload yang kompatibel baik untuk `Dashboard.vue` maupun `Groups.vue`:
       ```js
       const file = pendingMediaFile.value
       const caption = pendingMediaCaption.value.trim()
       // Sinkronkan replyText ke caption supaya parent yang membaca replyText (atau payload.caption) sama-sama dapat
       emit('update:replyText', caption)
       emit('upload-media', { file, caption, target: { files: [file], value: '' } })
       cancelSendMedia()
       ```
   - Di `Dashboard.vue` (`handleFileUpload(payload)`):
     - Dukung `const file = payload?.file || payload?.target?.files?.[0]`.
     - Ambil caption dari `const caption = payload?.caption !== undefined ? payload.caption : replyText.value.trim()`. Jika ada `caption`, `formData.append('caption', caption)`.
   - Di `Groups.vue` (`onUploadMedia(payload)`):
     - Dukung `const file = payload?.file || payload?.target?.files?.[0]`.
     - Ambil `const caption = payload?.caption !== undefined ? payload.caption : replyText.value.trim()`. Jika ada `caption`, `form.append('caption', caption)`, dan setelah sukses reset `replyText.value = ''`.

---

## NON-GOALS & CONSTRAINTS
- **0 perubahan backend / DB / Prisma / migration.** Endpoint `POST /api/chats/:id/media` di `src/routes/chats.js` sudah menerima field `caption` di `multipart/form-data`.
- **SystemLog noise classes untouched** (sesuai doktrin `chatbareng-it-release`).
- Verifikasi build frontend: jalankan `cd frontend && npm run build` (atau `npx vite build`) dan pastikan exit 0 tanpa error, lalu periksa bundle output.
- Jangan hapus atau merusak perubahan `v4.6.12` dan `v4.6.13` yang sudah ada di pohon repo.

## Deliverable Dory
1. Terapkan D1–D4 pada `frontend/src/views/Dashboard.vue`, `frontend/src/views/ChatDetail.vue`, `frontend/src/views/Groups.vue`, dan update `CHANGELOG.md`.
2. Jalankan build frontend (`cd frontend && npm run build`) dan pastikan sukses (exit 0).
3. Verifikasi dengan script test / node check bahwa:
   - Helper `findSlashToken` mendeteksi `/keyword` di awal teks, setelah spasi, setelah `\n` (multiline), dan di akhir teks tanpa bocor pada `https://...`.
   - `QueueBanner` di `Dashboard.vue` memiliki guard `!isMobileDetail`.
   - `focusReply` dipanggil saat `selectChat` di desktop dan memiliki guard `if (isMobile.value) return`.
   - Modal preview media (`pendingMediaFile`, `pendingMediaCaption`, `confirmSendMedia`) ter-render dan ter-bundle di output build.
4. Laporkan ringkasan file yang diubah dan hasil verifikasi build ke Alita.
