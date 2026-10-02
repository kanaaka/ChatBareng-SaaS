<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4" style="padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));" @touchmove.self.prevent>
    <div class="bg-white rounded-xl shadow-2xl border border-gray-200 w-full max-w-md max-h-[90vh] overflow-y-auto overscroll-contain flex flex-col">
      <div class="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-gray-50 rounded-t-xl">
        <h3 class="font-semibold text-gray-800">
          {{ contact?.id ? 'Edit Kontak' : 'Kontak Baru' }}
        </h3>
        <button @click="$emit('close')" class="text-gray-400 hover:text-gray-600 p-1">
          ✕
        </button>
      </div>

      <div class="p-4 space-y-4">
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Nama</label>
          <input
            v-model="form.name"
            type="text"
            placeholder="Nama kontak"
            class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-wa-green"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Nomor WhatsApp</label>
          <input
            v-model="form.phone"
            type="text"
            placeholder="628xxxxxxxxxx"
            class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-wa-green"
          />
          <p class="text-[10px] text-gray-400 mt-0.5">Format: 628xxxxxxxxxx — otomatis tersimpan dari chat; kosong berarti nomor belum tershared</p>
        </div>

        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Tanggal Lahir</label>
          <input
            v-model="form.birthDate"
            type="date"
            class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-wa-green"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Jenis Kelamin</label>
          <select
            v-model="form.gender"
            class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-wa-green"
          >
            <option value="">—</option>
            <option value="male">Laki-laki</option>
            <option value="female">Perempuan</option>
          </select>
        </div>

        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Kota</label>
          <input
            v-model="form.city"
            type="text"
            placeholder="Kota"
            class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-wa-green"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Catatan</label>
          <textarea
            v-model="form.note"
            rows="3"
            placeholder="Catatan internal..."
            class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-wa-green"
          ></textarea>
        </div>

        <div v-if="error" class="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">
          {{ error }}
        </div>

        <div v-if="success" class="text-xs text-green-700 bg-green-50 px-3 py-2 rounded-lg">
          {{ success }}
        </div>
      </div>

      <div class="p-4 border-t border-gray-200 flex items-center justify-between gap-2 bg-gray-50 rounded-b-xl">
        <button
          v-if="contact?.id"
          @click="openChatAgain"
          :disabled="saving"
          class="px-4 py-2 text-sm font-medium rounded-lg border border-wa-green text-wa-green hover:bg-green-50 disabled:opacity-50"
        >
          💬 Buka Chat
        </button>
        <div class="flex items-center gap-2 ml-auto">
          <button
            @click="$emit('close')"
            :disabled="saving"
            class="px-4 py-2 text-sm font-medium rounded-lg text-gray-600 hover:bg-gray-100 disabled:opacity-50"
          >
            Batal
          </button>
          <button
            @click="save"
            :disabled="saving"
            class="px-4 py-2 text-sm font-medium rounded-lg bg-wa-green text-white hover:bg-green-600 disabled:opacity-50"
          >
            {{ saving ? 'Menyimpan...' : 'Simpan' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import axios from 'axios'
import { useAuthStore } from '../stores/auth'

const props = defineProps({
  contact: { type: Object, default: null },
  chatId: { type: String, default: null },
})

const emit = defineEmits(['saved', 'close', 'open-chat'])

const API = import.meta.env.VITE_API_URL || ''
const auth = useAuthStore()

const form = ref({
  name: '',
  phone: '',
  birthDate: '',
  gender: '',
  city: '',
  note: '',
})

const saving = ref(false)
const error = ref('')
const success = ref('')

function contactToForm(contact) {
  if (!contact) {
    form.value = { name: '', phone: '', birthDate: '', gender: '', city: '', note: '' }
    return
  }
  form.value = {
    name: contact.name || '',
    phone: contact.phone || '',
    birthDate: contact.birthDate ? new Date(contact.birthDate).toISOString().split('T')[0] : '',
    gender: contact.gender || '',
    city: contact.city || '',
    note: contact.note || '',
  }
}

watch(() => props.contact, (contact) => {
  contactToForm(contact)
  error.value = ''
  success.value = ''
}, { immediate: true })

// v0.3.7 — scroll-lock halaman belakang selama modal kebuka (mobile: swipe di luar kartu gak nge-scroll list kontak)
let prevBodyOverflow = null
onMounted(() => {
  prevBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
})
onBeforeUnmount(() => {
  document.body.style.overflow = prevBodyOverflow ?? ''
})

const isCreate = computed(() => !props.contact?.id)

async function save() {
  saving.value = true
  error.value = ''
  success.value = ''
  try {
    let contact
    if (isCreate.value) {
      const res = await axios.post(`${API}/api/contacts`, form.value, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      contact = res.data.contact
    } else {
      const res = await axios.put(`${API}/api/contacts/${props.contact.id}`, form.value, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      contact = res.data.contact
    }
    success.value = 'Kontak tersimpan.'
    emit('saved', contact)
    // Auto-close after short delay if user doesn't want to see toast
    setTimeout(() => {
      if (!error.value) emit('close')
    }, 800)
  } catch (e) {
    console.error('Save contact error:', e)
    error.value = e.response?.data?.error || 'Gagal menyimpan kontak.'
  } finally {
    saving.value = false
  }
}

function openChatAgain() {
  if (!props.contact?.id) return
  emit('open-chat', props.contact)
}
</script>
