<template>
  <!--
    v0.2.0 ChatDetail — seluruh thread chat dari Dashboard.vue v0.1.x.
    Mobile: full-screen (parent Dashboard mengontrol layout). Desktop: pane kanan split.
    Header: ← back (mobile) + nama + ⋮ kebab (KebabMenu) di KEDUA viewport (§3.5).
    Composer: visualViewport-safe (naik di atas keyboard, spec §3.2).
    Semua handler socket/API dipakai ulang dari Dashboard via props/events? TIDAK —
    socket handler tetap di Dashboard (satu sumber), ChatDetail menerima state via
    props + emit aksi. Ini menjaga logika realtime di satu tempat (v0.1.22–27 safe).
  -->
  <div ref="rootEl" class="flex flex-col h-full bg-gray-50 min-w-0">
    <!-- Chat header -->
    <div class="bg-white border-b border-gray-200 px-3 py-2 flex-shrink-0 flex items-center gap-2" style="min-height:56px; padding-top: env(safe-area-inset-top, 0px);">
      <!-- Back button: universal (iOS tidak punya back) -->
      <button
        v-if="isMobile"
        @click="goBack"
        class="p-2 -ml-1 rounded-full active:bg-gray-100 text-gray-600 flex-shrink-0"
        title="Back"
      >
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <div class="flex items-center gap-3 min-w-0 flex-1 cursor-pointer" @click="openContactEdit">
        <div class="w-10 h-10 rounded-full bg-wa-dark text-white flex items-center justify-center text-sm font-semibold flex-shrink-0">
          {{ getInitials(groupChat ? (chat.contactName || 'Grup') : (chat.contactName || chat.contactPhone)) }}
        </div>
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-medium truncate">{{ chat.contactName || (groupChat ? 'Grup WhatsApp' : chat.contactPhone) }}</span>
            <!-- v0.14.0 — badge grup -->
            <span v-if="groupChat" class="inline-flex items-center gap-1 bg-emerald-100 text-emerald-700 text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0">👥 Grup</span>
            <span v-if="chat.status === 'resolved'" class="inline-flex items-center gap-1 bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0">
              ✓ Resolved
            </span>
            <!-- v0.10.0 — Fitur C: badge rating CSAT terakhir -->
            <span v-if="lastCsatRating" class="inline-flex items-center gap-1 bg-yellow-100 text-yellow-700 text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0">
              ⭐ {{ lastCsatRating }}
            </span>
          </div>
          <div class="text-xs text-gray-500 truncate">
            <!-- v0.14.0 — grup: jumlah member; 1:1: nomor HP (perilaku existing) -->
            <template v-if="groupChat">{{ groupSubtitle }}</template>
            <template v-else>{{ formatPhone(chat.contactPhone) }}</template>
            <span v-if="chat.assignedTo" class="text-blue-500">· @{{ chat.assignedTo.username }}</span>
            <!-- v0.10.0 — Fitur A: badge snooze aktif di header -->
            <span v-if="isSnoozed" class="text-amber-600 font-medium">· 😴 Kembali {{ snoozeUntilLabel }}</span>
          </div>
        </div>
      </div>

      <!-- Quick actions (desktop only, hidden di mobile — kebab menggantikan) -->
      <div class="hidden md:flex items-center gap-1 flex-shrink-0">
        <button
          @click="$emit('toggle-favorites')"
          :class="['text-sm px-3 py-1.5 rounded-lg font-medium', showFavoritesPanel ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-700 hover:bg-gray-200']"
        >
          ⭐
        </button>
        <button
          @click="$emit('toggle-search')"
          :class="['text-sm px-3 py-1.5 rounded-lg', showSearchBar ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-700 hover:bg-gray-200']"
          title="Search messages (Ctrl+F)"
        >
          <svg class="w-4 h-4 inline-block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </button>
      </div>

      <!-- v0.10.1 — Toggle Catatan/Terjadwal di header: DESKTOP chip + MOBILE icon di samping kebab -->
      <!-- v0.14.0 — grup: notes/snooze/kebab 1:1 disembunyikan (kelola via panel Grup) -->
      <button
        v-if="!groupChat"
        @click="vpanelsDesktopOpen = !vpanelsDesktopOpen"
        :class="['hidden md:inline-flex text-sm px-3 py-1.5 rounded-lg font-medium', vpanelsOpen ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700 hover:bg-gray-200']"
        :title="vpanelsOpen ? 'Sembunyikan catatan & terjadwal' : 'Tampilkan catatan & terjadwal'"
      >
        📝 Notes
      </button>
      <button
        v-if="isMobile && !groupChat"
        @click="vpanelsMobileOpen = !vpanelsMobileOpen"
        class="p-2 rounded-full active:bg-gray-100 text-gray-600 flex-shrink-0"
        :title="vpanelsMobileOpen ? 'Tutup catatan & terjadwal' : 'Buka catatan & terjadwal'"
        style="min-width: 44px; min-height: 44px;"
      >
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      </button>

      <!-- Kebab menu ⋮ (kedua viewport, §3.3) — grup: sembunyikan (aksi 1:1 tak berlaku;
           release di grup akan melepas PIC → melanggar invariant born-assigned spec §3/§4) -->
      <KebabMenu
        v-if="!groupChat"
        :chat="chat"
        :transfer-users="canTransfer ? transferUsers : []"
        :is-snoozed="isSnoozed"
        @transfer="userId => $emit('transfer', userId)"
        @release="$emit('release')"
        @resolve="$emit('resolve')"
        @tangan-kanan="$emit('tangan-kanan')"
        @snooze="$emit('snooze')"
        @cancel-snooze="$emit('cancel-snooze')"
        @delete-chat="deleteContact => $emit('delete-chat', deleteContact)"
      />
    </div>

    <!-- Tags row -->
    <div class="bg-white border-b border-gray-200 px-3 py-2 flex items-center gap-2 flex-wrap flex-shrink-0">
      <span
        v-for="ct in currentChatTags"
        :key="ct.tag.id"
        :class="['inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium', tagColorClass(ct.tag.color)]"
      >
        {{ ct.tag.name }}
        <button
          v-if="canEditTags"
          @click="$emit('remove-tag', ct.tag.id)"
          class="ml-0.5 hover:text-red-500"
          title="Remove tag"
        >×</button>
      </span>
      <div v-if="canEditTags" class="relative">
        <button
          @click.stop="showTagMenu = !showTagMenu"
          class="inline-flex items-center gap-1 px-2 h-6 rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 text-xs"
          title="Add tag"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5a1.99 1.99 0 011.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.99 1.99 0 013 12V7a4 4 0 014-4z" />
          </svg>
          Add tag
        </button>
        <div v-if="showTagMenu" @click.stop class="absolute left-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 min-w-[200px] max-h-[300px] overflow-y-auto">
          <div v-if="availableTags.length > 0" class="py-1">
            <div
              v-for="tag in availableTags"
              :key="tag.id"
              @click="$emit('add-tag', tag.id); showTagMenu = false"
              class="px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 flex items-center gap-2"
            >
              <span :class="['w-3 h-3 rounded-full', tagDotClass(tag.color)]"></span>
              {{ tag.name }}
            </div>
          </div>
          <div v-else class="px-3 py-2 text-xs text-gray-400">No tags yet — create one below</div>
          <div class="border-t border-gray-100"></div>
          <div class="p-2">
            <div class="flex items-center gap-1 mb-2">
              <span class="text-xs text-gray-400 mr-1">Color:</span>
              <button
                v-for="c in tagColors"
                :key="c.value"
                @click="newTagColor = c.value"
                :class="['w-4 h-4 rounded-full border-2', tagDotClass(c.value), newTagColor === c.value ? 'border-gray-800' : 'border-transparent']"
              ></button>
            </div>
            <div class="flex gap-1">
              <input
                v-model="newTagName"
                @keydown.enter="emitCreateTag"
                type="text"
                placeholder="New tag name..."
                class="flex-1 px-2 py-1 text-xs border border-gray-200 rounded focus:ring-1 focus:ring-wa-green focus:border-transparent"
              />
              <button
                @click="emitCreateTag"
                :disabled="!newTagName.trim()"
                class="px-2 py-1 text-xs bg-wa-green text-white rounded hover:bg-green-600 disabled:opacity-50"
              >Add</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Search bar -->
    <div v-if="showSearchBar" class="bg-white border-b border-gray-200 px-4 py-2 flex-shrink-0">
      <div class="flex items-center gap-2">
        <div class="flex-1 relative">
          <input
            ref="searchInputRef"
            :value="searchQuery"
            @input="$emit('update:searchQuery', $event.target.value)"
            type="text"
            placeholder="Search messages in this chat..."
            class="w-full px-4 py-2 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-400 focus:border-transparent"
          />
          <button
            @click="$emit('close-search')"
            class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            title="Close search (Escape)"
          >✕</button>
        </div>
        <span v-if="searchQuery.trim()" class="text-xs text-gray-500 whitespace-nowrap">
          {{ searchResults.length }} result{{ searchResults.length === 1 ? '' : 's' }}
        </span>
      </div>
      <div v-if="searchResults.length > 0" class="mt-2 max-h-64 overflow-y-auto border border-gray-100 rounded-lg">
        <div
          v-for="msg in searchResults"
          :key="msg.id"
          @click="$emit('jump-to', msg.id)"
          class="px-3 py-2 hover:bg-blue-50 cursor-pointer border-b border-gray-50 last:border-0"
        >
          <div class="flex items-center gap-2">
            <span :class="['text-xs font-medium', msg.direction === 'in' ? 'text-gray-600' : 'text-green-600']">
              {{ msg.direction === 'in' ? 'Customer' : '@' + msg.senderName }}
            </span>
            <span class="text-xs text-gray-400">{{ formatTime(msg.timestamp) }}</span>
          </div>
          <div class="text-sm text-gray-700 truncate">{{ msg.content || '[' + (msg.mediaType || 'media') + ']' }}</div>
        </div>
      </div>
      <div v-else-if="searchQuery.trim().length >= 2 && !searchLoading" class="mt-2 text-center text-xs text-gray-400">
        No results found
      </div>
    </div>

    <!-- Favorites panel -->
    <div v-if="showFavoritesPanel" class="bg-white border-b border-gray-200 px-4 py-2 flex-shrink-0">
      <div class="flex items-center justify-between mb-2">
        <span class="text-sm font-medium text-gray-700">⭐ Favorited messages</span>
        <button @click="$emit('toggle-favorites')" class="text-gray-400 hover:text-gray-600 text-sm">✕</button>
      </div>
      <div v-if="favoritesLoading" class="text-center text-xs text-gray-400 py-2">Loading favorites...</div>
      <div v-else-if="chatFavorites.length === 0" class="text-center text-xs text-gray-400 py-2">
        No favorites yet. Click the ☆ star on a message to add it.
      </div>
      <div v-else class="max-h-64 overflow-y-auto border border-gray-100 rounded-lg">
        <div
          v-for="fav in chatFavorites"
          :key="fav.id"
          class="px-3 py-2 hover:bg-yellow-50 cursor-pointer border-b border-gray-50 last:border-0"
          @click="$emit('jump-to', fav.message.id)"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <span :class="['text-xs font-medium', fav.message.direction === 'in' ? 'text-gray-600' : 'text-green-600']">
                {{ fav.message.direction === 'in' ? 'Customer' : '@' + fav.message.senderName }}
              </span>
              <span class="text-xs text-gray-400">{{ formatTime(fav.message.timestamp) }}</span>
            </div>
            <button
              @click.stop="$emit('toggle-favorite', fav.message.id)"
              class="text-yellow-500 hover:text-gray-300"
              title="Remove from favorites"
            >
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
              </svg>
            </button>
          </div>
          <div class="text-sm text-gray-700 truncate">{{ fav.message.content || '[' + (fav.message.mediaType || 'media') + ']' }}</div>
        </div>
      </div>
    </div>

    <!-- v0.10.0 — Fitur B + D: panel Catatan Internal + Pesan Terjadwal.
         v0.10.1 — SELALU ke-render (bukan hanya kalau ada isi) + toggle manual di header
         (kebab mobile & button desktop) → empty state rapi, note pertama bisa ditulis kapan pun. -->
    <div v-if="vpanelsOpen" class="bg-white border-b border-gray-200 px-3 py-2 flex-shrink-0 flex flex-col md:flex-row gap-3">
      <div class="flex-1 min-w-0">
        <NotesPanel
          :notes="notes"
          :loading="notesLoading"
          :adding="notesAdding"
          :draft="noteDraft"
          :can-write="canManageNotes"
          collapsible
          @update:draft="$emit('update:noteDraft', $event)"
          @add-note="$emit('add-note')"
          @delete-note="noteId => $emit('delete-note', noteId)"
        />
      </div>
      <div class="flex-1 min-w-0">
        <ScheduledPanel
          :scheduled="scheduled"
          :loading="scheduledLoading"
          collapsible
          @cancel="smId => $emit('cancel-scheduled', smId)"
        />
      </div>
    </div>

    <!-- Messages -->
    <div ref="messagesContainer" class="flex-1 overflow-y-auto overscroll-contain p-4 space-y-2">
      <div v-if="loadingMessages" class="text-center text-gray-400">Loading messages...</div>
      <!-- v0.14.4 — overlay transparan utk tutup popover peserta (klik-luar) -->
      <div v-if="senderMenu.msgId" class="fixed inset-0 z-10" @click.stop="closeSenderMenu"></div>

      <div
        v-for="msg in messages"
        :key="msg.id"
        :id="'msg-' + msg.id"
        :class="['group relative w-fit max-w-[70%] rounded-lg px-4 py-2 transition-colors duration-1000 break-words overflow-wrap-anywhere min-w-0', msg.direction === 'in' ? 'bg-white self-start' : 'bg-wa-light self-end ml-auto', highlightedMsgId === msg.id ? 'ring-2 ring-yellow-400 bg-yellow-50' : '']"
      >
        <button
          @click="$emit('toggle-favorite', msg.id)"
          :class="['absolute top-1 text-gray-300 hover:text-yellow-500 opacity-0 group-hover:opacity-100 transition-opacity', msg.direction === 'in' ? '-right-6' : '-left-6']"
          :title="favoritedMsgIds.has(msg.id) ? 'Remove from favorites' : 'Add to favorites'"
        >
          <svg v-if="favoritedMsgIds.has(msg.id)" class="w-4 h-4 text-yellow-500" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
          </svg>
          <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
          </svg>
        </button>
        <!-- v0.14.0 — pengirim grup: nama/HP participant (additive; 1:1 tidak berubah) -->
        <!-- v0.14.4 — label jadi tombol HANYA utk bubble 'in' grup dgn participantJid;
             pesanan lama (participantJid null) tetap teks biasa. stopPropagation agar
             tidak bentrok tombol favorit/klik bubble lain. -->
        <button
          v-if="msg.direction === 'in' && messageSenderLabel(msg) && msg.participantJid && groupChat"
          type="button"
          class="text-xs text-blue-700 mb-0.5 font-medium hover:underline cursor-pointer text-left"
          :title="'Aksi untuk ' + messageSenderLabel(msg)"
          @click.stop="openSenderMenu(msg)"
        >
          {{ messageSenderLabel(msg) }}
        </button>
        <div v-else-if="msg.direction === 'in' && messageSenderLabel(msg)" class="text-xs text-blue-700 mb-0.5 font-medium">
          {{ messageSenderLabel(msg) }}
        </div>
        <!-- v0.14.4 — popover menu peserta: 💾 Simpan ke Kontak + ✉️ Pesan Pribadi.
             Absolute anchored di label (bubble container sudah `relative`); overlay
             transparan utk klik-luar + Escape. 1:1 tidak pernah render ini. -->
        <div
          v-if="senderMenu.msgId === msg.id"
          class="absolute z-20 bg-white rounded-lg shadow-lg border border-gray-200 min-w-[190px] max-w-[240px]"
          :class="msg.direction === 'in' ? 'top-6 left-3' : 'top-6 right-3'"
          @click.stop
        >
          <!-- mode menu: 2 aksi -->
          <template v-if="senderMenu.mode === 'menu'">
            <div class="px-3 py-1.5 text-[10px] uppercase tracking-wide text-gray-400 border-b border-gray-100 font-medium truncate">{{ messageSenderLabel(msg) }}</div>
            <button
              type="button"
              class="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2"
              :disabled="senderMenu.loading"
              @click="saveToContact(msg)"
            >
              💾 Simpan ke Kontak
            </button>
            <button
              type="button"
              class="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2 border-t border-gray-100"
              :disabled="senderMenu.loading"
              @click="senderMenu.mode = 'pm'; senderMenu.pmText = ''; $nextTick(() => pmInputRef?.focus())"
            >
              ✉️ Pesan Pribadi
            </button>
          </template>
          <!-- mode mini-composer: pesan pribadi -->
          <template v-else>
            <div class="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-gray-400 border-b border-gray-100 font-medium truncate">✉️ → {{ messageSenderLabel(msg) }}</div>
            <div class="p-2">
              <textarea
                ref="pmInputRef"
                v-model="senderMenu.pmText"
                rows="2"
                class="w-full text-sm border border-gray-200 rounded-md px-2 py-1.5 focus:ring-1 focus:ring-wa-green focus:border-transparent resize-none placeholder:text-gray-400"
                placeholder="Tulis pesan pribadi…"
                @keydown="onPmKeydown"
              ></textarea>
              <div class="flex items-center justify-end gap-1 mt-1">
                <button
                  type="button"
                  class="px-2.5 py-1 text-xs rounded-md text-gray-600 hover:bg-gray-100"
                  :disabled="senderMenu.sending"
                  @click="senderMenu.mode = 'menu'"
                >Batal</button>
                <button
                  type="button"
                  class="px-2.5 py-1 text-xs rounded-md bg-wa-green text-white font-medium hover:bg-green-600 disabled:opacity-50"
                  :disabled="senderMenu.sending || !senderMenu.pmText.trim()"
                  @click="sendPrivateMessage(msg)"
                >{{ senderMenu.sending ? 'Mengirim…' : 'Kirim' }}</button>
              </div>
            </div>
          </template>
        </div>
        <div v-if="msg.direction === 'out'" class="text-xs text-green-700 mb-0.5">
          <span v-if="msg.isAuto" class="inline-flex items-center gap-1 mr-1 px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-[10px] align-middle">⚙️ Otomatis</span>
          @{{ msg.senderName }}
        </div>
        <!-- Media display -->
        <div v-if="msg.mediaType === 'image'" class="mb-1 relative group">
          <img :src="`/api/media/${msg.id}?token=${auth.token}`" alt="image"
            class="rounded-lg max-w-[300px] w-full h-auto cursor-pointer"
            @click="openLightbox(msg)" />
          <button
            @click="downloadMedia(msg)"
            class="absolute top-2 right-2 bg-black/60 text-white rounded-full w-8 h-8 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
            title="Download">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4" />
            </svg>
          </button>
        </div>
        <div v-else-if="msg.mediaType === 'video'" class="mb-1">
          <video controls :src="`/api/media/${msg.id}?token=${auth.token}`" class="rounded-lg max-w-[300px] w-full"></video>
        </div>
        <div v-else-if="msg.mediaType === 'audio'" class="mb-1">
          <audio controls :src="`/api/media/${msg.id}?token=${auth.token}`" class="w-full max-w-[300px]"></audio>
        </div>
        <div v-else-if="msg.mediaType === 'sticker'" class="mb-1 relative group">
          <img :src="`/api/media/${msg.id}?token=${auth.token}`" alt="sticker"
            class="rounded-lg max-w-[200px] w-full h-auto cursor-pointer"
            @click="openLightbox(msg)" />
        </div>
        <div v-else-if="msg.mediaType === 'document'" class="mb-1">
          <a :href="`/api/media/${msg.id}?token=${auth.token}`" download class="inline-flex items-center gap-2 text-blue-600 hover:underline text-sm">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
            </svg>
            Download file
          </a>
        </div>
        <div v-if="msg.content" class="text-sm break-words whitespace-pre-line" style="overflow-wrap: anywhere;">{{ msg.content }}</div>
        <!-- v0.14.5 — whitespace-pre-line: preserve \n dari WA/template/copy-paste customer.
             Sebelumnya HTML collapse newline → pesan multiline tampil segaris lurus
             (lapor Kanaka 13:50, screenshot template pricelist). -->
        <div v-if="!msg.content && !msg.mediaType" class="text-sm text-gray-400 italic">[No content]</div>
        <div class="text-xs text-gray-400 mt-1 flex items-center gap-1">
          {{ formatTime(msg.timestamp) }}
          <span v-if="msg.direction === 'out'">
            <span v-if="msg.status === 'read'">✓✓</span>
            <span v-else-if="msg.status === 'delivered'">✓✓</span>
            <span v-else>✓</span>
          </span>
        </div>
      </div>
    </div>

    <!-- Scroll-to-bottom floating button (mobile §3.4 + desktop juga berguna) -->
    <Transition name="fade">
      <button
        v-if="showScrollButton"
        @click="scrollToBottom"
        class="absolute right-4 z-20 w-10 h-10 rounded-full bg-white shadow-lg border border-gray-200 text-gray-600 flex items-center justify-center hover:bg-gray-50 active:bg-gray-100"
        :style="{ bottom: (composerHeight + 12) + 'px' }"
        title="Scroll to bottom"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
        </svg>
      </button>
    </Transition>

    <!-- Typing indicator -->
    <div v-if="typingUser" class="px-4 py-1 text-xs text-gray-500 italic flex-shrink-0 bg-white border-t border-gray-100">
      CS @{{ typingUser }} is replying...
    </div>

    <!-- Resolved notice above reply box -->
    <div v-if="chat.status === 'resolved'" class="px-4 py-1 text-xs text-green-600 italic flex-shrink-0 bg-white border-t border-gray-100">
      Chat resolved — sending a message will reopen this conversation.
    </div>

    <!-- Reply box — disabled if chat is taken by another agent -->
    <div v-if="isChatLockedByOther" class="bg-gray-100 border-t border-gray-200 p-4 flex items-center justify-center flex-shrink-0">
      <span class="text-sm text-gray-500">🔒 This chat is assigned to @{{ chat.assignedTo?.username }}. Release it first to reply.</span>
    </div>
    <div v-else-if="!chat.assignedToId" class="bg-amber-50 border-t border-amber-200 p-4 flex items-center justify-center gap-3 flex-shrink-0 flex-wrap">
      <span class="text-sm text-amber-700">🔒 Chat belum di-Take. Ambil chat dulu sebelum membalas.</span>
      <button v-if="auth.isAdmin" @click="$emit('take')" class="text-xs px-3 py-1.5 rounded bg-wa-green text-white font-medium active:bg-green-600">Take chat ini</button>
    </div>
    <div
      v-else
      ref="composerBar"
      class="bg-[var(--md-sys-color-surface-container)] border-t border-[var(--md-sys-color-outline-variant)] p-3 flex items-end gap-2 flex-shrink-0 relative"
      style="padding-bottom: max(12px, env(safe-area-inset-bottom, 0px));"
    >
      <!-- Media upload input (desktop: tombol eksplisit; mobile: via menu +) -->
      <input
        ref="fileInputRef"
        type="file"
        accept="image/*,video/*,audio/*,.pdf"
        class="hidden"
        @change="$emit('upload-media', $event)"
      />
      <!-- v0.10.2 — MOBILE: tombol "+" M3 (4 aksi dalam 1 menu list vertikal, lapor Kanaka: text field sempit) -->
      <div v-if="isMobile" class="relative flex-shrink-0">
        <button
          @click.stop="attachMenuOpen = !attachMenuOpen"
          :disabled="sendingMedia"
          class="p-2 rounded-full text-gray-500 hover:text-wa-green hover:bg-gray-100 disabled:opacity-50"
          title="Aksi"
          style="min-width: 44px; min-height: 44px;"
        >
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
        </button>
        <div v-if="attachMenuOpen" @click.stop class="m3-menu absolute bottom-full left-0 mb-2 z-40 min-w-[210px] overflow-hidden">
          <button @click="fileInputRef?.click(); attachMenuOpen = false" :disabled="sendingMedia" class="w-full text-left px-3 py-2.5 text-sm text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-high)] flex items-center gap-3 disabled:opacity-50">
            <svg class="w-5 h-5 text-[var(--md-sys-color-on-surface-variant)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 1.172M15.172 7l-1.172 6.586M15.172 7H20a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9a2 2 0 012-2h5.172M15.172 7L9.586 8.172m0 0L4 14m5.586-5.828L15.172 7" /></svg>
            Kirim Media
          </button>
          <button @click="showTemplateDropdown = !showTemplateDropdown; attachMenuOpen = false" :disabled="sendingMedia" class="w-full text-left px-3 py-2.5 text-sm text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-high)] flex items-center gap-3 disabled:opacity-50">
            <svg class="w-5 h-5 text-[var(--md-sys-color-on-surface-variant)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
            Template
          </button>
          <button @click="$emit('tangan-kanan'); attachMenuOpen = false" class="w-full text-left px-3 py-2.5 text-sm text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-high)] flex items-center gap-3">
            <svg class="w-5 h-5 text-[var(--md-sys-color-on-surface-variant)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
            Tangan Kanan
          </button>
          <button @click="attachMenuOpen = false; $emit('schedule-message')" class="w-full text-left px-3 py-2.5 text-sm text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-high)] flex items-center gap-3">
            <svg class="w-5 h-5 text-[var(--md-sys-color-on-surface-variant)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            Pesan Terjadwal
          </button>
        </div>
      </div>
      <!-- v0.10.2 — DESKTOP: tombol media eksplisit (tetap, tidak diubah) -->
      <button
        v-else
        @click="fileInputRef?.click()"
        :disabled="sendingMedia"
        class="text-gray-500 hover:text-wa-green p-2 rounded-full hover:bg-gray-100 disabled:opacity-50 flex-shrink-0"
        title="Send media"
      >
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 1.172M15.172 7l-1.172 6.586M15.172 7H20a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V9a2 2 0 012-2h5.172M15.172 7L9.586 8.172m0 0L4 14m5.586-5.828L15.172 7" />
        </svg>
      </button>

      <!-- Template button — DESKTOP ONLY (mobile: via menu +) -->
      <div class="relative flex-shrink-0">
        <button
          v-if="!isMobile"
          @click.stop="showTemplateDropdown = !showTemplateDropdown"
          :disabled="sendingMedia"
          class="text-gray-500 hover:text-wa-green p-2 rounded-full hover:bg-gray-100 disabled:opacity-50"
          title="Insert template"
        >
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
        <!-- Template dropdown flyout -->
        <div v-if="showTemplateDropdown" @click.stop class="absolute bottom-full left-0 mb-2 bg-[var(--md-sys-color-surface-container)] border border-[var(--md-sys-color-outline-variant)] rounded-lg shadow-xl z-30 w-80 max-h-96 flex flex-col">
          <div class="p-2 border-b border-gray-100">
            <input
              v-model="templateSearch"
              type="text"
              placeholder="Search templates..."
              class="w-full px-2 py-1.5 text-sm border border-[var(--md-sys-color-outline)] rounded-lg text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:ring-1 focus:ring-wa-green focus:border-transparent"
            />
          </div>
          <div class="flex-1 overflow-y-auto">
            <div v-if="filteredTemplateGroups.length === 0" class="p-4 text-center text-gray-400 text-sm">No templates found</div>
            <div v-for="group in filteredTemplateGroups" :key="group.category" class="border-b border-gray-100 last:border-0">
              <div class="px-3 py-1.5 text-xs font-semibold text-[var(--md-sys-color-on-surface-variant)] uppercase bg-[var(--md-sys-color-surface-container-high)] sticky top-0">{{ group.category }}</div>
              <div
                v-for="tpl in group.items"
                :key="tpl.id"
                @click="$emit('insert-template', tpl.content); showTemplateDropdown = false; templateSearch = ''"
                class="px-3 py-2 text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-high)] cursor-pointer flex items-center gap-2"
              >
                <code class="text-xs bg-gray-100 px-1.5 py-0.5 rounded text-wa-dark flex-shrink-0">{{ tpl.keyword }}</code>
                <span class="text-sm truncate">{{ tpl.name }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Tangan Kanan button — DESKTOP ONLY (mobile: via menu +); v0.9.2 ikon folder -->
      <button
        v-if="!isMobile"
        @click="$emit('tangan-kanan')"
        class="text-gray-500 hover:text-wa-green p-2 rounded-full hover:bg-gray-100 flex-shrink-0"
        title="Tangan Kanan"
      >
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
      </button>

      <!-- v0.10.0 — Fitur D: tombol ⏰ jadwalkan pesan — DESKTOP ONLY (mobile: via menu +) -->
      <button
        v-if="!isMobile"
        @click="$emit('schedule-message')"
        class="text-gray-500 hover:text-wa-green p-2 rounded-full hover:bg-gray-100 flex-shrink-0"
        title="Jadwalkan pesan"
      >
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>

      <!-- Reply input with slash flyout -->
      <div class="flex-1 relative min-w-0">
        <div v-if="showTemplateFlyout" class="absolute bottom-full left-0 mb-1 bg-[var(--md-sys-color-surface-container)] border border-[var(--md-sys-color-outline-variant)] rounded-lg shadow-xl z-30 w-72">
          <div
            v-for="(tpl, idx) in templateMatches"
            :key="tpl.id"
            @click="$emit('insert-template-flyout', tpl)"
            :class="['px-3 py-2 cursor-pointer flex items-center gap-2 text-[var(--md-sys-color-on-surface)]', idx === selectedTemplateIndex ? 'bg-[var(--md-sys-color-surface-container-high)]' : 'hover:bg-[var(--md-sys-color-surface-container-high)]', idx === 0 ? 'rounded-t-lg' : '', idx === templateMatches.length - 1 ? 'rounded-b-lg' : '']"
          >
            <code class="text-xs bg-gray-100 px-1.5 py-0.5 rounded text-wa-dark flex-shrink-0">{{ tpl.keyword }}</code>
            <span class="text-sm truncate">{{ tpl.name }}</span>
          </div>
        </div>

        <input
          ref="replyInputRef"
          :value="replyText"
          @input="$emit('update:replyText', $event.target.value)"
          @keydown="$emit('reply-keydown', $event)"
          type="text"
          :placeholder="replyPlaceholder"
          :disabled="sendingMedia"
          class="w-full px-4 py-2.5 border border-[var(--md-sys-color-outline)] rounded-full text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] bg-transparent focus:ring-2 focus:ring-wa-green focus:border-transparent disabled:opacity-50"
        />
      </div>

      <button
        v-if="sendingMedia"
        disabled
        class="bg-gray-400 text-white rounded-full w-10 h-10 flex items-center justify-center flex-shrink-0"
      >
        <svg class="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 0v1m-6 2h6m-6 2h6m-6 2h6M6 8h.01M6 12h.01M6 16h.01" />
        </svg>
      </button>
      <button
        v-else
        @click="$emit('send')"
        :disabled="!replyText.trim() || sending"
        class="bg-wa-green text-white rounded-full w-10 h-10 flex items-center justify-center hover:bg-green-600 disabled:opacity-50 flex-shrink-0"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import KebabMenu from '../components/KebabMenu.vue'
import NotesPanel from '../components/NotesPanel.vue'
import ScheduledPanel from '../components/ScheduledPanel.vue'
import { getInitials, formatTime, formatPhone, tagColorClass, tagDotClass } from '../utils/format'
// v0.14.4 — participant action menu (save-contact + PM) via grup API client
import { groupsClient, friendlyGroupError } from '../utils/groupsApi'
import { useToastStore } from '../stores/toast'

const props = defineProps({
  chat: { type: Object, required: true },
  messages: { type: Array, required: true },
  loadingMessages: { type: Boolean, default: false },
  typingUser: { type: String, default: null },
  replyText: { type: String, default: '' },
  sending: { type: Boolean, default: false },
  sendingMedia: { type: Boolean, default: false },
  // Search
  showSearchBar: { type: Boolean, default: false },
  searchQuery: { type: String, default: '' },
  searchResults: { type: Array, default: () => [] },
  searchLoading: { type: Boolean, default: false },
  // Favorites
  showFavoritesPanel: { type: Boolean, default: false },
  chatFavorites: { type: Array, default: () => [] },
  favoritesLoading: { type: Boolean, default: false },
  favoritedMsgIds: { type: Object, required: true }, // Set
  highlightedMsgId: { type: String, default: null },
  // Tags
  allTags: { type: Array, default: () => [] },
  // Templates
  allTemplates: { type: Array, default: () => [] },
  showTemplateFlyout: { type: Boolean, default: false },
  templateMatches: { type: Array, default: () => [] },
  selectedTemplateIndex: { type: Number, default: 0 },
  // Transfer
  transferUsers: { type: Array, default: () => [] },
  // v0.10.0 — Fitur B (catatan) + D (terjadwal) — state di Dashboard, render di sini
  notes: { type: Array, default: () => [] },
  notesLoading: { type: Boolean, default: false },
  notesAdding: { type: Boolean, default: false },
  noteDraft: { type: String, default: '' },
  scheduled: { type: Array, default: () => [] },
  scheduledLoading: { type: Boolean, default: false },
  panelsOpen: { type: Boolean, default: true },
})

const emit = defineEmits([
  'send', 'upload-media', 'reply-keydown', 'insert-template', 'insert-template-flyout',
  'transfer', 'release', 'resolve', 'tangan-kanan', 'take',
  'snooze', 'cancel-snooze', // v0.10.0 — Fitur A
  'delete-chat', // v3.6/v3.7 — Hapus Chat (admin only, kebab menu; payload flag deleteContact v3.7)
  'schedule-message', 'cancel-scheduled', // v0.10.0 — Fitur D
  'add-note', 'delete-note', 'update:noteDraft', // v0.10.0 — Fitur B
  'toggle-favorites', 'toggle-favorite', 'jump-to',
  'toggle-search', 'close-search', 'update:searchQuery', 'update:replyText',
  'add-tag', 'remove-tag', 'create-tag', 'open-contact-edit',
])

const auth = useAuthStore()
const router = useRouter()
// v0.14.4 — toast + state popover peserta grup
const toast = useToastStore()
const senderMenu = ref({ msgId: null, mode: 'menu', loading: false, sending: false, pmText: '' })
const pmInputRef = ref(null)

const messagesContainer = ref(null)
const replyInputRef = ref(null)
const fileInputRef = ref(null)
const searchInputRef = ref(null)
const composerBar = ref(null)
const showTagMenu = ref(false)
const showTemplateDropdown = ref(false)
// v0.10.2 — menu "+" mobile (Kirim Media/Template/Tangan Kanan/Terjadwal dalam 1 menu M3)
const attachMenuOpen = ref(false)
const templateSearch = ref('')
const newTagName = ref('')
const newTagColor = ref('blue')
const isMobile = ref(typeof window !== 'undefined' ? window.innerWidth < 768 : false)
const showScrollButton = ref(false)
const composerHeight = ref(72)
const keyboardOffset = ref(0)

const tagColors = [
  { value: 'blue' }, { value: 'green' }, { value: 'red' },
  { value: 'yellow' }, { value: 'purple' }, { value: 'gray' },
]

// v0.14.0 — Manajemen Grup (additive): grup memakai ChatDetail ini via halaman Grup.
// Semua fallback = perilaku 1:1 existing (chat @g.us punya contactPhone = digits).
const isGroupChat = computed(() => {
  const jid = props.chat?.phoneJid || props.chat?.id || ''
  return String(jid).endsWith('@g.us')
})
const groupChat = isGroupChat
const groupSubtitle = computed(() => {
  const n = props.chat?.participantCount
  return n ? `👥 ${n} member` : '👥 Grup WhatsApp'
})
/** Nama tampilan pengirim di grup: Contact name > digits HP > null (1:1 → null). */
function messageSenderLabel(msg) {
  if (!groupChat.value || msg?.direction !== 'in') return null
  const pj = msg?.participantJid
  if (!pj) return null
  const digits = String(pj).split('@')[0]
  if (!digits) return null
  const contact = props.chat?.participants?.find(p => p.phone === digits)
  // v0.14.0b — nama tampilan: Contact > pushName (nama profil WA, tersimpan per pesan) > LID
  if (contact?.name) return contact.name
  if (msg.senderName && msg.senderName !== 'Unknown' && msg.senderName !== 'me') return msg.senderName
  return `+${digits}`
}

const canTransfer = computed(() => !!props.chat.assignedTo && (props.chat.assignedToId === auth.user.id || auth.isAdmin))
const canEditTags = computed(() => props.chat.assignedToId === auth.user.id || auth.isAdmin)

const currentChatTags = computed(() => props.chat.tags || [])
const availableTags = computed(() => {
  const appliedIds = currentChatTags.value.map(ct => ct.tag.id)
  return props.allTags.filter(t => !appliedIds.includes(t.id))
})

const replyPlaceholder = computed(() => {
  if (props.sendingMedia) return 'Sending media...'
  if (props.chat?.status === 'resolved') return 'Type a message (will reopen chat)...'
  return 'Type a message...'
})

const isChatLockedByOther = computed(() => {
  if (!props.chat.assignedToId) return false
  if (props.chat.assignedToId === auth.user.id) return false
  if (auth.isAdmin) return false
  return true
})

// ─── v0.10.0 — Fitur A/C computed ─────────────────────
const isSnoozed = computed(() => {
  const until = props.chat?.snoozedUntil
  return !!until && new Date(until).getTime() > Date.now()
})
const snoozeUntilLabel = computed(() => {
  if (!props.chat?.snoozedUntil) return ''
  return new Date(props.chat.snoozedUntil).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
})
const lastCsatRating = computed(() => props.chat?.lastCsatRating ?? null)
// Catatan: tulis = CS assigned + admin (sama dgn reply permission)
const canManageNotes = computed(() => {
  if (auth.isAdmin) return true
  return !!props.chat.assignedToId && props.chat.assignedToId === auth.user.id
})
// v0.10.1 — Panel TIDAK lagi tergantung "ada isinya" (bug lapor Kanaka: note pertama gak bisa
// ditulis krn panel hilang saat kosong). Sekarang: desktop default terbuka; mobile = user toggle
// manual via tombol di header. v0.12.11 — bugfix desktop: tombol 📝 Notes dulu men-toggle
// state mobile (vpanelsMobileOpen) sementara desktop membaca props.panelsOpen yang tidak
// pernah dipass parent (default true) → klik tidak berefek apa-apa. Sekarang desktop punya
// state sendiri (diinit dari prop, preferensi dipertahankan antar chat); mobile tetap reset per chat.
const isMobileViewport = ref(window.innerWidth < 768)
const vpanelsDesktopOpen = ref(props.panelsOpen)
const vpanelsMobileOpen = ref(false)
const vpanelsOpen = computed(() => {
  if (isMobileViewport.value) return vpanelsMobileOpen.value
  return vpanelsDesktopOpen.value
})

// Auto-buka panel di mobile kalau masuk chat dengan isi (UX: konteks langsung terlihat)
watch(() => props.chat?.id, () => { vpanelsMobileOpen.value = false })
watch(() => [props.notes.length, props.scheduled.length], () => {
  if (isMobileViewport.value && vpanelsMobileOpen.value) return
  // desktop: tidak perlu auto-toggle
})

const filteredTemplateGroups = computed(() => {
  let list = props.allTemplates
  if (templateSearch.value.trim()) {
    const q = templateSearch.value.toLowerCase()
    list = list.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.keyword.toLowerCase().includes(q) ||
      t.category.toLowerCase().includes(q)
    )
  }
  const groups = {}
  for (const tpl of list) {
    const cat = tpl.category || 'umum'
    if (!groups[cat]) groups[cat] = { category: cat, items: [] }
    groups[cat].items.push(tpl)
  }
  return Object.values(groups).sort((a, b) => a.category.localeCompare(b.category))
})

