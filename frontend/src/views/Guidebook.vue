<template>
  <!--
    v0.12.0 — Guidebook: halaman panduan penggunaan ChatBareng (spec wa-cs-hub-v0.12.0-spec.md).
    KONTEN STATIS (teks di komponen, nihil DB). Route /guidebook PUBLIC (tanpa meta.auth).
    Design system M3 v0.9.0: token, m3-card, m3-chip, dark mode otomatis via [data-theme].
    3 tab role (default CS): 🛡️ Admin · 💬 CS · 🏪 Cabang. Topbar: ← back (router.back + fallback) + judul.
    Mobile: tab scrollable, satu kolom, touch target ≥44px.
  -->
  <div class="min-h-screen flex flex-col" :style="{ background: 'var(--md-sys-color-surface-container-low)' }">
    <!-- ═══ Topbar ringkas ═══ -->
    <header
      class="sticky top-0 z-30 m3-topbar px-3 sm:px-4 py-3 flex items-center justify-between flex-shrink-0"
      style="padding-top: calc(12px + env(safe-area-inset-top, 0px));"
    >
      <div class="flex items-center gap-2 min-w-0">
        <button
          @click="goBack"
          class="p-2 -ml-1 rounded-full flex-shrink-0 m3-icon-btn"
          style="min-width: 44px; min-height: 44px;"
          aria-label="Kembali"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 class="text-base sm:text-lg font-semibold truncate">Panduan ChatBareng</h1>
      </div>
    </header>

    <div class="max-w-3xl w-full mx-auto px-4 py-5 flex-1">
      <p class="text-sm mb-4" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
        Panduan lengkap penggunaan ChatBareng — pilih tab sesuai peranmu.
      </p>

      <!-- ═══ Tab role (chip M3, scrollable di mobile) ═══ -->
      <div class="flex gap-2 overflow-x-auto no-scrollbar pb-1 mb-5" role="tablist" aria-label="Pilih peran">
        <button
          v-for="t in tabs"
          :key="t.id"
          role="tab"
          :aria-selected="activeTab === t.id"
          @click="setTab(t.id)"
          :class="['m3-chip text-sm', activeTab === t.id ? 'm3-chip--selected' : '']"
          class="guide-chip"
        >
          {{ t.label }}
        </button>
      </div>

      <!-- ══════════════════ TAB 💬 CS (default) ══════════════════ -->
      <div v-if="activeTab === 'cs'">
        <!-- Mulai -->
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">🚀 Mulai</h2>
          <p class="text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            Akun CS kamu dikelola admin. Setelah akun aktif, cara masuk dan mengenal halaman utamanya:
          </p>
          <ol class="guide-steps">
            <li>Buka aplikasi ChatBareng di browser, masukkan <strong>Username</strong> &amp; <strong>Password</strong> dari admin, lalu klik <strong>Masuk</strong>.</li>
            <li>Di bawah layar (mobile) ada <strong>Homerow</strong> — 4 tab utama:
              <ul class="guide-sublist">
                <li><strong>Obrolan</strong> 💬 — daftar chat &amp; antrean, tempat kerja utamamu.</li>
                <li><strong>Kontak</strong> 👥 — daftar semua pelanggan, edit nama, buka chat.</li>
                <li><strong>Blast</strong> 📣 — kirim pesan massal ke banyak pelanggan sekaligus.</li>
                <li><strong>Pengaturan</strong> ⚙️ — profil, notifikasi, tema, panduan (halaman ini), logout.</li>
              </ul>
            </li>
            <li>Di halaman Obrolan, filter atas: <strong>Mine</strong> (chat milikmu) dan <strong>Resolved</strong> (riwayat chat yang sudah kamu selesaikan). Kalau ada chat snoozed, muncul chip <strong>😴 Snoozed</strong> juga.</li>
          </ol>
          <div class="guide-tip">
            💡 <strong>Tip:</strong> Aktifkan notifikasi lewat Pengaturan → Notifikasi supaya chat baru masuk antrean tetap terlihat walau app di background.
          </div>
        </section>

        <!-- Alur harian -->
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">🔁 Alur Harian Chat</h2>
          <p class="text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            Siklus normal satu chat pelanggan dari awal sampai selesai:
          </p>
          <ol class="guide-steps">
            <li><strong>Pesan masuk</strong> dari pelanggan ke nomor WhatsApp bersama.</li>
            <li>Chat masuk <strong>antrean</strong> (belum dipegang siapa pun) — muncul banner hijau di atas/atas list: <em>"📨 N chat baru di antrean"</em>.</li>
            <li>Klik <strong>Take</strong> (Take Next, FIFO — chat paling depan yang keambil duluan). Chat pindah ke <strong>Mine</strong>.</li>
            <li><strong>Balas</strong> pelanggan: teks biasa, kirim media (ikon 📎), template cepat (ketik <code class="guide-kbd">/</code>), atau file dari Tangan Kanan (folder 📂 di composer).</li>
            <li>Pesan penting bisa di-<strong>star/favorite</strong> — hover/tekan pesan lalu klik bintang ☆. Lihat kumpulannya lewat ikon ☆ di header chat.</li>
            <li>Setelah urusan selesai, buka menu <strong>⋮ kebab</strong> → <strong>Resolve Chat</strong>.</li>
            <li>Chat keluar dari Mine, dan kalau <strong>CSAT Survey</strong> aktif, pelanggan otomatis menerima survey rating 1–5. Hasilnya masuk ke Analytics.</li>
          </ol>
          <div class="guide-tip">
            💡 <strong>Tip:</strong> First response kamu dihitung sejak chat di-Take — jadi take dulu dulu walau belum sempat balas panjang.
          </div>
        </section>

        <!-- Chat masuk pertama kali -->
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">📥 Skenario: Chat Masuk Pertama Kali</h2>
          <ol class="guide-steps">
            <li>Badge antrean di bawah ikon Obrolan naik + banner antrean muncul ("N chat baru di antrean"). <strong>Tidak ada popup isi chat</strong> — konten pesan hanya terlihat setelah chat kamu take (privasi antar CS, sejak v0.13.4).</li>
            <li>Buka halaman <strong>Obrolan</strong> → klik <strong>Take</strong> di banner. Chat terdepan antrean jadi milikmu (FIFO).</li>
            <li>Buka chatnya, baca pesan &amp; catatan internal tim (jika ada) di panel 📝 Notes.</li>
            <li>Balas seperti biasa — sapa, jawab, atau pakai template <code class="guide-kbd">/</code>. Dari titik ini toast + notifikasi push <strong>dengan isi pesan</strong> hanya muncul di perangkatmu (pemilik chat).</li>
            <li>Selesai? <strong>⋮ → Resolve Chat</strong> supaya chat tidak menumpuk di Mine.</li>
          </ol>
          <div class="guide-tip">
            💡 <strong>Tip:</strong> Chat yang belum di-take tetap di antrean dan bisa diambil CS lain — jangan tunda terlalu lama. Notifikasi sistem (app tertutup) untuk antrean sengaja tidak menampilkan nama/isi pesan — cukup sebagai sinyal kerja.
          </div>
        </section>

        <!-- CSAT badge -->
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">⭐ Badge Rating CSAT di Header Chat</h2>
          <p class="text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            Setelah chat di-<strong>Resolve</strong>, pelanggan menerima survey bintang 1–5 (diatur admin). Balasannya dengan ⭐ dicatat otomatis — dan muncul sebagai badge di header chat.
          </p>
          <ol class="guide-steps">
            <li>Badge <strong>⭐ N</strong> = rating dari <strong>survey TERAKHIR pada chat ini</strong> — bukan "rating pelanggan" secara umum. Ini riwayat sesi chat, bukan reputasi kontak.</li>
            <li>Semua agent yang buka chat yang sama melihat angka yang sama — bacanya: <em>"sesi sebelumnya berakhir dengan nilai ini"</em>. Sinyal bagus buat semangat: orang ini pernah puas, jaga terus 😄</li>
            <li>Chat <strong>baru</strong> dari pelanggan yang sama = survey baru = badge di chat baru itu. Badge di chat lama <strong>tidak berubah</strong> (jadi riwayat per chat — tidak ada rata-rata/gabungan antar chat).</li>
            <li>Chat sama di-reopen → resolve lagi → survey baru → badge chat itu <strong>berganti ke rating terbaru</strong> (dengan aturan anti-spam cooldown — lihat tab Admin).</li>
            <li>Tidak ada reset otomatis berkala — badge hanya berganti dengan survey lebih baru di chat yang sama, atau hilang jika chat di-purge.</li>
          </ol>
          <div class="guide-tip">
            💡 <strong>Tip:</strong> Auto reply (menu/away/greeting) <strong>tidak mempengaruhi</strong> angka CSAT &amp; first-response — semuanya dihitung mulai dari balasan agent asli pertama. Rating murni kerja manusia.
          </div>
        </section>

        <!-- Transfer / Release -->
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">🔀 Skenario: Pindahkan Chat</h2>
          <p class="text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            Dua cara memindahkan chat, artinya berbeda:
          </p>
          <ol class="guide-steps">
            <li><strong>Transfer</strong> — serahkan chat langsung ke agent tertentu. Buka ⋮ kebab → <strong>Transfer ke agent</strong> → pilih nama. Untuk CS, daftar yang muncul hanya agent yang <strong>online</strong> (titik hijau). Admin bisa transfer ke siapa pun termasuk yang offline.</li>
            <li><strong>Release ke Antrean</strong> — melepas chat kembali ke antrean umum tanpa menentukan penerima. Chat bisa diambil CS siapa pun lewat Take Next. Buka ⋮ kebab → <strong>Release ke Antrean</strong>.</li>
          </ol>
          <p class="text-sm" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            <strong>Bedanya:</strong> Transfer = langsung ke orang yang kamu pilih (cepat, pasti); Release = ke antrean umum (cocok kalau gak yakin siapa yang tepat atau semua lagi sibuk). Setelah transfer/release, chat keluar dari Mine-mu.
          </p>
        </section>

        <!-- Snooze -->
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">😴 Skenario: Chat Gak Bisa Dibalas Sekarang</h2>
          <ol class="guide-steps">
            <li>Buka ⋮ kebab → <strong>😴 Snooze</strong>.</li>
            <li>Pilih durasi: preset <strong>15 menit · 1 jam · 3 jam · Besok 08:00</strong>, atau <strong>Custom</strong> (tanggal &amp; waktu bebas).</li>
            <li>Selama snoozed, chat <em>hilang sementara</em> dari semua list utama — tidak menumpuk, tidak mengganggu. Muncul lagi otomatis di chip <strong>😴 Snoozed</strong> dengan label "Kembali …".</li>
            <li>Chat muncul kembali otomatis setelah waktunya lewat — tanpa perlu apa-apa.</li>
          </ol>
          <div class="guide-tip">
            💡 <strong>Tip:</strong> Pelanggan membalas saat chat di-snooze? Snooze otomatis <strong>dibatalkan</strong> — chat langsung balik normal &amp; hitung unread jalan. Jadi snooze itu aman.
          </div>
        </section>

        <!-- Catatan internal -->
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">📝 Catatan Internal</h2>
          <ol class="guide-steps">
            <li>Di header chat, klik ikon catatan (✏️/📄) untuk membuka panel <strong>Notes</strong> (di mobile lewat ikon di samping kebab ⋮).</li>
            <li>Tulis catatan lalu kirim — contoh: "pelanggan mau follow-up Senin", "sudah diinfo biaya ongkir".</li>
            <li>Catatan <strong>dibagi (shared) ke seluruh tim</strong> — CS/Admin lain yang buka chat yang sama bisa membacanya.</li>
          </ol>
          <div class="guide-tip" style="background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);">
            ⚠️ <strong>Penting:</strong> Catatan internal <strong>TIDAK pernah terkirim ke pelanggan</strong> — khusus komunikasi tim.
          </div>
        </section>

        <!-- Pesan terjadwal -->
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">⏰ Pesan Terjadwal</h2>
          <ol class="guide-steps">
            <li>Di composer, klik menu <strong>+</strong> (mobile) atau tombol jadwal ⏰ (desktop) → <strong>Jadwalkan pesan</strong>.</li>
            <li>Tulis isi pesan, pilih <strong>waktu kirim</strong> (minimal <strong>+2 menit</strong> dari sekarang, zona WIB), lalu simpan.</li>
            <li>Daftar pesan terjadwal ada di panel yang sama dengan Notes — bisa <strong>dibatalkan (cancel)</strong> kapan pun sebelum waktunya tiba.</li>
          </ol>
        </section>

        <!-- Template pesan -->
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">⚡ Template Pesan</h2>
          <ol class="guide-steps">
            <li>Saat menulis balasan, ketik <code class="guide-kbd">/</code> di composer — daftar template muncul (flyout).</li>
            <li>Lanjutkan mengetik kata kuncinya, mis. <code class="guide-kbd">/harga</code> — hasil dipersempit otomatis. Panah ↑↓ pilih, <strong>Enter</strong> insert, <strong>Esc</strong> tutup.</li>
            <li>Template berisi teks siap pakai yang dikelola admin — bisa berisi <code class="guide-kbd">{name}</code> yang otomatis diganti nama pelanggan saat terkirim (personalisasi).</li>
            <li>Alternatif: klik ikon template di composer (desktop) atau lewat menu <strong>+</strong> (mobile) untuk membuka daftar lengkap per kategori.</li>
          </ol>
          <div class="guide-tip">
            💡 <strong>Tip:</strong> Kalau butuh template baru, minta admin menambahkannya lewat Admin → Templates.
          </div>
        </section>

        <!-- Tangan Kanan -->
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">📂 Tangan Kanan</h2>
          <p class="text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            File &amp; folder <strong>bersama seluruh tim</strong> (folder sistem: Image, Document, Link + folder buatan sendiri):
          </p>
          <ol class="guide-steps">
            <li>Buka lewat folder 📂 di composer (desktop) atau menu <strong>+</strong> → <strong>Tangan Kanan</strong> (mobile).</li>
            <li><strong>Upload</strong>: pilih folder → tombol upload (folder <strong>Link</strong> khusus menyimpan link/tautan).</li>
            <li><strong>Insert ke chat</strong>: klik file → konfirmasi insert (gambar bisa diberi caption) → file terkirim sebagai pesan ke pelanggan.</li>
            <li><strong>Download</strong>: setiap file bisa diunduh ulang kapan pun.</li>
          </ol>
        </section>

        <!-- Search -->
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">🔍 Search</h2>
          <ol class="guide-steps">
            <li><strong>Search global</strong> — kotak pencarian di atas daftar chat (Obrolan). Ketik kata kunci: hasil menyertakan pesan dari semua chat, langsung lompat ke pesannya.</li>
            <li><strong>Search dalam chat</strong> — buka chat → ikon 🔍 di header (atau <code class="guide-kbd">Ctrl+F</code> / <code class="guide-kbd">Cmd+F</code>) → hasil dihitung &amp; pesan tersorot; <strong>Esc</strong> atau ✕ untuk menutup.</li>
          </ol>
        </section>

        <!-- Kontak -->
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">👥 Kontak</h2>
          <ol class="guide-steps">
            <li>Buka tab <strong>Kontak</strong> di homerow — daftar semua pelanggan (nama, nomor, kota, catatan, sumber, status chat).</li>
            <li><strong>Edit</strong> — klik tombol Edit untuk mengubah nama &amp; info kontak.</li>
            <li><strong>Chat / klaim</strong> — tombol <strong>Chat</strong> membuka chat kontak; kalau chatnya masih menganggur (unassigned), chat otomatis <strong>terklaim ke kamu</strong> (berlaku untuk CS &amp; Admin — v0.15.2).</li>
            <li>Gunakan search di atas daftar untuk mencari cepat.</li>
            <li><strong>Filter by tag</strong> (v0.13.4) — klik chip tag di atas daftar (nama + jumlah kontak) untuk melihat hanya kontak dengan tag itu. Klik "Semua" untuk membersihkan filter.</li>
            <li><strong>Kelola Tag</strong> (admin, panel di atas daftar) — buat tag baru (nama + warna), <strong>Export CSV</strong> kontak by tag, atau <strong>Hapus</strong> tag (kontak otomatis lepas dari tag, tanpa data sisa).</li>
          </ol>
          <div class="guide-tip">
            💡 <strong>Tip:</strong> Tag yang menempel dari Menu Gateway (mis. "Komplain") otomatis muncul di sini — pakai chip filter untuk melihat semua pelanggan yang pernah komplain dalam satu klik, atau export CSV-nya untuk laporan.
          </div>
        </section>

        <!-- Grup (v0.14.x — fitur baru) -->
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">👥 Grup</h2>
          <p class="text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            Chat grup WhatsApp dengan model <strong>PIC</strong> (penanggung jawab): setiap grup langsung punya PIC sejak dibuat dan <strong>tidak lewat antrean Take</strong> — jadi arus kerja chat 1:1 kamu tidak berubah.
          </p>
          <ol class="guide-steps">
            <li><strong>Buka halaman Grup</strong> — desktop: link <strong>Grup</strong> di topbar (sebelah Kontak); mobile: halaman <strong>Kontak</strong> → segmen <strong>Grup</strong> di atas daftar.</li>
            <li><strong>Buat grup</strong> dengan tombol <strong>+ Buat Grup</strong>: nama (wajib), deskripsi (opsional), dan anggota awal. CS yang membuat <strong>otomatis jadi PIC</strong> grup tersebut.</li>
            <li><strong>Balas chat grup</strong> seperti chat biasa — teks, media 📎, template <code class="guide-kbd">/</code>, file Tangan Kanan 📂. Header chat menampilkan badge <strong>👥 + jumlah member</strong>, dan tiap bubble menampilkan nama pengirimnya.</li>
            <li>Klik <strong>nama pengirim</strong> pada bubble → popover: <strong>Simpan Kontak</strong> (simpan nomor asli bila tersedia) atau <strong>Chat 1:1</strong> langsung dari dalam grup.</li>
            <li><strong>Kelola member &amp; pengaturan</strong> lewat panel Kelola Grup di detail: tambah/keluarkan member, jadikan/turunkan admin grup, ganti nama &amp; deskripsi, dan toggle:
              <ul class="guide-sublist">
                <li><strong>Mode pengumuman</strong> — hanya admin grup yang bisa kirim pesan.</li>
                <li><strong>Info grup terkunci</strong> — hanya admin grup yang bisa mengubah nama/deskripsi.</li>
                <li><strong>Approval member baru</strong> — masuk via link undangan perlu persetujuan.</li>
                <li><strong>Bisa tambah member</strong> — semua member atau hanya admin grup.</li>
              </ul>
            </li>
            <li><strong>Reset link undangan</strong> bila perlu — link lama langsung mati dan diganti baru (ada konfirmasi dulu). Kontak tanpa nomor asli (LID) diundang lewat <strong>link undangan</strong> yang dikirim ke chat 1:1 mereka — mereka bergabung sendiri.</li>
          </ol>
          <div class="guide-tip">
            ⚠️ <strong>Penting:</strong> nomor bot harus menjadi <strong>admin di grup WA</strong> supaya aksi kelola berjalan — kalau muncul petunjuk "Bot bukan admin di grup ini", tambahkan nomor bot sebagai admin grup dari WhatsApp. Chat grup <strong>tidak bisa di-Release</strong>; penggantian PIC dilakukan admin lewat <strong>Assign PIC</strong>.
          </div>
        </section>

        <!-- Blast -->
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">📣 Blast</h2>
          <p class="text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            Dua tab: <strong>Kirim</strong> &amp; <strong>Riwayat</strong>.
          </p>
          <ol class="guide-steps">
            <li>Tab <strong>Kirim</strong>: pilih penerima (Kontak atau upload <strong>CSV</strong> — kolom nomor wajib; format CSV contoh tersedia di halaman).</li>
            <li>Tulis pesan; sisipkan <strong>{name}</strong> via tombol <em>Insert Name</em> agar tiap penerima menerima sapaan namanya sendiri.</li>
            <li>Atur <strong>Rate Limiting</strong> (jeda antar pesan/grup) supaya kirim aman &amp; tidak dianggap spam oleh WhatsApp.</li>
            <li>Review → mulai. Progres kirim bisa dipantau; hasilnya masuk tab <strong>Riwayat</strong>.</li>
          </ol>
          <div class="guide-tip">
            💡 <strong>Tip:</strong> Blast tidak mengganggu antrean chat harian — masing-masing jalur terpisah.
          </div>
        </section>

        <!-- Pengaturan -->
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">⚙️ Pengaturan</h2>
          <ol class="guide-steps">
            <li><strong>Profile</strong> — nama akun &amp; role kamu.</li>
            <li><strong>Notifikasi</strong> — aktifkan push supaya dapat kabar chat baru.</li>
            <li><strong>Tema</strong> — Light / Dark / Sistem (ikut pengaturan perangkat).</li>
            <li><strong>Aplikasi (PWA)</strong> — install ChatBareng ke home screen HP.</li>
            <li><strong>Logout</strong> — keluar akun (tombol merah di bawah).</li>
          </ol>
        </section>
      </div>

      <!-- ══════════════════ TAB 🛡️ ADMIN ══════════════════ -->
      <div v-else-if="activeTab === 'admin'">
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">🛡️ Peran Admin</h2>
          <p class="text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            Admin bisa <strong>semua yang CS bisa</strong> (chat, template, Tangan Kanan, dst.) <strong>plus</strong> panel pengelolaan. Akun admin juga bisa <strong>ambil chat manual</strong> dari tab Unassigned/All — bukan cuma lewat Take Next FIFO. Termasuk tombol <strong>Chat</strong> di halaman <strong>Kontak</strong>: chat unassigned langsung <strong>terklaim ke admin</strong> (v0.15.2), sama seperti CS.
          </p>
        </section>

        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">👥 Grup &amp; PIC</h2>
          <ol class="guide-steps">
            <li>Admin melihat <strong>semua grup</strong> (termasuk yang di-PIC orang lain) plus <strong>grup yatim</strong> — grup di WhatsApp yang belum punya PIC di sistem (badge "belum ada PIC").</li>
            <li><strong>Assign PIC</strong> — tetapkan PIC ke user aktif mana pun, termasuk akun Cabang. CS yang membuat grup otomatis jadi PIC; admin bisa memindahkannya kapan pun lewat panel Kelola Grup.</li>
            <li>Semua aksi kelola grup (buat, tambah/keluarkan member, ubah pengaturan, assign PIC, reset undangan) <strong>tercatat di log aksi grup</strong> — siapa melakukan apa.</li>
            <li>Pastikan <strong>nomor bot admin di grup WA</strong> — panel menampilkan status ini dan menonaktifkan aksi yang butuh hak admin bila bot belum admin.</li>
          </ol>
          <div class="guide-tip">
            ℹ️ <strong>Catatan:</strong> Grup born-assigned ke PIC dan tidak pernah masuk antrean Take — chat grup punya alurnya sendiri, terpisah dari antrean 1:1.
          </div>
        </section>

        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">🧭 Admin Panel — 13 Modul</h2>
          <p class="text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            Masuk lewat homerow <strong>Admin</strong> → launcher kartu:
          </p>
          <ol class="guide-steps">
            <li><strong>Users</strong> 👥 — buat akun (username, password, role CS/Admin/Cabang), nonaktifkan, hapus, dan reset password user dari daftar.</li>
            <li><strong>WhatsApp</strong> 📱 — status koneksi &amp; nomor terhubung; scan QR baru via WhatsApp → <em>Linked Devices</em> kalau sesi lepas.</li>
            <li><strong>Templates</strong> 📝 — kelola template pesan: nama, kata kunci <code class="guide-kbd">/keyword</code>, kategori, isi (dukung <code class="guide-kbd">{name}</code>). Ada tombol <strong>⬇️ Export</strong> (download semua template jadi 1 file JSON) dan <strong>⬆️ Import</strong> (upload file JSON untuk memindahkan library template antar-deployment — aman: keyword yang sudah ada dilewati, nama tabrakan otomatis di-rename "(import)").</li>
            <li><strong>Analytics</strong> 📊 — KPI chat (masuk, selesai, backlog), response time (avg first response, avg resolve), performa per CS, dan section ⭐ CSAT (avg rating per CS).</li>
            <li><strong>Pengumuman</strong> 📢 — broadcast ke semua user (CS/Admin/Cabang) + statistik siapa yang sudah membaca (read stats per pengumuman).</li>
            <li><strong>Purge</strong> 🧹 — bersih-bersih riwayat chat lama (Soft = ditandai; Hard = dihapus permanen + file media), lengkap dengan log siapa membersihkan apa.</li>
            <li><strong>Backup &amp; Restore</strong> 💾 — export/import history chat (detail di bawah).</li>
            <li><strong>Auto Reply</strong> 🤖 — balasan otomatis di luar jam operasional + greeting harian.</li>
            <li><strong>Menu Gateway</strong> 🧭 — menu triage otomatis sebelum chat masuk antrean.</li>
            <li><strong>CSAT Survey</strong> ⭐ — survey kepuasan rating 1–5 otomatis pasca-resolve.</li>
            <li><strong>Backup Drive</strong> ☁️ — backup otomatis chat ke Google Drive pribadi (lihat di bawah).</li>
            <li><strong>Tampilan</strong> 🎨 — warna aksen aplikasi (accent).</li>
            <li><strong>Panduan</strong> 📖 — halaman yang sedang kamu baca ini, untuk semua peran.</li>
          </ol>
        </section>

        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">🤖 Auto Reply</h2>
          <ol class="guide-steps">
            <li><strong>Outside Hours Reply</strong> — balasan otomatis untuk pelanggan yang chat di luar jam operasional (ON/OFF + teks bebas).</li>
            <li><strong>First-of-Day Greeting</strong> — sapaan otomatis untuk pelanggan yang chat pertama kali di hari itu (ON/OFF + teks; maksimal 1×/hari per pelanggan, tidak dihitung first-response CS).</li>
            <li><strong>Jam operasional</strong> diatur per hari: Senin–Jumat, Sabtu, Minggu — masing-masing punya jam mulai/selesai; hari yang OFF dianggap di luar jam kerja.</li>
          </ol>
        </section>

        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">🧭 Menu Gateway</h2>
          <p class="text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            Pelanggan baru menerima <strong>menu bernomor</strong> ("1. Komplain, 2. Ambil hasil, …") sebelum chat masuk antrean. Jawabannya menentukan balasan + tag, lalu chat masuk antrean seperti biasa. CS tidak melihat chat yang belum memilih.
          </p>
          <ol class="guide-steps">
            <li><strong>Nyalakan</strong> lewat Admin → Menu Gateway (toggle <strong>Aktif</strong>), lalu set <strong>First-of-Day Greeting</strong> di Auto Reply ke mode <strong>Menu gateway</strong> — tanpa itu menu tidak pernah terkirim.</li>
            <li><strong>Intro</strong> — teks pembuka dengan <code class="guide-kbd">{name}</code>; nomor menu mengikuti urutan opsi.</li>
            <li><strong>Opsi (2–8)</strong> — label, alias kata kunci, balasan konfirmasi per opsi, dan tag kontak yang menempel saat opsi dipilih. ↑↓ untuk mengubah urutan/nomor.</li>
            <li><strong>Timeout</strong> — jika pelanggan tidak menjawab dalam waktu yang diatur, chat langsung masuk antrean tanpa tag menu.</li>
            <li><strong>Fallback</strong> — jawaban di luar menu dapat teks fallback + tag "Lainnya" (bila dipilih), tanpa menu kedua.</li>
            <li><strong>Frekuensi</strong> — tiap chat baru / sekali per hari / sekali per minggu per kontak. Chip "⏳ Menunggu menu" di dashboard admin menampilkan chat yang belum memilih (klik untuk lihat daftarnya).</li>
          </ol>
          <div class="guide-tip">
            ℹ️ <strong>Catatan:</strong> Fitur default <strong>OFF</strong> — aman diaktifkan/dimatikan kapan pun. Chat yang sedang menunggu menu saat fitur dimatikan langsung masuk antrean.
          </div>
        </section>

        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">⭐ CSAT Survey + Anti-Spam</h2>
          <ol class="guide-steps">
            <li>Toggle <strong>ON/OFF</strong> survey kepuasan (rating 1–5 otomatis keluar ke pelanggan saat chat di-resolve).</li>
            <li>Edit <strong>teks survey</strong> yang diterima pelanggan.</li>
            <li><strong>Anti-spam (cooldown)</strong>: pilih mode — <em>Per chat</em> (1 survey per N jam per chat), <em>Per agent</em> (agent beda boleh kirim survey baru), atau <em>Hybrid</em> — plus atur <strong>jumlah jam cooldown</strong>-nya (0 = mati).</li>
          </ol>
        </section>

        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">☁️ Backup Google Drive</h2>
          <ol class="guide-steps">
            <li><strong>Hubungkan akun Google</strong> — tombol "Hubungkan Google Drive" membuka consent Google; backup CSV otomatis masuk folder "ChatBareng Backups" di Drive pribadimu.</li>
            <li>Atur <strong>jadwal</strong> backup otomatis dan <strong>retensi</strong> (jumlah file yang disimpan; file di luar N terakhir dihapus dari Drive).</li>
            <li>Status koneksi, email akun, dan hasil backup terakhir tampil di halaman.</li>
          </ol>
          <div class="guide-tip">
            ℹ️ <strong>Catatan:</strong> OAuth Google Drive menunggu verifikasi domain Google di sisi server — kalau tombol hubungkan belum jalan, ini status yang dimaksud, bukan error aplikasimu.
          </div>
        </section>

        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">💾 Export/Import History</h2>
          <ol class="guide-steps">
            <li><strong>Backup (Export)</strong> — pilih rentang (semua atau custom tanggal) → download file backup chat.</li>
            <li><strong>Restore (Import)</strong> — upload file backup, review preview-nya, lalu konfirmasi. Riwayat lama kembali ke app.</li>
            <li><strong>Import dari Cekat.AI</strong> (v0.15.0) — upload CSV export conversations Cekat.AI → auto-convert + import. Hanya channel WhatsApp yang diimport (TikTok/IG di-skip); chat masuk sebagai arsip resolved dengan tag "Import CekatAI". Gunakan <strong>Preview (Dry Run)</strong> untuk cek angka dulu — upload ulang file yang sama aman (anti-dobel).</li>
          </ol>
        </section>

        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">🧹 Purge</h2>
          <ol class="guide-steps">
            <li>Pilih <strong>mode</strong>: Soft (ditandai, masih di DB) atau Hard (hapus permanen dari DB + file media).</li>
            <li>Isi alasan (opsional, masuk log) → jalankan. Semua aksi purge <strong>tercatat di Purge Log</strong> (siapa, kapan, berapa).</li>
            <li><strong>Reset marker auto-reply</strong> (v0.13.4) — purge sekalian menormalkan status auto reply chat terdampak (cap harian, state menu, marker frekuensi) → chat yang di-purge bisa disambut auto reply lagi seperti pelanggan baru.</li>
          </ol>
        </section>

        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">📢 Pengumuman</h2>
          <ol class="guide-steps">
            <li>Buat pengumuman (judul + isi) → terkirim sebagai <strong>broadcast ke semua user</strong> aktif, plus notifikasi push.</li>
            <li>Pantau <strong>read stats</strong>: berapa dari berapa user yang sudah membaca tiap pengumuman.</li>
            <li>Bisa <strong>pin</strong> 📌 pengumuman penting atau hapus yang sudah tidak relevan.</li>
          </ol>
        </section>

        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">📊 Tips Analytics</h2>
          <div class="guide-tip">
            💡 Gunakan <strong>Analytics</strong> untuk monitoring rutin: <em>Avg First Response</em> &amp; <em>Avg Resolve</em> untuk menilai kecepatan respon CS, tabel <em>performa per agent</em> untuk evaluasi beban kerja, dan section <strong>⭐ CSAT</strong> (avg rating per CS) untuk kepuasan pelanggan. Bandingkan antar periode biar tren terlihat.
          </div>
        </section>
      </div>

      <!-- ══════════════════ TAB 🏪 CABANG ══════════════════ -->
      <div v-else>
        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">🏪 Apa itu Akun Cabang?</h2>
          <p class="text-sm mb-3" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
            Akun Cabang (relay) adalah peran untuk outlet/cabang — misalnya klinik cabang yang perlu menangani percakapan tertentu. Perannya spesial:
          </p>
          <ol class="guide-steps">
            <li>Cabang <strong>TIDAK bisa take dari antrean</strong> — banner antrean tidak muncul dan tombol take tidak tersedia. Chat yang dipegang cabang 100% hasil <strong>transfer dari CS/Admin</strong>.</li>
            <li>Chat yang ditransfer masuk ke tab <strong>Mine</strong> (plus chip Resolved untuk riwayat miliknya).</li>
            <li>Karena itu, <strong>pastikan status online</strong> saat jam kerja — chat hanya bisa ditransfer ke cabang yang online.</li>
          </ol>
        </section>

        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">💬 Menerima &amp; Membalas Chat</h2>
          <ol class="guide-steps">
            <li>CS/Admin mentransfer chat ke cabang-mu → chat muncul di <strong>Mine</strong> dengan penanda transfer.</li>
            <li>Buka chat → <strong>balas seperti CS</strong>: teks, media 📎, template <code class="guide-kbd">/</code>, dan lihat catatan internal tim di 📝 Notes.</li>
            <li>Selesai? <strong>Resolve Chat</strong> lewat ⋮ kebab seperti biasa — chat resolved milikmu tercatat di tab Resolved.</li>
          </ol>
        </section>

        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">👥 Grup (sebagai PIC)</h2>
          <ol class="guide-steps">
            <li>Admin bisa menetapkan akun Cabang sebagai <strong>PIC grup</strong> — grup itu lalu muncul di halaman <strong>Grup</strong> milikmu.</li>
            <li>Balas chat grup seperti chat biasa: teks, media 📎, template <code class="guide-kbd">/</code>, file Tangan Kanan 📂.</li>
            <li>Akun Cabang <strong>tidak bisa membuat grup sendiri</strong> — minta admin bila butuh grup baru.</li>
          </ol>
        </section>

        <section class="m3-card p-5 sm:p-6 mb-4">
          <h2 class="text-lg font-semibold mb-2">🔀 Transfer-Back</h2>
          <ol class="guide-steps">
            <li>Kalau chat ternyata harus ditangani pusat, buka ⋮ kebab → <strong>Transfer ke agent</strong>.</li>
            <li>Cabang hanya bisa <strong>transfer-back ke CS/Admin</strong> — <em>bukan</em> ke cabang lain.</li>
            <li>Target transfer harus <strong>online</strong> — kalau tidak ada yang online, tunggu atau hubungi admin.</li>
          </ol>
          <div class="guide-tip">
            💡 <strong>Tip:</strong> Chat cabang terisolasi — kamu hanya melihat chat yang ditransfer kemu, bukan seluruh antrean pusat.
          </div>
        </section>
      </div>

      <!-- Footer -->
      <p class="text-center text-xs pb-6" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
        📖 Panduan ChatBareng v0.14.8 · konten statis, diperbarui bersama rilis fitur
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

