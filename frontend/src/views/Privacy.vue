<template>
  <!--
    v4.6.19 — Kebijakan Privasi (halaman PUBLIK, tanpa meta.auth).
    Syarat Meta App Review untuk Instagram Messaging.
    KONTEN STATIS (nihil DB) — pola sama dengan Guidebook v0.12.0.
    Bilingual ID/EN: reviewer Meta umumnya berbahasa Inggris.
    Batasan yang WAJIB dijaga (Developer Policies Meta, 3 Feb 2026 §5):
      - data Instagram TIDAK dipakai untuk iklan/profiling/retargeting
      - tidak mengirim hasil medis / meneruskan ke dokter lewat IG DM
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

      <section v-for="s in t.sections" :key="s.heading" class="m3-card p-5 sm:p-6 mb-4">
        <h2 class="text-lg font-semibold mb-2">{{ s.heading }}</h2>
        <p v-for="(p, i) in s.paragraphs" :key="'p'+i" class="text-sm mb-2 leading-relaxed">
          {{ p }}
        </p>
        <ul v-if="s.bullets" class="legal-list text-sm mt-2">
          <li v-for="(b, i) in s.bullets" :key="'b'+i" v-html="b"></li>
        </ul>
      </section>

      <div class="m3-card p-5 sm:p-6 mb-4" :style="{ background: 'var(--md-sys-color-surface-container-high)' }">
        <p class="text-sm">
          <strong>{{ t.deletionLead }}</strong>
          <router-link to="/data-deletion" class="legal-link">{{ t.deletionLink }}</router-link>
        </p>
      </div>
    </div>

    <footer class="px-4 py-6 text-center text-xs" :style="{ color: 'var(--md-sys-color-on-surface-variant)' }">
      {{ t.footer }}
    </footer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

const lang = ref('en') // default Inggris: halaman ini untuk reviewer Meta
const toggleLang = () => { lang.value = lang.value === 'id' ? 'en' : 'id' }

const CONTACT = 'medical@labparahita.com'