function emitCreateTag() {
  if (!newTagName.value.trim()) return
  emit('create-tag', { name: newTagName.value.trim(), color: newTagColor.value })
  newTagName.value = ''
  newTagColor.value = 'blue'
}

// v0.2.0 §3.1 — back: router.back(), fallback '/' kalau history kosong
function goBack() {
  if (window.history.state?.back) {
    router.back()
  } else {
    router.push('/')
  }
}

// ═══ v3.6/v3.7 — Hapus Chat permanen (kebab menu, admin only) ═══
// KebabMenu emit 'delete-chat' (payload flag deleteContact, v3.7) → parent
// Dashboard yang punya handler utama (konfirmasi + API + clear selection) —
// pola sama dgn resolve/transfer. Handler API tetap satu sumber di Dashboard
// (socket logic tetap di sana).

function openContactEdit() {
  emit('open-contact-edit')
}

// ═══════════════════════════════════════════════════════
// v0.14.4 — Participant Action Menu (bubble grup → label pengirim)
// HANYA grup + bubble 'in' + participantJid ada; 1:1 tidak pernah render menu.
// ═══════════════════════════════════════════════════════
function openSenderMenu(msg) {
  senderMenu.value = { msgId: msg.id, mode: 'menu', loading: false, sending: false, pmText: '' }
}

