<template>
  <div :class="embedded ? 'p-4 md:p-6 w-full min-w-0' : 'min-h-screen bg-gray-100'">
    <!-- Top bar (hidden ketika embedded di Blast tab page) -->
    <header v-if="!embedded" class="m3-topbar px-4 py-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <router-link to="/" class="text-sm hover:underline">← Dashboard</router-link>
        <h1 class="text-lg font-semibold">Blast Composer</h1>
      </div>
      <div class="flex items-center gap-4">
        <router-link to="/blast/history" class="text-sm hover:underline">History</router-link>
        <router-link to="/settings" class="text-sm hover:underline">{{ auth.user?.username }}</router-link>
        <button @click="handleLogout" class="text-sm hover:underline">Logout</button>
      </div>
    </header>

    <div :class="embedded ? '' : 'max-w-4xl mx-auto p-6'">
      <!-- Step indicator (v0.2.4 — mobile: lingkaran saja; label teks memaksa min-content ~440px → seluruh kartu melebihi layar) -->
      <div class="flex items-center justify-between mb-6 md:mb-8">
        <div v-for="(s, idx) in steps" :key="idx" class="flex items-center min-w-0" :class="{ 'flex-1': idx < steps.length - 1 }">
          <div :class="['w-7 h-7 md:w-8 md:h-8 rounded-full flex items-center justify-center text-sm font-medium flex-shrink-0', step >= idx ? 'bg-wa-green text-white' : 'bg-gray-300 text-gray-500']">
            {{ idx + 1 }}
          </div>
          <span class="ml-2 text-sm hidden md:inline" :class="step >= idx ? 'text-gray-900 font-medium' : 'text-gray-400'">{{ s }}</span>
          <div v-if="idx < steps.length - 1" class="flex-1 h-0.5 mx-2 md:mx-3 min-w-2" :class="step > idx ? 'bg-wa-green' : 'bg-gray-300'"></div>
        </div>
      </div>

      <!-- Step 1: Select Recipients -->
      <div v-if="step === 0" class="bg-white rounded-lg shadow-sm p-6">
        <h2 class="text-lg font-semibold mb-4">Select Recipients</h2>
        
        <!-- Tabs -->
        <div class="flex gap-1 mb-4 bg-gray-50 rounded-lg p-1">
          <button @click="recipientTab = 'chats'" :class="['flex-1 px-2 py-2 rounded-md text-sm font-medium', recipientTab === 'chats' ? 'bg-wa-green text-white' : 'text-gray-600 hover:text-gray-900']">Chat List</button>
          <button @click="openContactsTab" :class="['flex-1 px-4 py-2 rounded-md text-sm font-medium', recipientTab === 'contacts' ? 'bg-wa-green text-white' : 'text-gray-600 hover:text-gray-900']">Kontak</button>
          <button @click="recipientTab = 'tags'" :class="['flex-1 px-2 py-2 rounded-md text-sm font-medium', recipientTab === 'tags' ? 'bg-wa-green text-white' : 'text-gray-600 hover:text-gray-900']">Tags</button>
          <button @click="recipientTab = 'csv'" :class="['flex-1 px-2 py-2 rounded-md text-sm font-medium', recipientTab === 'csv' ? 'bg-wa-green text-white' : 'text-gray-600 hover:text-gray-900']">CSV</button>
        </div>

        <!-- From Contacts (v0.2.3 — kontak tersimpan, request Kanaka 2026-09-01 21:02) -->
        <div v-if="recipientTab === 'contacts'">
          <div class="flex gap-2 mb-3">
            <input v-model="contactSearch" @input="onContactSearchInput" type="text" placeholder="Cari kontak tersimpan..." class="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-300 rounded-lg" />
          </div>

          <div class="flex items-center justify-between mb-2">
            <button @click="selectAllContacts" class="text-sm text-wa-green hover:underline">{{ contactsPageAllSelected ? 'Batalkan Semua (halaman ini)' : 'Pilih Semua (halaman ini)' }}</button>
            <span class="text-sm text-gray-500">{{ availableContacts.length }} / {{ contactTotal }} kontak</span>
          </div>

          <div class="border border-gray-200 rounded-lg max-h-80 overflow-y-auto">
            <div v-if="loadingContacts" class="p-4 text-center text-gray-400 text-sm">Loading...</div>
            <div v-else-if="availableContacts.length === 0" class="p-4 text-center text-gray-400 text-sm">Belum ada kontak tersimpan</div>
            <label v-for="ct in availableContacts" :key="'ct-' + ct.id" class="flex items-center px-3 py-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100">
              <input type="checkbox" :checked="isContactSelected(ct)" @change="toggleContact(ct)" class="mr-3" />
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium truncate">{{ ct.name || ct.phone || '-' }}</div>
                <div class="text-xs text-gray-400 truncate">{{ ct.phone || 'nomor tidak diketahui' }}<span v-if="ct.chatId" class="text-wa-green"> · punya chat</span></div>
              </div>
            </label>
            <div v-if="availableContacts.length < contactTotal" class="p-2 text-center">
              <button @click="loadMoreContacts" class="text-sm text-wa-green hover:underline">Muat lagi ({{ contactTotal - availableContacts.length }} lagi)</button>
            </div>
          </div>
          <p class="text-xs text-gray-400 mt-2">Kontak tanpa chat terdaftar dikirim sebagai nomor baru (warm/cold) — sama seperti jalur CSV.</p>
        </div>

        <!-- From Chat List -->
        <div v-if="recipientTab === 'chats'">
          <!-- Filter -->
          <div class="flex gap-2 mb-3">
            <input v-model="chatSearch" @input="fetchChatsForPicker" type="text" placeholder="Search chats..." class="flex-1 min-w-0 px-3 py-2 text-sm border border-gray-300 rounded-lg" />
            <select v-model="chatFilter" @change="fetchChatsForPicker" class="flex-shrink-0 px-2 py-2 text-sm border border-gray-300 rounded-lg">
              <option value="all">All</option>
              <option value="mine">Mine</option>
              <option value="unassigned">Unassigned</option>
              <option value="resolved">Resolved</option>
            </select>
          </div>

          <div class="flex items-center justify-between mb-2">
            <button @click="selectAllChats" class="text-sm text-wa-green hover:underline">{{ selectedChatIds.size === availableChats.length && availableChats.length > 0 ? 'Deselect All' : 'Select All' }}</button>
            <span class="text-sm text-gray-500">{{ availableChats.length }} chats</span>
          </div>

          <div class="border border-gray-200 rounded-lg max-h-80 overflow-y-auto">
            <div v-if="loadingChats" class="p-4 text-center text-gray-400 text-sm">Loading...</div>
            <div v-else-if="availableChats.length === 0" class="p-4 text-center text-gray-400 text-sm">No chats found</div>
            <label v-for="chat in availableChats" :key="chat.id" class="flex items-center px-3 py-2 hover:bg-gray-50 cursor-pointer border-b border-gray-100">
              <input type="checkbox" :checked="selectedChatIds.has(chat.id)" @change="toggleChat(chat.id)" class="mr-3" />
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium truncate">{{ chat.contactName || chat.contactPhone || chat.id }}</div>
                <div class="text-xs text-gray-400 truncate">{{ chat.contactPhone || chat.id }}</div>
              </div>
            </label>
          </div>
        </div>

        <!-- From Tags -->
        <div v-if="recipientTab === 'tags'">
          <div v-if="allTags.length === 0" class="text-gray-400 text-sm">No tags available. Create tags first from the chat list.</div>
          <div v-else class="space-y-2">
            <div class="flex flex-wrap gap-2">
              <button
                v-for="tag in allTags"
                :key="tag.id"
                @click="toggleTag(tag.id)"
                :class="['px-3 py-1.5 rounded-full text-sm font-medium border', selectedTagIds.has(tag.id) ? 'bg-wa-green text-white border-wa-green' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400']"
              >
                {{ tag.name }} ({{ tag._count?.chats || 0 }})
              </button>
            </div>
          </div>

          <div v-if="selectedTagIds.size > 0" class="mt-4">
            <button @click="fetchChatsByTags" class="bg-wa-green text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-600">Fetch Recipients</button>
          </div>
        </div>

        <!-- Upload CSV -->
        <div v-if="recipientTab === 'csv'">
          <!-- Drag & Drop Zone -->
          <div
            @dragover.prevent="csvDragOver = true"
            @dragleave.prevent="csvDragOver = false"
            @drop.prevent="handleCsvDrop"
            :class="['border-2 border-dashed rounded-lg p-8 text-center transition-colors', csvDragOver ? 'border-wa-green bg-green-50' : 'border-gray-300 hover:border-gray-400']"
          >
            <svg class="w-12 h-12 mx-auto text-gray-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
            </svg>
            <p class="text-sm text-gray-600 mb-2">Drag & drop CSV file here or</p>
            <label class="bg-wa-green text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-600 cursor-pointer inline-block">
              Browse Files
              <input type="file" accept=".csv" @change="handleCsvFileSelect" class="hidden" />
            </label>
            <p class="text-xs text-gray-400 mt-2">Format: name,phone or phone only. Max 5000 rows.</p>
          </div>

          <!-- CSV Upload Status -->
          <div v-if="csvUploading" class="mt-4 text-center text-sm text-gray-500">
            <svg class="animate-spin inline w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
            Parsing CSV...
          </div>

          <!-- CSV Error -->
          <div v-if="csvError" class="mt-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">
            {{ csvError }}
          </div>

          <!-- CSV Preview Table -->
          <div v-if="csvNumbers.length > 0" class="mt-4">
            <div class="flex items-center justify-between mb-2">
              <h3 class="text-sm font-semibold">CSV Preview — {{ csvValidCount }} valid, {{ csvInvalidCount }} invalid, {{ csvDuplicates }} duplicates</h3>
              <div class="flex gap-2">
                <button v-if="csvInvalidCount > 0" @click="removeInvalidCsvRows" class="text-sm text-red-500 hover:underline">Remove all invalid</button>
                <button @click="clearCsv" class="text-sm text-gray-500 hover:underline">Clear CSV</button>
              </div>
            </div>
            <div class="border border-gray-200 rounded-lg max-h-64 overflow-y-auto">
              <table class="w-full">
                <thead class="bg-gray-50 sticky top-0">
                  <tr>
                    <th class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                    <th class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Phone</th>
                    <th class="hidden md:table-cell px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Normalized</th>
                    <th class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                    <th class="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-200">
                  <tr v-for="(row, idx) in csvNumbers" :key="idx" :class="row.valid ? '' : 'bg-red-50'">
                    <td class="px-3 py-2 text-sm">{{ row.name || '-' }}</td>
                    <td class="px-3 py-2 text-sm text-gray-600">{{ row.phone }}</td>
                    <td class="hidden md:table-cell px-3 py-2 text-sm text-gray-600">{{ row.normalized || '-' }}</td>
                    <td class="px-3 py-2">
                      <span v-if="row.valid" class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Valid</span>
                      <span v-else class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">{{ row.reason || 'Invalid' }}</span>
                    </td>
                    <td class="px-3 py-2">
                      <button @click="removeCsvRow(idx)" class="text-xs text-red-400 hover:text-red-600">✕</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- Cold Number Warning (for CSV) -->
            <div v-if="coldNumbers.length > 0" class="mt-3 bg-yellow-50 border border-yellow-300 rounded-lg p-3 text-sm text-yellow-800">
              ⚠️ {{ coldNumbers.length }} numbers have never chatted with this WhatsApp. Cold outreach may risk ban.
            </div>
          </div>
        </div>

        <!-- Selected Recipients Summary -->
        <div v-if="totalUniqueRecipients > 0" class="mt-4 border-t pt-4">
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-semibold">{{ totalUniqueRecipients }} Unique Recipients <span class="text-gray-400 font-normal">(chat: {{ selectedChatIds.size }}, kontak: {{ selectedContactMap.size }}, tags: {{ tagRecipientCount }}, CSV: {{ csvValidCount }})</span></h3>
            <button @click="clearAllRecipients" class="text-sm text-red-500 hover:underline">Clear All</button>
          </div>
          <div class="border border-gray-200 rounded-lg max-h-48 overflow-y-auto">
            <div v-for="r in combinedRecipientsPreview.slice(0, 50)" :key="r.id || r.phone" class="px-3 py-2 text-sm border-b border-gray-100 flex justify-between">
              <span class="font-medium">{{ r.name || r.phone }}</span>
              <span class="text-gray-400">{{ r.phone || r.id }}</span>
            </div>
            <div v-if="totalUniqueRecipients > 50" class="px-3 py-2 text-xs text-gray-400 text-center">...and {{ totalUniqueRecipients - 50 }} more</div>
          </div>
        </div>

        <div class="flex justify-end mt-6">
          <button @click="goToStep(1)" :disabled="totalUniqueRecipients === 0" class="bg-wa-green text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed">Next →</button>
        </div>
      </div>

      <!-- Step 2: Compose Message -->
      <div v-if="step === 1" class="bg-white rounded-lg shadow-sm p-6">
        <h2 class="text-lg font-semibold mb-4">Compose Message</h2>
        
        <!-- Formatting Toolbar -->
        <div class="flex items-center gap-1 mb-2 pb-2 border-b border-gray-200">
          <!-- Bold -->
          <button @click="wrapSelection('*', '*')" class="toolbar-btn" title="Bold">
            <span class="font-bold">B</span>
          </button>
          <!-- Italic -->
          <button @click="wrapSelection('_', '_')" class="toolbar-btn" title="Italic">
            <span class="italic">I</span>
          </button>
          <!-- Strikethrough -->
          <button @click="wrapSelection('~', '~')" class="toolbar-btn" title="Strikethrough">
            <span class="line-through">S</span>
          </button>
          
          <div class="w-px h-5 bg-gray-300 mx-1"></div>
          
          <!-- Bullet list -->
          <button @click="insertLinePrefix('- ')" class="toolbar-btn" title="Bullet list">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
          </button>
          <!-- Numbered list -->
          <button @click="insertLinePrefix('1. ')" class="toolbar-btn" title="Numbered list">
            <span class="text-sm font-medium">1.</span>
          </button>
          
          <div class="w-px h-5 bg-gray-300 mx-1"></div>
          
          <!-- Insert Name -->
          <button @click="insertName" class="toolbar-btn" title="Insert Name">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
            <span class="text-sm">Name</span>
          </button>
          
          <div class="w-px h-5 bg-gray-300 mx-1"></div>
          
          <!-- Attach image (Phase 2 — now enabled) -->
          <button @click="attachImage" :disabled="uploadingImage" class="toolbar-btn" title="Attach Image">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
            <span v-if="uploadingImage" class="text-sm animate-pulse">Uploading...</span>
          </button>
        </div>
        
        <!-- Image Preview (if attached) -->
        <div v-if="attachedImagePath" class="mb-3 relative inline-block">
          <img :src="attachedImagePreviewUrl" class="max-h-32 rounded-lg border border-gray-200" alt="Attached" />
          <button @click="removeImage" class="absolute top-1 right-1 bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs hover:bg-red-700">✕</button>
          <div class="text-xs text-gray-500 mt-1">Image attached — your text will be sent as caption</div>
        </div>
        
        <textarea ref="messageTextareaRef" v-model="message" rows="6" :placeholder="attachedImagePath ? 'Type caption here... Use Insert Name to personalize' : 'Type your message here... Use the Insert Name button to personalize'" class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-1 focus:ring-wa-green"></textarea>
        
        <!-- Preview -->
        <div v-if="message && combinedRecipientsPreview.length > 0" class="mt-4">
          <h3 class="text-sm font-semibold mb-2">Preview</h3>
          <div class="space-y-2">
            <div v-for="(r, idx) in previewRecipients" :key="idx" class="bg-gray-50 rounded-lg p-3 text-sm">
              <div class="text-xs text-gray-400 mb-1">To: {{ r.name || r.phone || 'Pelanggan' }}</div>
              <div v-if="attachedImagePath" class="mb-2">
                <img :src="attachedImagePreviewUrl" class="max-h-24 rounded" alt="Preview" />
              </div>
              <div class="whitespace-pre-wrap">{{ previewMessage(r) }}</div>
            </div>
          </div>
        </div>
        
        <div class="flex justify-between mt-6">
          <button @click="goToStep(0)" class="text-gray-600 px-6 py-2 rounded-lg text-sm font-medium hover:bg-gray-100">← Back</button>
          <button @click="goToStep(2)" :disabled="!message.trim()" class="bg-wa-green text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed">Next →</button>
        </div>
      </div>

      <!-- Step 3: Rate Limiting -->
      <div v-if="step === 2" class="bg-white rounded-lg shadow-sm p-6">
        <h2 class="text-lg font-semibold mb-4">Rate Limiting</h2>
        
        <div class="flex gap-2 mb-4">
          <button v-for="p in presets" :key="p.name" @click="applyPreset(p)" :class="['px-4 py-2 rounded-lg text-sm font-medium border', currentPresetName === p.name ? 'bg-wa-green text-white border-wa-green' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400']">{{ p.name }}</button>
        </div>

        <div class="grid grid-cols-3 gap-4">
          <div>
            <label class="text-sm font-medium text-gray-700 mb-1 block">Delay per Msg (seconds)</label>
            <input v-model.number="rateConfig.delayPerMsg" type="number" min="1" @input="currentPresetName = 'Custom'" class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
          </div>
          <div>
            <label class="text-sm font-medium text-gray-700 mb-1 block">Group Size</label>
            <input v-model.number="rateConfig.groupSize" type="number" min="1" @input="currentPresetName = 'Custom'" class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
          </div>
          <div>
            <label class="text-sm font-medium text-gray-700 mb-1 block">Delay per Group (seconds)</label>
            <input v-model.number="rateConfig.delayPerGroup" type="number" min="1" @input="currentPresetName = 'Custom'" class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg" />
          </div>
        </div>

        <!-- Estimated time -->
        <div class="mt-4 bg-blue-50 rounded-lg p-3 text-sm">
          <span class="font-medium">Estimated time:</span> ±{{ estimatedMinutes }} minutes
          <span class="text-gray-500 ml-2">({{ totalGroups }} groups × {{ rateConfig.delayPerGroup }}s + {{ totalUniqueRecipients }} msgs × {{ rateConfig.delayPerMsg }}s)</span>
        </div>

        <div class="flex justify-between mt-6">
          <button @click="goToStep(1)" class="text-gray-600 px-6 py-2 rounded-lg text-sm font-medium hover:bg-gray-100">← Back</button>
          <button @click="goToStep(3)" class="bg-wa-green text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-green-600">Next →</button>
        </div>
      </div>

      <!-- Step 4: Review + Send -->
      <div v-if="step === 3" class="bg-white rounded-lg shadow-sm p-6">
        <h2 class="text-lg font-semibold mb-4">Review & Send</h2>

        <div class="space-y-4">
          <div>
            <h3 class="text-sm font-semibold text-gray-700">Recipients</h3>
            <p class="text-sm text-gray-600">{{ totalUniqueRecipients }} unique recipients</p>
          </div>

          <!-- Cold Number Warning -->
          <div v-if="coldNumbers.length > 0" class="bg-yellow-50 border border-yellow-300 rounded-lg p-4">
            <p class="text-sm text-yellow-800 font-medium mb-2">⚠️ {{ coldNumbers.length }} of {{ totalUniqueRecipients }} recipients have never chatted with this WhatsApp. Cold outreach carries ban risk.</p>
            <label class="flex items-center gap-2 text-sm text-yellow-800">
              <input type="checkbox" v-model="acknowledgeColdRisk" class="mr-2" />
              I understand the risk — proceed anyway
            </label>
          </div>

          <div>
            <h3 class="text-sm font-semibold text-gray-700">Message</h3>
            <div v-if="attachedImagePath" class="mb-2">
              <img :src="attachedImagePreviewUrl" class="max-h-32 rounded-lg border border-gray-200" alt="Attached" />
              <div class="text-xs text-gray-500 mt-1">Image with caption</div>
            </div>
            <div class="bg-gray-50 rounded-lg p-3 text-sm whitespace-pre-wrap mt-1">{{ message }}</div>
          </div>

          <div>
            <h3 class="text-sm font-semibold text-gray-700">Rate Limiting</h3>
            <p class="text-sm text-gray-600">
              {{ rateConfig.delayPerMsg }}s per msg · {{ rateConfig.groupSize }} per group · {{ rateConfig.delayPerGroup }}s per group
            </p>
            <p class="text-sm text-gray-600">Estimated time: ±{{ estimatedMinutes }} minutes</p>
          </div>
        </div>

        <!-- Confirmation -->
        <div v-if="showConfirm" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div class="bg-white rounded-lg p-6 max-w-md">
            <h3 class="text-lg font-semibold mb-2">Confirm Blast</h3>
            <p class="text-sm text-gray-600 mb-4">You are about to send a blast to <strong>{{ totalUniqueRecipients }} recipients</strong>{{ attachedImagePath ? ' with an image attachment' : '' }}. This cannot be undone.</p>
            <div class="flex gap-3 justify-end">
              <button @click="showConfirm = false" class="text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-100">Cancel</button>
              <button @click="startBlast" :disabled="sending" class="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50">{{ sending ? 'Starting...' : 'Start Blast' }}</button>
            </div>
          </div>
        </div>

        <div class="flex justify-between mt-6">
          <button @click="goToStep(2)" class="text-gray-600 px-6 py-2 rounded-lg text-sm font-medium hover:bg-gray-100">← Back</button>
          <button @click="showConfirm = true" :disabled="coldNumbers.length > 0 && !acknowledgeColdRisk" class="bg-red-600 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed">Start Blast</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import axios from 'axios'

