#!/usr/bin/env python3
"""v0.3.1 — QA Kanaka 01:32: halaman Templates belum mobile friendly.
A) "+ New Template" tidak keliatan di mobile -> tombol full-width di mobile
B) Tabel kepotong -> mobile: kartu per-template (nama, keyword, kategori, isi, Edit/Delete); desktop: tabel (scroll internal tetap)
"""
import sys

p = 'frontend/src/views/Templates.vue'
c = open(p).read()

# ── 1. Header row: tombol full-width di mobile ──
old = '''      <!-- Create button -->
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold">Message Templates</h2>
        <button @click="openCreateForm" class="bg-wa-green text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-600">
          + New Template
        </button>
      </div>'''
new = '''      <!-- Create button (v0.3.1 — mobile: full-width biar selalu keliatan) -->
      <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-4">
        <h2 class="text-lg font-semibold">Message Templates</h2>
        <button @click="openCreateForm" class="w-full md:w-auto bg-wa-green text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-600">
          + New Template
        </button>
      </div>'''
assert old in c, 'block1'
c = c.replace(old, new, 1)

# ── 2. Template list: mobile cards + desktop table ──
old = '''      <!-- Template list -->
      <div class="bg-white rounded-lg shadow-sm overflow-x-auto">
        <div v-if="loading" class="p-8 text-center text-gray-400">Loading templates...</div>
        <div v-else-if="filteredTemplates.length === 0" class="p-8 text-center text-gray-400">
          {{ searchQuery ? 'No templates match your search' : 'No templates yet. Click "New Template" to create one.' }}
        </div>
        <table v-else class="w-full min-w-[640px]">'''
new = '''      <!-- Template list (v0.3.1 — mobile: kartu; desktop: tabel internal-scroll) -->
      <div class="md:hidden space-y-2">
        <div v-if="loading" class="bg-white rounded-lg shadow-sm p-8 text-center text-gray-400 text-sm">Loading templates...</div>
        <div v-else-if="filteredTemplates.length === 0" class="bg-white rounded-lg shadow-sm p-8 text-center text-gray-400 text-sm">
          {{ searchQuery ? 'Tidak ada template yang cocok dengan pencarian' : 'Belum ada template. Tekan "+ New Template" untuk membuat.' }}
        </div>
        <div v-for="tpl in filteredTemplates" :key="tpl.id" class="bg-white rounded-lg shadow-sm p-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="text-sm font-medium truncate">{{ tpl.name }}</div>
              <div class="mt-1 flex items-center gap-1.5 flex-wrap">
                <code class="text-xs bg-gray-100 px-1.5 py-0.5 rounded text-wa-dark">{{ tpl.keyword }}</code>
                <span class="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{{ tpl.category }}</span>
              </div>
            </div>
          </div>
          <div class="text-xs text-gray-600 mt-1.5 line-clamp-2">{{ tpl.content }}</div>
          <div class="flex items-center gap-2 mt-2">
            <button @click="openEditForm(tpl)" class="text-xs px-2.5 py-1.5 rounded bg-blue-100 text-blue-700 active:bg-blue-200">Edit</button>
            <button @click="confirmDelete(tpl)" class="text-xs px-2.5 py-1.5 rounded bg-red-100 text-red-700 active:bg-red-200">Delete</button>
          </div>
        </div>
      </div>

      <div class="hidden md:block bg-white rounded-lg shadow-sm overflow-x-auto">
        <div v-if="loading" class="p-8 text-center text-gray-400">Loading templates...</div>
        <div v-else-if="filteredTemplates.length === 0" class="p-8 text-center text-gray-400">
          {{ searchQuery ? 'No templates match your search' : 'No templates yet. Click "New Template" to create one.' }}
        </div>
        <table v-else class="w-full min-w-[640px]">'''
assert old in c, 'block2'
c = c.replace(old, new, 1)

open(p, 'w').write(c)
print('OK Templates.vue (2 blocks — mobile cards + tombol selalu keliatan)')