function closeSenderMenu() {
  senderMenu.value = { msgId: null, mode: 'menu', loading: false, sending: false, pmText: '' }
}

function onPmKeydown(e) {
  // Enter kirim; Shift+Enter = baris baru (pola onGroupReplyKeydown Groups.vue)
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    const msg = (props.messages || []).find(m => m.id === senderMenu.value.msgId)
    if (msg) sendPrivateMessage(msg)
  } else if (e.key === 'Escape') {
    e.stopPropagation()
    closeSenderMenu()
  }
}

/** 💾 Simpan ke Kontak — endpoint A; toast sukses/error ramah. */
async function saveToContact(msg) {
  if (!msg?.participantJid || senderMenu.value.loading) return
  senderMenu.value.loading = true
  try {
    const api = groupsClient(auth.token)
    const res = await api.post(`/api/groups/${encodeURIComponent(props.chat.id)}/participants/${encodeURIComponent(msg.participantJid)}/save-contact`)
    const { created, contact } = res.data || {}
    const displayName = contact?.name || (contact?.phone ? `+${contact.phone}` : messageSenderLabel(msg))
    if (created) {
      toast.show({ icon: '✅', title: 'Kontak disimpan', message: displayName })
    } else {
      toast.show({ icon: '✅', title: 'Kontak sudah ada', message: displayName })
    }
    closeSenderMenu()
  } catch (e) {
    // 422 (nomor asli belum tersedia) dll → pesan ramah via friendlyGroupError
    console.error('Save contact error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal menyimpan kontak', message: friendlyGroupError(e, 'Gagal menyimpan kontak.') })
  } finally {
    senderMenu.value.loading = false
  }
}

