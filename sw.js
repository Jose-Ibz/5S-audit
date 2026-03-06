// ============================================================
// 5S AUDIT PRO — Service Worker
// Caché offline para funcionamiento sin internet
// ============================================================

const CACHE_NAME  = '5s-audit-v1';
const ASSETS      = [
  './',
  './index.html',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700&display=swap',
];

// ── INSTALL: guarda los ficheros en caché ──────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS).catch(() => {
        // Si falla algún asset externo (fuentes), continuar igual
        return cache.add('./index.html');
      });
    })
  );
  self.skipWaiting();
});

// ── ACTIVATE: limpia cachés antiguas ──────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── FETCH: sirve desde caché si no hay red ────────────────
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Las llamadas al Apps Script NUNCA se cachean — van siempre a la red
  if(url.includes('script.google.com')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        // Sin conexión — devolver error para que la app lo gestione
        return new Response(
          JSON.stringify({ ok: false, error: 'Sin conexión' }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // Para las fuentes de Google, intentar red primero, caché como fallback
  if(url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Para todo lo demás: caché primero, red como fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if(cached) return cached;
      return fetch(event.request).then(res => {
        // Guardar en caché para la próxima vez
        if(res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return res;
      }).catch(() => {
        // Sin red ni caché
        return caches.match('./index.html');
      });
    })
  );
});

// ── MESSAGE: forzar actualización de caché ────────────────
self.addEventListener('message', event => {
  if(event.data === 'skipWaiting') self.skipWaiting();
});
