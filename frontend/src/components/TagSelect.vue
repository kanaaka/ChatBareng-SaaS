<template>
  <!--
    v0.13.1 — TagSelect: dropdown pilih tag existing + inline creation.
    Kanaka request 01:01 — tag bisa dibuat SAAT JUGA dari halaman Menu Gateway
    (alih-alih bolak-balik ke Admin → Tag). Additive: tag baru di-emit ke parent
    (dipakai untuk sync daftar tags) + modelValue otomatis ter-set ke tag baru.
  -->
  <div class="inline-flex flex-col gap-1">
    <template v-if="!creating">
      <select
        :value="modelValue ?? ''"
        class="px-2 py-1.5 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
        style="min-height: 36px;"
        @change="onChange"
      >
        <option value="">— tanpa tag —</option>
        <option v-for="t in tags" :key="t.id" :value="String(t.id)">{{ t.name }}</option>
        <option value="__new">+ Buat tag baru…</option>
      </select>
    </template>
    <template v-else>
      <div class="flex items-center gap-1">
        <input
          v-model="newName"
          type="text"
          maxlength="40"
          placeholder="Nama tag baru"
          class="px-2 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          style="min-height: 36px; min-width: 130px;"
          @keydown.enter.prevent="create"
          @keydown.esc.prevent="cancel"
        />
        <button
          type="button"
          :disabled="!newName.trim() || busy"
          class="px-2 py-1 bg-green-600 text-white rounded-lg text-xs hover:bg-green-700 disabled:opacity-50"
          style="min-height: 32px;"
          @click="create"
        >✓</button>
        <button
          type="button"
          class="px-2 py-1 bg-gray-100 text-gray-600 rounded-lg text-xs hover:bg-gray-200"
          style="min-height: 32px;"
          @click="cancel"
        >✕</button>
      </div>
      <span v-if="err" class="text-[11px] text-red-600">{{ err }}</span>
    </template>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import axios from 'axios'

const props = defineProps({
  modelValue: { type: Number, default: null },
  tags: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:modelValue', 'created'])

const API = import.meta.env.VITE_API_URL || ''

const creating = ref(false)
const newName = ref('')
const busy = ref(false)
const err = ref('')

function onChange(e) {
  err.value = ''
  const v = e.target.value
  if (v === '__new') {
    creating.value = true
    newName.value = ''
    return
  }
  emit('update:modelValue', v === '' ? null : Number(v))
}

function cancel() {
  creating.value = false
  newName.value = ''
  err.value = ''
}

async function create() {
  const name = newName.value.trim()
  if (!name || busy.value) return
  busy.value = true
  err.value = ''
  try {
    const res = await axios.post(`${API}/api/tags`, { name })
    const tag = res.data.tag
    emit('created', tag)
    emit('update:modelValue', tag.id)
    creating.value = false
    newName.value = ''
  } catch (e) {
    if (e.response?.status === 409 && e.response?.data?.tag) {
      // Tag sudah ada → langsung bind ke tag existing (idempoten UX)
      emit('created', e.response.data.tag)
      emit('update:modelValue', e.response.data.tag.id)
      creating.value = false
      newName.value = ''
    } else {
      err.value = e.response?.data?.error || 'Gagal membuat tag'
    }
  } finally {
    busy.value = false
  }
}
</script>