const API = import.meta.env.VITE_API_URL || ''
const router = useRouter()
const auth = useAuthStore()
const toast = useToastStore()

// v0.2.0 — embedded mode: dirender dalam tab Blast.vue (tanpa top bar sendiri)
defineProps({
  embedded: { type: Boolean, default: false },
})

const steps = ['Recipients', 'Message', 'Rate Limit', 'Review']
const step = ref(0)

// Step 1 — Chat List
const recipientTab = ref('chats')
const chatSearch = ref('')
const chatFilter = ref('all')
const availableChats = ref([])
const loadingChats = ref(false)
const selectedChatIds = ref(new Set())
const selectedTagIds = ref(new Set())
const allTags = ref([])
const tagRecipientCount = ref(0)

// Step 1 — CSV
const csvDragOver = ref(false)
const csvUploading = ref(false)
const csvError = ref('')
const csvNumbers = ref([]) // [{ name, phone, normalized, valid, reason }]

// v0.2.3 — recipient dari Kontak tersimpan (request Kanaka 2026-09-01 21:02)
const availableContacts = ref([])
const contactSearch = ref('')
const contactPage = ref(1)
const contactTotal = ref(0)
const loadingContacts = ref(false)
const selectedContactMap = ref(new Map()) // id -> contact object
let contactSearchTimer = null