/** ✉️ Pesan Pribadi — endpoint B; sukses → buka chat 1:1 di Dashboard (/?chat=). */
async function sendPrivateMessage(msg) {
  if (!msg?.participantJid || senderMenu.value.sending) return
  const content = senderMenu.value.pmText.trim()
  if (!content) return
  senderMenu.value.sending = true
  try {
    const api = groupsClient(auth.token)
    const res = await api.post(
      `/api/groups/${encodeURIComponent(props.chat.id)}/participants/${encodeURIComponent(msg.participantJid)}/pm`,
      { content },
    )
    toast.show({ icon: '✉️', title: 'Pesan pribadi terkirim' })
    closeSenderMenu()
    // pola openGroup mobile (Groups.vue): buka chat 1:1 di Dashboard via query
    router.push({ path: '/', query: { chat: res.data?.chatId || msg.participantJid } })
  } catch (e) {
    console.error('PM participant error:', e)
    toast.show({ icon: '⚠️', title: 'Gagal mengirim pesan pribadi', message: friendlyGroupError(e, 'Gagal mengirim pesan pribadi.') })
  } finally {
    senderMenu.value.sending = false
  }
}

/** Escape global utk popover (dipasang saat mounted, dilepas saat unmount). */
function onSenderMenuKeydown(e) {
  if (e.key === 'Escape' && senderMenu.value.msgId) closeSenderMenu()
}

