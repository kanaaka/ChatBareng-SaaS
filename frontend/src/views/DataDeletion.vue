<template>
  <!--
    v4.6.19 — Penghapusan Data (halaman PUBLIK, tanpa meta.auth).
    Syarat Meta App Review: "Data Deletion Request URL".
    KONTEN STATIS (nihil DB) — belum ada auto-deletion engine, jadi alurnya
    manual lewat email dengan SLA tertulis. Endpoint callback signed_request
    (opsional, Meta hanya memanggilnya bila app memakai Facebook Login) sengaja
    TIDAK dibangun di rilis ini: halaman instruksi sudah memenuhi syarat Meta.
  -->
  <div class="min-h-screen flex flex-col" :style="{ background: 'var(--md-sys-color-surface-container-low)' }">
    <header
      class="sticky top-0 z-30 m3-topbar px-3 sm:px-4 py-3 flex items-center justify-between flex-shrink-0"
      style="padding-top: calc(12px + env(safe-area-inset-top, 0px));"
    >
      <div class="flex items-center gap-2 min-w-0">
        <h1 class="text-base sm:text-lg font-semibold truncate">{{ t.title }}</h1>
      </div>
      <button
        @click="toggleLang"
        class="m3-chip text-sm flex-shrink-0"
        style="min-height: 44px;"
        :aria-label="lang === 'id' ? 'Switch to English' : 'Ganti ke Bahasa Indonesia'"
      >
        {{ lang === 'id' ? 'EN' : 'ID' }}
      </button>
    </header>

    <div class="max-w-3xl w-full mx-auto px-4 py-5 flex-1">
      <p class="text-sm mb-4" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
        {{ t.updated }}
      </p>

      <!-- Kotak aksi utama: email tujuan -->
      <section
        class="m3-card p-5 sm:p-6 mb-4"
        :style="{ background: 'var(--md-sys-color-primary-container)' }"
      >
        <h2 class="text-lg font-semibold mb-2">{{ t.ctaHeading }}</h2>
        <p class="text-sm mb-3">{{ t.ctaBody }}</p>
        <a
          :href="'mailto:' + EMAIL + '?subject=' + encodeURIComponent(t.mailSubject)"
          class="legal-cta inline-block px-4 py-3 rounded-lg text-sm font-semibold"
          :style="{ background: 'var(--md-sys-color-primary)', color: 'var(--md-sys-color-on-primary)', minHeight: '44px' }"
        >
          ✉️ {{ EMAIL }}
        </a>
      </section>

      <section v-for="s in t.sections" :key="s.heading" class="m3-card p-5 sm:p-6 mb-4">
        <h2 class="text-lg font-semibold mb-2">{{ s.heading }}</h2>
        <p v-for="(p, i) in (s.paragraphs || [])" :key="'p'+i" class="text-sm mb-2 leading-relaxed">
          {{ p }}
        </p>
        <ol v-if="s.steps" class="legal-steps text-sm mt-2">
          <li v-for="(st, i) in s.steps" :key="'s'+i">{{ st }}</li>
        </ol>
        <ul v-if="s.bullets" class="legal-list text-sm mt-2">
          <li v-for="(b, i) in s.bullets" :key="'b'+i" v-html="b"></li>
        </ul>
      </section>

      <div class="m3-card p-5 sm:p-6 mb-4">
        <p class="text-sm">
          <router-link to="/privacy" class="legal-link">{{ t.privacyLink }}</router-link>
        </p>
      </div>
    </div>

    <footer class="px-4 py-6 text-center text-xs" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
      PT Cita Mulia · Parahita Diagnostic Center
    </footer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

const lang = ref('en')
const toggleLang = () => { lang.value = lang.value === 'id' ? 'en' : 'id' }
const EMAIL = 'medical@labparahita.com'