function normalizeContactPhone(raw) {
  if (!raw) return { normalized: '', valid: false, reason: 'No phone' }
  let p = String(raw).replace(/[\s\-().]/g, '')
  if (p.startsWith('+')) p = p.slice(1)
  if (p.startsWith('0')) p = '62' + p.slice(1)
  if (p.startsWith('8') && p.length >= 8 && !p.startsWith('62')) p = '62' + p
  if (!/^\d+$/.test(p)) return { normalized: '', valid: false, reason: 'Bukan angka' }
  if (!p.startsWith('62')) {
    if (p.length < 8) return { normalized: '', valid: false, reason: 'Terlalu pendek' }
  } else if (p.length < 10) return { normalized: '', valid: false, reason: 'Terlalu pendek' }
  if (p.length > 15) return { normalized: '', valid: false, reason: 'Terlalu panjang' }
  return { normalized: p, valid: true, reason: '' }
}
const coldNumbers = ref([]) // [{ phone, name }] — from preview

// Step 2 — Message + Media
const message = ref('')
const messageTextareaRef = ref(null)
const attachedImagePath = ref(null) // mediaPath from server
const attachedImagePreviewUrl = ref(null) // object URL for preview
const uploadingImage = ref(false)

// Step 3
const presets = [
  { name: 'Fastest', delayPerMsg: 2, groupSize: 50, delayPerGroup: 30 },
  { name: 'Medium', delayPerMsg: 5, groupSize: 100, delayPerGroup: 60 },
  { name: 'Slowest', delayPerMsg: 10, groupSize: 50, delayPerGroup: 120 },
]
const rateConfig = ref({ delayPerMsg: 5, groupSize: 100, delayPerGroup: 60 })
const currentPresetName = ref('Medium')

