/* תיק חשבוניות — service worker
   אסטרטגיה: network-first לקליפה, כדי שגרסה חדשה תמיד תיתפס.
   קריאות ל-API של גוגל ו-Gemini לא נכנסות לקאש בכלל. */

const CACHE = 'invoices-v4.0';
const SHELL = ['./', './index.html', './manifest.json', './logo.png', './version.json'];

self.addEventListener('install', e => {
  // לא מפעילים אוטומטית - הבאנר באפליקציה שולט מתי לעבור לגרסה החדשה
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // אף פעם לא לגעת בבקשות מזוהות / דינמיות
  if (e.request.method !== 'GET') return;
  if (/googleapis\.com|google\.com|gstatic\.com|generativelanguage/.test(url)) return;

  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r && r.ok && r.type === 'basic') {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return r;
      })
      .catch(() => caches.match(e.request).then(m => m || caches.match('./index.html')))
  );
});

// מאפשר לאפליקציה לבקש מעבר מיידי לגרסה החדשה
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