const CONTENT = {
  en: {
    title: 'Data Deletion',
    updated: 'Last updated: 27 November 2026',
    ctaHeading: 'Request deletion of your data',
    ctaBody: 'Email us from any address and tell us which phone number or Instagram account you used to contact us. We will find your data and delete it.',
    mailSubject: 'Data deletion request — ChatBareng',
    sections: [
      {
        heading: 'How to request deletion',
        steps: [
          'Send an email to ' + EMAIL + ' with the subject "Data deletion request".',
          'Tell us the phone number (WhatsApp) or Instagram username you used to message us. If you contacted us from more than one, list them all.',
          'We will reply to confirm we received your request, and give you a reference number.',
          'We complete the deletion and confirm by email. In most cases this is within 7 days; the maximum is 30 days.',
        ],
      },
      {
        heading: 'What gets deleted',
        bullets: [
          'Your messages and any attachments (photos, documents) exchanged with us through WhatsApp or Instagram;',
          'Your contact identifiers held in our inbox system (phone number, Instagram username and account identifier);',
          'Conversation metadata: timestamps, assignment records and internal notes linked to your conversation.',
        ],
      },
      {
        heading: 'What we may have to keep',
        paragraphs: [
          'A small amount of data may be retained where the law requires it, or where we need it to defend a legal claim. Examples:',
        ],
        bullets: [
          '<strong>Financial records</strong> — if you paid for a test or service, Indonesian tax and accounting rules require us to keep the transaction record for the statutory period. This covers the invoice, not the content of your messages.',
          '<strong>Medical records</strong> — if you underwent a test with us, your medical record is kept under health-sector regulation and is held separately from this messaging system. Deleting your chat does not delete your medical record, and deleting your medical record is governed by those regulations, not by this page.',
          '<strong>Server logs</strong> — technical logs are rotated out automatically on a short cycle and are not linked back to your conversation.',
        ],
      },
      {
        heading: 'If you messaged us on Instagram',
        paragraphs: [
          'Deleting data through us removes it from our systems. It does not delete the copy that remains in your own Instagram inbox — that copy belongs to you and to Meta, and you control it from within Instagram.',
          'You can also revoke this app\'s access from your Instagram or Facebook settings. If you do, we will no longer be able to receive new messages from you.',
        ],
      },
      {
        heading: 'Questions',
        paragraphs: [
          'If anything is unclear, email ' + EMAIL + '. For how we handle personal data generally, see our privacy policy.',
        ],
      },
    ],
    privacyLink: '← Privacy Policy',
  },
  id: {
    title: 'Penghapusan Data',
    updated: 'Terakhir diperbarui: 27 November 2026',
    ctaHeading: 'Minta penghapusan data Anda',
    ctaBody: 'Kirim email kepada kami dari alamat mana pun dan sebutkan nomor telepon atau akun Instagram yang Anda pakai menghubungi kami. Kami akan mencari data Anda dan menghapusnya.',
    mailSubject: 'Permintaan penghapusan data — ChatBareng',
    sections: [
      {
        heading: 'Cara mengajukan penghapusan',
        steps: [
          'Kirim email ke ' + EMAIL + ' dengan subjek "Permintaan penghapusan data".',
          'Sebutkan nomor telepon (WhatsApp) atau nama pengguna Instagram yang Anda pakai menghubungi kami. Bila lebih dari satu, sebutkan semuanya.',
          'Kami akan membalas untuk mengonfirmasi permintaan Anda diterima, beserta nomor referensi.',
          'Kami menyelesaikan penghapusan dan mengonfirmasi lewat email. Umumnya dalam 7 hari; paling lambat 30 hari.',
        ],
      },
      {
        heading: 'Apa yang dihapus',
        bullets: [
          'Pesan Anda dan lampiran apa pun (foto, dokumen) yang dipertukarkan lewat WhatsApp atau Instagram;',
          'Identitas kontak Anda yang tersimpan di sistem kotak masuk kami (nomor telepon, nama pengguna dan ID akun Instagram);',
          'Metadata percakapan: waktu, catatan penugasan agen, dan catatan internal yang terkait percakapan Anda.',
        ],
      },
      {
        heading: 'Yang mungkin harus kami simpan',
        paragraphs: [
          'Sejumlah kecil data mungkin tetap disimpan bila diwajibkan hukum, atau bila kami memerlukannya untuk membela klaim hukum. Contohnya:',
        ],
        bullets: [
          '<strong>Catatan keuangan</strong> — bila Anda membayar pemeriksaan atau layanan, aturan perpajakan dan akuntansi Indonesia mewajibkan kami menyimpan catatan transaksi selama periode yang ditentukan. Ini mencakup faktur, bukan isi pesan Anda.',
          '<strong>Rekam medis</strong> — bila Anda menjalani pemeriksaan, rekam medis Anda disimpan menurut regulasi bidang kesehatan dan terpisah dari sistem perpesanan ini. Menghapus percakapan tidak menghapus rekam medis Anda, dan penghapusan rekam medis diatur regulasi tersebut, bukan oleh halaman ini.',
          '<strong>Log server</strong> — log teknis dirotasi otomatis dalam siklus singkat dan tidak ditautkan kembali ke percakapan Anda.',
        ],
      },
      {
        heading: 'Bila Anda menghubungi kami lewat Instagram',
        paragraphs: [
          'Penghapusan data melalui kami akan menghapusnya dari sistem kami. Itu tidak menghapus salinan yang ada di kotak masuk Instagram Anda sendiri — salinan itu milik Anda dan Meta, dan Anda yang mengendalikannya di dalam Instagram.',
          'Anda juga dapat mencabut akses aplikasi ini dari pengaturan Instagram atau Facebook Anda. Bila dicabut, kami tidak lagi dapat menerima pesan baru dari Anda.',
        ],
      },
      {
        heading: 'Pertanyaan',
        paragraphs: [
          'Bila ada yang kurang jelas, email ' + EMAIL + '. Untuk cara kami menangani data pribadi secara umum, lihat kebijakan privasi kami.',
        ],
      },
    ],
    privacyLink: '← Kebijakan Privasi',
  },
}

const t = computed(() => CONTENT[lang.value])

onMounted(() => {
  document.title = t.value.title + ' — ChatBareng'
})
</script>

<style scoped>
.legal-list {
  list-style: disc;
  padding-left: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  line-height: 1.6;
}
.legal-steps {
  list-style: decimal;
  padding-left: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  line-height: 1.6;
}
.legal-link {
  color: var(--md-sys-color-primary);
  text-decoration: underline;
}
.legal-cta {
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  word-break: break-all;
}
</style>