// Step 4
const showConfirm = ref(false)
const sending = ref(false)
const acknowledgeColdRisk = ref(false)

// ─── Computed ──────────────────────────────────────────────────────

const csvValidCount = computed(() => csvNumbers.value.filter(n => n.valid).length)
const csvInvalidCount = computed(() => csvNumbers.value.filter(n => !n.valid).length)
const csvDuplicates = computed(() => csvNumbers.value.filter(n => !n.valid && n.reason === 'Duplicate in CSV').length)

const selectedContactObjs = computed(() => [...selectedContactMap.value.values()])
const contactChatIds = computed(() => new Set(selectedContactObjs.value.filter(c => c.chatId).map(c => c.chatId)))
const csvNormSet = computed(() => new Set(csvNumbers.value.filter(n => n.valid).map(n => n.normalized)))
const noChatContactNumbers = computed(() => selectedContactObjs.value
  .filter(c => !c.chatId)
  .map(c => { const n = normalizeContactPhone(c.phone); return { name: c.name || '', phone: c.phone, normalized: n.normalized, valid: n.valid, reason: n.reason } })
  .filter(n => n.valid && !csvNormSet.value.has(n.normalized)))

const totalUniqueRecipients = computed(() => {
  // v0.2.3 — chat ids unik (chat list ∪ kontak ber-chat) + kontak tanpa chat (cold) + CSV valid
  const chatIdSet = new Set([...selectedChatIds.value, ...contactChatIds.value])
  return chatIdSet.size + noChatContactNumbers.value.length + csvValidCount.value
})