const CONTENT = {
  en: {
    title: 'Privacy Policy',
    updated: 'Last updated: 27 November 2026',
    sections: [
      {
        heading: 'Who we are',
        paragraphs: [
          'This service ("ChatBareng") is operated by PT Cita Mulia, a healthcare provider in Indonesia operating under the brand Parahita Diagnostic Center. In this policy, "we", "us" and "our" refer to PT Cita Mulia.',
          'We act as the data controller for the personal data described below. Contact for privacy matters: ' + CONTACT + '.',
        ],
      },
      {
        heading: 'What this service does',
        paragraphs: [
          'ChatBareng is a customer-service inbox that lets our staff receive and answer messages from the public on WhatsApp and Instagram. It is an internal tool used by our own agents. We do not sell this service to third parties through this website.',
        ],
      },
      {
        heading: 'What data we collect',
        paragraphs: ['We collect only what is needed to answer your question:'],
        bullets: [
          '<strong>Contact identifiers</strong> — your phone number (WhatsApp) or Instagram username and account identifier.',
          '<strong>Message content</strong> — the text of the messages you send us, and any photos, documents or other attachments you choose to share.',
          '<strong>Message metadata</strong> — timestamps, delivery and read status, and which of our agents handled the conversation.',
          '<strong>Basic technical data</strong> — IP address and browser information recorded in our server logs when you use the app.',
        ],
      },
      {
        heading: 'Data we receive from Instagram (Meta)',
        paragraphs: [
          'When you message our Instagram account (@labparahita), Meta Platforms sends us your Instagram username, your account identifier (IGSID), the content of your messages and any media you attach. We receive this through the Instagram Messaging API.',
          'We use this data for one purpose only: to read your message and reply to it. We store it in our own database so our agents can see the conversation history.',
          'In line with Meta Developer Policies, we do <strong>not</strong> use Instagram messaging data for advertising, profiling, retargeting or resale, and we do not build user profiles from it. We do not share it with advertising networks or data brokers.',
        ],
      },
      {
        heading: 'What we do NOT do over Instagram',
        paragraphs: [
          'Instagram direct messages in our service are handled by customer-service staff for administrative questions: test schedules, prices, branch locations, promotions and preparation instructions.',
          'We do <strong>not</strong> send medical test results, radiology images, laboratory reports or any other medical record through Instagram. We do <strong>not</strong> use Instagram messaging to connect you with a doctor for a consultation. If you ask for results or medical advice, our staff will direct you to contact the relevant branch by phone or visit us in person.',
        ],
      },
      {
        heading: 'Why we process your data (legal basis)',
        paragraphs: [
          'We process your data to respond to your enquiry and to provide the service you asked for. Where Indonesian law (UU No. 27/2022 on Personal Data Protection) requires consent, we rely on the consent you give by initiating the conversation with us.',
        ],
      },
      {
        heading: 'Who can see your data',
        paragraphs: [
          'Only our authorised customer-service and administrative staff, and the technical personnel who maintain this system, can access your conversations. Access is role-based and logged.',
          'We do not sell your personal data. We do not share it with third parties except: (a) our infrastructure provider, which hosts the server and database on our behalf and is bound to confidentiality; and (b) authorities, where we are legally required to disclose.',
        ],
      },
      {
        heading: 'How long we keep it',
        paragraphs: [
          'Conversations are kept for as long as needed to serve you and to maintain a record of the service we provided. Conversation data is deleted or anonymised when it is no longer needed, or earlier if you ask us to delete it.',
          'Server logs containing technical data are rotated and removed on a short cycle.',
        ],
      },
      {
        heading: 'Your rights',
        paragraphs: ['Under Indonesian personal data protection law you have the right to:'],
        bullets: [
          'Ask what personal data we hold about you, and receive a copy;',
          'Ask us to correct data that is inaccurate;',
          'Ask us to delete your data;',
          'Withdraw consent you have given, where processing is based on consent;',
          'Object to or restrict certain processing;',
          'Lodge a complaint with the competent authority.',
        ],
      },
      {
        heading: 'How to exercise them',
        paragraphs: [
          'Email ' + CONTACT + ' with your request. We will respond within 30 days. We may ask you to verify your identity before acting, so that we do not disclose your data to someone else.',
          'To request deletion specifically, see our data deletion page.',
        ],
      },
      {
        heading: 'Security',
        paragraphs: [
          'Message content is stored encrypted at rest. Access to the system requires an authenticated account, and administrative actions are logged. We restrict access on a need-to-know basis.',
        ],
      },
      {
        heading: 'Children',
        paragraphs: [
          'Our service is not directed to children under 13. If you believe a child has sent us personal data, contact us and we will delete it.',
        ],
      },
      {
        heading: 'Changes to this policy',
        paragraphs: [
          'We may update this policy. The "last updated" date at the top will change when we do. Material changes will be announced on this page.',
        ],
      },
    ],
    deletionLead: 'Want your data deleted?',
    deletionLink: 'See the data deletion page →',
    footer: 'PT Cita Mulia · Parahita Diagnostic Center',
  },
  id: {
    title: 'Kebijakan Privasi',
    updated: 'Terakhir diperbarui: 27 November 2026',
    sections: [
      {
        heading: 'Siapa kami',
        paragraphs: [
          'Layanan ini ("ChatBareng") dijalankan oleh PT Cita Mulia, penyedia layanan kesehatan di Indonesia yang beroperasi dengan merek Parahita Diagnostic Center. Dalam kebijakan ini, "kami" merujuk pada PT Cita Mulia.',
          'Kami bertindak sebagai pengendali data pribadi sebagaimana dijelaskan di bawah ini. Kontak urusan privasi: ' + CONTACT + '.',
        ],
      },
      {
        heading: 'Apa fungsi layanan ini',
        paragraphs: [
          'ChatBareng adalah kotak masuk customer service yang memungkinkan staf kami menerima dan menjawab pesan dari masyarakat melalui WhatsApp dan Instagram. Ini alat internal yang dipakai agen kami sendiri. Kami tidak menjual layanan ini kepada pihak ketiga melalui situs ini.',
        ],
      },
      {
        heading: 'Data apa yang kami kumpulkan',
        paragraphs: ['Kami hanya mengumpulkan yang diperlukan untuk menjawab pertanyaan Anda:'],
        bullets: [
          '<strong>Identitas kontak</strong> — nomor telepon Anda (WhatsApp) atau nama pengguna dan ID akun Instagram.',
          '<strong>Isi pesan</strong> — teks pesan yang Anda kirim, serta foto, dokumen, atau lampiran lain yang Anda bagikan.',
          '<strong>Metadata pesan</strong> — waktu kirim, status terkirim dan terbaca, serta agen kami yang menangani percakapan.',
          '<strong>Data teknis dasar</strong> — alamat IP dan informasi peramban yang tercatat di log server saat Anda memakai aplikasi.',
        ],
      },
      {
        heading: 'Data yang kami terima dari Instagram (Meta)',
        paragraphs: [
          'Ketika Anda mengirim pesan ke akun Instagram kami (@labparahita), Meta Platforms mengirimkan kepada kami nama pengguna Instagram Anda, ID akun (IGSID), isi pesan, dan media yang Anda lampirkan. Kami menerimanya melalui Instagram Messaging API.',
          'Kami memakai data ini untuk satu tujuan saja: membaca pesan Anda dan membalasnya. Kami menyimpannya di basis data kami sendiri agar agen dapat melihat riwayat percakapan.',
          'Sesuai Kebijakan Developer Meta, kami <strong>tidak</strong> memakai data pesan Instagram untuk iklan, profiling, retargeting, atau penjualan data, dan kami tidak membangun profil pengguna darinya. Kami tidak membagikannya ke jaringan iklan atau pialang data.',
        ],
      },
      {
        heading: 'Yang TIDAK kami lakukan lewat Instagram',
        paragraphs: [
          'Pesan langsung Instagram di layanan kami ditangani staf customer service untuk pertanyaan administratif: jadwal pemeriksaan, harga, lokasi cabang, promo, dan persiapan pemeriksaan.',
          'Kami <strong>tidak</strong> mengirim hasil pemeriksaan medis, gambar radiologi, hasil laboratorium, atau rekam medis apa pun melalui Instagram. Kami <strong>tidak</strong> memakai pesan Instagram untuk menghubungkan Anda dengan dokter untuk konsultasi. Bila Anda meminta hasil atau nasihat medis, staf kami akan mengarahkan Anda menghubungi cabang terkait lewat telepon atau datang langsung.',
        ],
      },
      {
        heading: 'Dasar pemrosesan data',
        paragraphs: [
          'Kami memproses data Anda untuk menanggapi pertanyaan Anda dan menyediakan layanan yang Anda minta. Bila UU No. 27/2022 tentang Pelindungan Data Pribadi mensyaratkan persetujuan, kami bersandar pada persetujuan yang Anda berikan saat memulai percakapan dengan kami.',
        ],
      },
      {
        heading: 'Siapa yang dapat melihat data Anda',
        paragraphs: [
          'Hanya staf customer service dan administrasi yang berwenang, serta personel teknis yang memelihara sistem ini, yang dapat mengakses percakapan Anda. Akses berbasis peran dan tercatat dalam log.',
          'Kami tidak menjual data pribadi Anda. Kami tidak membagikannya ke pihak ketiga kecuali: (a) penyedia infrastruktur kami, yang menghosting server dan basis data atas nama kami dan terikat kerahasiaan; dan (b) otoritas, bila kami diwajibkan hukum untuk mengungkapkannya.',
        ],
      },
      {
        heading: 'Berapa lama kami menyimpannya',
        paragraphs: [
          'Percakapan disimpan selama diperlukan untuk melayani Anda dan menjaga catatan layanan yang kami berikan. Data percakapan dihapus atau dianonimkan bila tidak lagi diperlukan, atau lebih cepat bila Anda meminta penghapusan.',
          'Log server yang memuat data teknis dirotasi dan dihapus dalam siklus singkat.',
        ],
      },
      {
        heading: 'Hak Anda',
        paragraphs: ['Berdasarkan hukum pelindungan data pribadi Indonesia, Anda berhak untuk:'],
        bullets: [
          'Mengetahui data pribadi apa yang kami simpan tentang Anda, dan memperoleh salinannya;',
          'Meminta kami memperbaiki data yang tidak akurat;',
          'Meminta kami menghapus data Anda;',
          'Menarik kembali persetujuan yang telah diberikan, bila pemrosesan berdasarkan persetujuan;',
          'Mengajukan keberatan atau pembatasan atas pemrosesan tertentu;',
          'Mengajukan keluhan kepada otoritas yang berwenang.',
        ],
      },
      {
        heading: 'Cara menggunakan hak tersebut',
        paragraphs: [
          'Kirim email ke ' + CONTACT + ' dengan permintaan Anda. Kami akan menanggapi dalam 30 hari. Kami mungkin meminta verifikasi identitas sebelum bertindak, agar data Anda tidak kami berikan kepada orang lain.',
          'Untuk permintaan penghapusan secara khusus, lihat halaman penghapusan data kami.',
        ],
      },
      {
        heading: 'Keamanan',
        paragraphs: [
          'Isi pesan disimpan terenkripsi di penyimpanan. Akses ke sistem memerlukan akun terautentikasi, dan tindakan administratif tercatat dalam log. Kami membatasi akses berdasarkan kebutuhan.',
        ],
      },
      {
        heading: 'Anak-anak',
        paragraphs: [
          'Layanan kami tidak ditujukan untuk anak di bawah 13 tahun. Bila Anda yakin seorang anak telah mengirimkan data pribadi kepada kami, hubungi kami dan kami akan menghapusnya.',
        ],
      },
      {
        heading: 'Perubahan kebijakan ini',
        paragraphs: [
          'Kami dapat memperbarui kebijakan ini. Tanggal "terakhir diperbarui" di atas akan berubah bila demikian. Perubahan material akan diumumkan di halaman ini.',
        ],
      },
    ],
    deletionLead: 'Ingin data Anda dihapus?',
    deletionLink: 'Lihat halaman penghapusan data →',
    footer: 'PT Cita Mulia · Parahita Diagnostic Center',
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
.legal-link {
  color: var(--md-sys-color-primary);
  text-decoration: underline;
  word-break: break-word;
}
</style>
