/* v0.12.7 — ChatBareng (repo: wa-cs-hub) service worker: Web Push + notification click routing.
   Statis (bukan hasil build Vite). Tidak ada cache offline (phase 2).

   v0.12.7 bugfix (push lenyap saat app visible): push handler dulu LANGSUNG return kalau
   ada jendela visible — notifikasi hilang total karena in-app toast hanya diimplement
   untuk kind 'message' (Dashboard). Sekarang: app visible → pesan { type: 'push-inapp' }
   ke SEMUA window client (handler global di App.vue → toast); postMessage gagal / tidak
   ada window → fallback showNotification (path lama). App tertutup → system notif tetap.
   + skipWaiting/clients.claim agar SW baru aktif tanpa tunggu reload berikutnya. */

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (e) {
    data = { title: 'ChatBareng', body: event.data ? event.data.text() : '' }
  }

  const title = data.title || 'ChatBareng'
  const body = data.body || ''
  const url = data.url || '/'

  event.waitUntil(
    (async () => {
      // Kalau ada jendela app yang VISIBLE → jangan tampilkan notifikasi sistem
      // → kirim pesan ke app untuk menampilkan in-app toast (SEMUA kind, termasuk 'test').
      // postMessage gagal / tidak ada window visible → fallback showNotification.
      try {
        const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        const visibleWindows = clientList.filter(c => c.visibilityState === 'visible')
        if (visibleWindows.length > 0) {
          let delivered = false
          for (const client of visibleWindows) {
            try {
              await client.postMessage({ type: 'push-inapp', payload: data })
              delivered = true
            } catch (e) { /* coba client berikutnya */ }
          }
          if (delivered) return
          // Semua postMessage gagal → jatuh ke showNotification di bawah
        }
      } catch (e) {
        // Gagal cek clients → tampilkan notifikasi saja (fail-open, path lama)
      }
      await self.registration.showNotification(title, {
        body,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        tag: data.kind === 'message' ? `chat-${data.chatId || ''}` : (data.kind || 'wacshub'),
        renotify: false,
        data: { url, kind: data.kind, chatId: data.chatId },
      })
    })()
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = (event.notification.data && event.notification.data.url) || '/'

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // Fokus jendela app yang sudah ada; kalau ada, arahkan ke targetUrl
      for (const client of clientList) {
        try {
          const clientUrl = new URL(client.url)
          const target = new URL(targetUrl, self.location.origin)
          if (clientUrl.origin === self.location.origin) {
            await client.focus()
            if (clientUrl.pathname + clientUrl.search !== target.pathname + target.search) {
              await client.navigate(target.href).catch(() => {})
            }
            return
          }
        } catch (e) { /* lanjut ke client berikutnya */ }
      }
      // Tidak ada jendela → buka baru
      await self.clients.openWindow(targetUrl)
    })()
  )
})