const combinedRecipientsPreview = computed(() => {
  const preview = []
  // From chat list
  for (const chat of availableChats.value) {
    if (selectedChatIds.value.has(chat.id)) {
      preview.push({ id: chat.id, name: chat.contactName || chat.contactPhone || chat.id, phone: chat.contactPhone })
    }
  }
  // v0.2.3 — dari Kontak tersimpan (chat-linked dedupe dgn chat list; cold dedupe dgn CSV)
  for (const ct of selectedContactObjs.value) {
    if (ct.chatId) {
      if (!selectedChatIds.value.has(ct.chatId)) {
        preview.push({ id: ct.chatId, name: ct.name || ct.phone || 'Kontak', phone: ct.phone })
      }
    } else {
      const n = normalizeContactPhone(ct.phone)
      if (n.valid && !csvNormSet.value.has(n.normalized)) {
        preview.push({ id: `contact-${ct.id}`, name: ct.name || n.normalized, phone: ct.phone })
      }
    }
  }
  // From CSV
  for (const csv of csvNumbers.value) {
    if (csv.valid) {
      preview.push({ id: csv.normalized, name: csv.name || csv.normalized, phone: csv.normalized })
    }
  }
  return preview
})

const totalGroups = computed(() => Math.ceil(totalUniqueRecipients.value / (rateConfig.value.groupSize || 1)))
const estimatedMinutes = computed(() => {
  const totalSec = totalUniqueRecipients.value * rateConfig.value.delayPerMsg + totalGroups.value * rateConfig.value.delayPerGroup
  return Math.ceil(totalSec / 60)
})

