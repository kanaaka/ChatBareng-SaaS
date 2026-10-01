#!/usr/bin/env python3
"""v0.3.0 part 2 — wrap Analytics & Templates dengan PageShell (back ke /admin)
+ Templates table internal scroll + import PageShell."""
import sys

def apply(path, pairs):
    c = open(path).read()
    for i, (old, new) in enumerate(pairs):
        if old not in c:
            print(f'ANCHOR FAIL {path} block#{i}')
            sys.exit(1)
        c = c.replace(old, new, 1)
    open(path, 'w').write(c)
    print(f'OK  {path} ({len(pairs)} blocks)')

# ── Templates.vue ──
p = 'frontend/src/views/Templates.vue'
c = open(p).read()

old = '''<template>
  <div class="min-h-screen bg-gray-100">
    <!-- Top bar -->
    <header class="bg-wa-dark text-white px-4 py-3 flex items-center justify-between">'''
new = '''<template>
  <PageShell title="Templates" back-to="/admin">
    <!-- Top bar (desktop only — mobile: PageShell topbar + homerow, v0.3.0) -->
    <header class="hidden md:flex bg-wa-dark text-white px-4 py-3 items-center justify-between">'''
assert old in c, 'T1'
c = c.replace(old, new, 1)

# closing: last '  </div>\n</template>' before <script setup>
idx = c.find('<script setup>')
head = c[:idx]
pos = head.rfind('\n  </div>\n</template>')
assert pos != -1, 'T2'
c = c[:pos] + '\n  </PageShell>\n</template>' + c[pos + len('\n  </div>\n</template>'):]

# import
old = '<script setup>'
assert old in c, 'T3'
c = c.replace(old, "<script setup>\nimport PageShell from '../components/PageShell.vue'", 1)

# table scroll fix (feedback #4): container overflow-x-auto + min width
old = '''      <div class="bg-white rounded-lg shadow-sm overflow-hidden">
        <div v-if="loading" class="p-8 text-center text-gray-400">Loading templates...</div>
        <div v-else-if="filteredTemplates.length === 0" class="p-8 text-center text-gray-400">
          {{ searchQuery ? 'No templates match your search' : 'No templates yet. Click "New Template" to create one.' }}
        </div>
        <table v-else class="w-full">'''
new = '''      <div class="bg-white rounded-lg shadow-sm overflow-x-auto">
        <div v-if="loading" class="p-8 text-center text-gray-400">Loading templates...</div>
        <div v-else-if="filteredTemplates.length === 0" class="p-8 text-center text-gray-400">
          {{ searchQuery ? 'No templates match your search' : 'No templates yet. Click "New Template" to create one.' }}
        </div>
        <table v-else class="w-full min-w-[640px]">'''
assert old in c, 'T4'
c = c.replace(old, new, 1)

open(p, 'w').write(c)
print('PART T OK — Templates')

# ── Analytics.vue ──
p = 'frontend/src/views/Analytics.vue'
c = open(p).read()

old = '''<template>
  <div class="min-h-screen bg-gray-100">
    <!-- Top bar -->
    <header class="bg-wa-dark text-white px-4 py-3 flex items-center justify-between">'''
new = '''<template>
  <PageShell title="Analytics" back-to="/admin">
    <!-- Top bar (desktop only — mobile: PageShell topbar + homerow, v0.3.0) -->
    <header class="hidden md:flex bg-wa-dark text-white px-4 py-3 items-center justify-between">'''
assert old in c, 'A1'
c = c.replace(old, new, 1)

idx = c.find('<script setup>')
head = c[:idx]
pos = head.rfind('\n  </div>\n</template>')
assert pos != -1, 'A2'
c = c[:pos] + '\n  </PageShell>\n</template>' + c[pos + len('\n  </div>\n</template>'):]

old = '<script setup>'
assert old in c, 'A3'
c = c.replace(old, "<script setup>\nimport PageShell from '../components/PageShell.vue'", 1)

open(p, 'w').write(c)
print('PART A OK — Analytics')

# ── Announcements.vue: tambah back-to launcher ──
p = 'frontend/src/views/Announcements.vue'
c = open(p).read()
old = '<PageShell title="Pengumuman">'
new = '<PageShell title="Pengumuman" back-to="/admin">'
assert old in c, 'N1'
c = c.replace(old, new, 1)
open(p, 'w').write(c)
print('PART N OK — Announcements back-to')

print('ALL OK')