// ── Scroll management ────────────────────────────────
function scrollToBottom() {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

function onScroll() {
  if (!messagesContainer.value) return
  const el = messagesContainer.value
  showScrollButton.value = el.scrollHeight - el.scrollTop - el.clientHeight > 200
}

// ── Keyboard-safe composer (spec §3.2) ───────────────
// visualViewport pattern (WhatsApp Web mobile) — composer fixed terhadap
// viewport visual, bukan layout viewport. Header tetap top (tidak ikut naik).
const rootEl = ref(null)
function onVisualViewportResize() {
  if (!window.visualViewport) return
  const vv = window.visualViewport
  keyboardOffset.value = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
  const root = rootEl.value
  if (root) {
    root.style.transform = keyboardOffset.value > 0 ? `translateY(${-keyboardOffset.value}px)` : ''
  }
}

function onWindowResize() {
  isMobile.value = window.innerWidth < 768
  measureComposer()
}

function measureComposer() {
  nextTick(() => {
    if (composerBar.value) {
      composerHeight.value = composerBar.value.offsetHeight || 72
    }
  })
}

watch(() => props.chat?.id, () => {
  showTagMenu.value = false
  showTemplateDropdown.value = false
  showScrollButton.value = false
  // v0.14.4 — popover peserta ditutup saat pindah chat
  closeSenderMenu()
  measureComposer()
})

// New message → auto scroll (kalau sudah near bottom)
watch(() => props.messages.length, () => {
  if (!showScrollButton.value) scrollToBottom()
})

// Watch showSearchBar → focus input (sama seperti v0.1.x toggleSearchBar)
watch(() => props.showSearchBar, (val) => {
  if (val) nextTick(() => searchInputRef.value?.focus())
})

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onVisualViewportResize)
  }
  messagesContainer.value?.addEventListener('scroll', onScroll, { passive: true })
  // v0.10.3 — tutup flyout/menu floating saat tap di luar (lapor Kanaka: template flyout
  // gak bisa ditutup kecuali pilih template; attach menu + kebab sama)
  document.addEventListener('click', onDocClickDismiss)
  // v0.14.4 — Escape menutup popover peserta grup
  document.addEventListener('keydown', onSenderMenuKeydown)
  measureComposer()
})
onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize)
  if (window.visualViewport) {
    window.visualViewport.removeEventListener('resize', onVisualViewportResize)
  }
  document.removeEventListener('click', onDocClickDismiss)
  document.removeEventListener('keydown', onSenderMenuKeydown)
  messagesContainer.value?.removeEventListener('scroll', onScroll)
})

// v0.10.3 — klik di luar (bukan di dalam menu/flyout/kontrollernya) → tutup semuanya
// (m3-menu punya @click.stop jadi event dari dalam menu gak sampe sini)
function onDocClickDismiss() {
  attachMenuOpen.value = false
  showTemplateDropdown.value = false
}

// Expose untuk parent (Dashboard) — scrollToBottom setelah aksi kirim/jump
defineExpose({
  scrollToBottom,
  replyInputRef,
  messagesContainer,
  focusReply: () => replyInputRef.value?.focus(),
})
</script>