const previewRecipients = computed(() => combinedRecipientsPreview.value.slice(0, 3))

// ─── Toolbar functions ─────────────────────────────────────────────

function wrapSelection(before, after) {
  const textarea = messageTextareaRef.value
  if (!textarea) return
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const selected = message.value.substring(start, end)
  message.value = message.value.substring(0, start) + before + selected + after + message.value.substring(end)
  nextTick(() => {
    textarea.focus()
    textarea.setSelectionRange(start + before.length, end + before.length)
  })
}

function insertLinePrefix(prefix) {
  const textarea = messageTextareaRef.value
  if (!textarea) return
  const start = textarea.selectionStart
  const lineStart = message.value.lastIndexOf('\n', start - 1) + 1
  message.value = message.value.substring(0, lineStart) + prefix + message.value.substring(lineStart)
  nextTick(() => {
    textarea.focus()
    textarea.setSelectionRange(start + prefix.length, start + prefix.length)
  })
}

function insertName() {
  const textarea = messageTextareaRef.value
  if (!textarea) return
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  message.value = message.value.substring(0, start) + '{name}' + message.value.substring(end)
  nextTick(() => {
    textarea.focus()
    textarea.setSelectionRange(start + 6, start + 6)
  })
}

// ─── Image attachment ──────────────────────────────────────────────

