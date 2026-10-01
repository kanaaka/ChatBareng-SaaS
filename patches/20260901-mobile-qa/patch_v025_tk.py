#!/usr/bin/env python3
"""v0.2.5 — QA feedback Kanaka (00:12):
1. Judul "Tangan Kanan" + tombol ✕ dobel di mobile (sheet wrapper + header internal) -> header internal hidden di mobile-full
2. Tombol 🔗 Link nyeleneh di header -> dihapus; section Link dapat tombol "+" sendiri (konsisten dgn Document/Image)
3. Link form pindah dari header-area ke DALAM section Link
"""
import sys

p = 'frontend/src/components/TanganKanan.vue'
c = open(p).read()

# ── 1. Header internal: hidden di mobile-full (sheet wrapper sudah punya judul + ✕) ──
old = '''    <!-- Header -->
    <div class="px-3 py-3 border-b border-gray-200 flex items-center gap-2 flex-shrink-0">'''
new = '''    <!-- Header (v0.2.5 — hidden di mobile-full: sheet wrapper sudah punya judul + ✕, fix judul dobel) -->
    <div v-if="!mobileFull" class="px-3 py-3 border-b border-gray-200 flex items-center gap-2 flex-shrink-0">'''
assert old in c, 'block1'
c = c.replace(old, new, 1)

# ── 2. Buang tombol 🔗 dari header ──
old = '''      <span class="font-semibold text-sm text-gray-700">Tangan Kanan</span>
      <div class="ml-auto relative">
        <button
          @click="showLinkForm = !showLinkForm"
          class="text-gray-500 hover:text-wa-green p-1 rounded hover:bg-gray-100"
          title="Add link"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
        </button>
      </div>'''
new = '''      <span class="font-semibold text-sm text-gray-700">Tangan Kanan</span>'''
assert old in c, 'block2'
c = c.replace(old, new, 1)

# ── 3. Tombol "+" folder: Link folder juga dapat (toggle form link) ──
old = '''            <button
              v-if="folder.name !== 'Link'"
              @click.stop="triggerUpload(folder.id)"
              class="text-gray-400 hover:text-wa-green p-0.5 rounded hover:bg-gray-100"
              title="Upload to this folder"
            >'''
new = '''            <button
              @click.stop="folder.name === 'Link' ? (showLinkForm = !showLinkForm) : triggerUpload(folder.id)"
              class="text-gray-400 hover:text-wa-green p-0.5 rounded hover:bg-gray-100"
              :title="folder.name === 'Link' ? 'Add link' : 'Upload to this folder'"
            >'''
assert old in c, 'block3'
c = c.replace(old, new, 1)

# ── 4. Pindahkan link form: hapus dari posisi lama ──
old_form = '''    <!-- Link form -->
    <div v-if="showLinkForm" class="px-3 py-3 border-b border-gray-200 bg-gray-50 flex-shrink-0">
      <div class="space-y-2">
        <input
          v-model="linkUrl"
          type="url"
          placeholder="https://..."
          class="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent"
        />
        <input
          v-model="linkTitle"
          type="text"
          placeholder="Title (optional)"
          class="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent"
        />
        <div class="flex gap-2">
          <button
            @click="addLink"
            :disabled="!linkUrl.trim() || linking"
            class="flex-1 px-3 py-1.5 text-sm bg-wa-green text-white rounded-lg hover:bg-green-600 disabled:opacity-50"
          >
            {{ linking ? 'Adding...' : 'Add Link' }}
          </button>
          <button
            @click="showLinkForm = false; linkUrl = ''; linkTitle = ''"
            class="px-3 py-1.5 text-sm bg-gray-200 text-gray-600 rounded-lg hover:bg-gray-300"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>

    <!-- Scrollable content -->'''
assert old_form in c, 'block4a'
c = c.replace(old_form, '''    <!-- Scrollable content -->''', 1)

# ── 4b. Sisipkan form link di DALAM section Link (setelah header folder, sebelum daftar file) ──
anchor = '''          </div>
          <div
            v-for="file in (folder.files || [])"'''
inline_form = '''          </div>
          <!-- Link form (v0.2.5 — pindah dari header ke section-nya, konsisten dgn + Document/Image) -->
          <div v-if="folder.name === 'Link' && showLinkForm" class="px-3 py-3 bg-gray-50 border-t border-gray-100">
            <div class="space-y-2">
              <input
                v-model="linkUrl"
                type="url"
                placeholder="https://..."
                class="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent"
              />
              <input
                v-model="linkTitle"
                type="text"
                placeholder="Title (optional)"
                class="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-1 focus:ring-wa-green focus:border-transparent"
              />
              <div class="flex gap-2">
                <button
                  @click="addLink"
                  :disabled="!linkUrl.trim() || linking"
                  class="flex-1 px-3 py-1.5 text-sm bg-wa-green text-white rounded-lg hover:bg-green-600 disabled:opacity-50"
                >
                  {{ linking ? 'Adding...' : 'Add Link' }}
                </button>
                <button
                  @click="showLinkForm = false; linkUrl = ''; linkTitle = ''"
                  class="px-3 py-1.5 text-sm bg-gray-200 text-gray-600 rounded-lg hover:bg-gray-300"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
          <div
            v-for="file in (folder.files || [])"'''
assert anchor in c, 'block4b'
c = c.replace(anchor, inline_form, 1)

open(p, 'w').write(c)
print('OK TanganKanan.vue (5 blocks — header hidden mobile, link btn ke section, form inline)')