// 3 tab role — default 💬 CS (spec §1)
const activeTab = ref('cs')
const tabs = [
  { id: 'admin', label: '🛡️ Admin' },
  { id: 'cs', label: '💬 CS' },
  { id: 'cabang', label: '🏪 Cabang' },
]
function setTab(id) { activeTab.value = id }

// v0.12.0 — back ke halaman asal (login/settings/admin), fallback ke '/' kalau
// langsung dibuka tanpa history (fresh tab) ATAU history-nya halaman ini sendiri
// (biar gak loop back ke /guidebook).
function goBack() {
  const prev = router.options?.history?.state?.back
  if (prev && prev !== '/guidebook') {
    router.back()
  } else {
    router.replace('/')
  }
}
</script>

<style scoped>
/* Chip role: touch target ≥44px (spec §1) — padding chip standar M3 kurang */
.guide-chip {
  min-height: 44px;
  padding: 8px 20px;
  flex-shrink: 0;
}

/* Step list bernomor — angka primary, spacing lega */
.guide-steps {
  counter-reset: step;
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 0.875rem;
  line-height: 1.6;
  color: var(--md-sys-color-on-surface);
}
.guide-steps > li {
  counter-increment: step;
  position: relative;
  padding-left: 34px;
}
.guide-steps > li::before {
  content: counter(step);
  position: absolute;
  left: 0;
  top: 1px;
  width: 24px;
  height: 24px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  font-size: 0.75rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.guide-sublist {
  margin: 6px 0 0 0;
  padding-left: 18px;
  list-style: disc;
  color: var(--md-sys-color-on-surface-variant);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* Tips callout — surface-variant M3 (spec §1) */
.guide-tip {
  margin-top: 12px;
  background: var(--md-sys-color-surface-variant);
  color: var(--md-sys-color-on-surface-variant);
  border-radius: var(--md-sys-shape-corner-s);
  padding: 10px 14px;
  font-size: 0.8125rem;
  line-height: 1.55;
}

/* Inline code ala kbd */
.guide-kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8125em;
  background: var(--md-sys-color-surface-container-high);
  color: var(--md-sys-color-on-surface);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: 6px;
  padding: 1px 5px;
}
</style>