async function attachImage() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    uploadingImage.value = true
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await axios.post(`${API}/api/media/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      attachedImagePath.value = res.data.mediaId
      // Create preview URL from the file
      attachedImagePreviewUrl.value = URL.createObjectURL(file)
    } catch (err) {
      toast.show({ icon: '⚠️', title: 'Gagal upload gambar', message: err.response?.data?.error || err.message })
    } finally {
      uploadingImage.value = false
    }
  }
  input.click()
}

function removeImage() {
  if (attachedImagePreviewUrl.value) {
    URL.revokeObjectURL(attachedImagePreviewUrl.value)
  }
  attachedImagePath.value = null
  attachedImagePreviewUrl.value = null
}

// ─── CSV Upload ────────────────────────────────────────────────────

async function handleCsvFileSelect(e) {
  const file = e.target.files[0]
  if (file) await uploadCsv(file)
}

async function handleCsvDrop(e) {
  csvDragOver.value = false
  const file = e.dataTransfer.files[0]
  if (file) await uploadCsv(file)
}

async function uploadCsv(file) {
  csvError.value = ''
  csvUploading.value = true
  try {
    const formData = new FormData()
    formData.append('file', file)
    const res = await axios.post(`${API}/api/blast/upload-csv`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    csvNumbers.value = res.data.numbers
    // After CSV upload, fetch preview to detect cold numbers
    await fetchColdNumbers()
  } catch (err) {
    csvError.value = err.response?.data?.error || err.message || 'Failed to parse CSV'
  } finally {
    csvUploading.value = false
  }
}

async function fetchColdNumbers() {
  const validCsvNumbers = csvNumbers.value.filter(n => n.valid).map(n => ({ name: n.name, phone: n.phone, normalized: n.normalized, valid: true }))
  if (validCsvNumbers.length === 0) {
    coldNumbers.value = []
    return
  }
  try {
    const res = await axios.post(`${API}/api/blast/preview`, {
      recipientChatIds: [...new Set([...selectedChatIds.value, ...contactChatIds.value])],
      tagIds: [...selectedTagIds.value],
      csvNumbers: [...validCsvNumbers, ...noChatContactNumbers.value],
    })
    coldNumbers.value = res.data.coldNumbers || []
  } catch (err) {
    console.error('Preview error:', err)
    // Non-fatal — continue without cold number detection
  }
}

function removeCsvRow(idx) {
  csvNumbers.value.splice(idx, 1)
  fetchColdNumbers()
}

function removeInvalidCsvRows() {
  csvNumbers.value = csvNumbers.value.filter(n => n.valid)
  fetchColdNumbers()
}

function clearCsv() {
  csvNumbers.value = []
  coldNumbers.value = []
  csvError.value = ''
}

// ─── Recipient management ──────────────────────────────────────────

function handleLogout() {
  auth.logout()
  router.push('/login')
}

function goToStep(s) { step.value = s }

function applyPreset(p) {
  rateConfig.value = { delayPerMsg: p.delayPerMsg, groupSize: p.groupSize, delayPerGroup: p.delayPerGroup }
  currentPresetName.value = p.name
}

async function fetchChatsForPicker() {
  loadingChats.value = true
  try {
    const res = await axios.get(`${API}/api/chats`, { params: { filter: chatFilter.value } })
    let chats = res.data.chats
    if (chatSearch.value) {
      const q = chatSearch.value.toLowerCase()
      chats = chats.filter(c => 
        (c.contactName || '').toLowerCase().includes(q) || 
        (c.contactPhone || '').toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q)
      )
    }
    availableChats.value = chats
  } catch (e) {
    console.error('Fetch chats error:', e)
  } finally {
    loadingChats.value = false
  }
}

function toggleChat(chatId) {
  const newSet = new Set(selectedChatIds.value)
  if (newSet.has(chatId)) newSet.delete(chatId)
  else newSet.add(chatId)
  selectedChatIds.value = newSet
}

function selectAllChats() {
  if (selectedChatIds.value.size === availableChats.value.length && availableChats.value.length > 0) {
    selectedChatIds.value = new Set()
  } else {
    selectedChatIds.value = new Set(availableChats.value.map(c => c.id))
  }
}

function toggleTag(tagId) {
  const newSet = new Set(selectedTagIds.value)
  if (newSet.has(tagId)) newSet.delete(tagId)
  else newSet.add(tagId)
  selectedTagIds.value = newSet
}

async function fetchChatsByTags() {
  if (selectedTagIds.value.size === 0) return
  try {
    const tagIds = [...selectedTagIds.value].join(',')
    const res = await axios.get(`${API}/api/chats`, { params: { tagIds } })
    // Merge with selected chats
    const newSet = new Set(selectedChatIds.value)
    for (const c of res.data.chats) {
      newSet.add(c.id)
    }
    selectedChatIds.value = newSet
    tagRecipientCount.value = res.data.chats.length
  } catch (e) {
    console.error('Fetch chats by tags error:', e)
  }
}

// ── v0.2.3 — Kontak tersimpan sebagai recipient (frontend-only; pipeline backend sama) ──
async function fetchContactsForPicker(reset = true) {
  loadingContacts.value = true
  try {
    const res = await axios.get(`${API}/api/contacts`, { params: { page: contactPage.value, q: contactSearch.value.trim() || undefined } })
    const list = res.data.contacts || []
    availableContacts.value = reset ? list : [...availableContacts.value, ...list]
    contactTotal.value = res.data.total || 0
  } catch (e) {
    console.error('Fetch contacts error:', e)
  } finally {
    loadingContacts.value = false
  }
}
function openContactsTab() {
  recipientTab.value = 'contacts'
  if (availableContacts.value.length === 0 && !loadingContacts.value) fetchContactsForPicker(true)
}
function onContactSearchInput() {
  clearTimeout(contactSearchTimer)
  contactSearchTimer = setTimeout(() => { contactPage.value = 1; fetchContactsForPicker(true) }, 250)
}
async function loadMoreContacts() {
  contactPage.value++
  await fetchContactsForPicker(false)
}
function isContactSelected(ct) { return selectedContactMap.value.has(ct.id) }
function toggleContact(ct) {
  const m = new Map(selectedContactMap.value)
  if (m.has(ct.id)) m.delete(ct.id)
  else m.set(ct.id, ct)
  selectedContactMap.value = m
}
const contactsPageAllSelected = computed(() =>
  availableContacts.value.length > 0 && availableContacts.value.every(ct => selectedContactMap.value.has(ct.id))
)
function selectAllContacts() {
  const m = new Map(selectedContactMap.value)
  if (contactsPageAllSelected.value) {
    for (const ct of availableContacts.value) m.delete(ct.id)
  } else {
    for (const ct of availableContacts.value) m.set(ct.id, ct)
  }
  selectedContactMap.value = m
}

function clearAllRecipients() {
  selectedChatIds.value = new Set()
  selectedContactMap.value = new Map()
  selectedTagIds.value = new Set()
  csvNumbers.value = []
  coldNumbers.value = []
  tagRecipientCount.value = 0
}

function previewMessage(r) {
  const name = r.name
  if (name && name.trim()) {
    return message.value.replace(/\{name\}/g, name)
  }
  // No name — remove {name} and clean up
  let result = message.value.replace(/\{name\}/g, '')
  result = result.replace(/  +/g, ' ')
  result = result.replace(/\s+,/g, ',').replace(/\s+\./g, '.')
  return result.trim()
}

async function fetchTags() {
  try {
    const res = await axios.get(`${API}/api/tags`)
    allTags.value = res.data.tags
  } catch (e) {
    console.error('Fetch tags error:', e)
  }
}

async function startBlast() {
  sending.value = true
  try {
    const chatIds = [...new Set([...selectedChatIds.value, ...contactChatIds.value])]
    const tagIds = [...selectedTagIds.value]
    const validCsvNumbers = csvNumbers.value.filter(n => n.valid).map(n => ({ name: n.name, phone: n.phone, normalized: n.normalized, valid: true }))
    
    const payload = {
      message: message.value,
      recipientChatIds: chatIds,
      tagIds: tagIds,
      csvNumbers: [...validCsvNumbers, ...noChatContactNumbers.value],
      delayPerMsg: rateConfig.value.delayPerMsg,
      delayPerGroup: rateConfig.value.delayPerGroup,
      groupSize: rateConfig.value.groupSize,
    }
    
    if (attachedImagePath.value) {
      payload.mediaPath = attachedImagePath.value
    }
    
    const res = await axios.post(`${API}/api/blast`, payload)
    
    showConfirm.value = false
    router.push(`/blast/progress/${res.data.blastId}`)
  } catch (e) {
    toast.show({ icon: '⚠️', title: 'Gagal memulai blast', message: e.response?.data?.error || e.message })
  } finally {
    sending.value = false
  }
}

onMounted(() => {
  fetchChatsForPicker()
  fetchTags()
})
</script>

<style scoped>
.toolbar-btn {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 14px;
  color: #4b5563;
  transition: background 0.15s;
}
.toolbar-btn:hover {
  background: #f3f4f6;
}
.toolbar-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.toolbar-btn-disabled {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 14px;
  color: #d1d5db;
  cursor: not-allowed;
}
</style>
