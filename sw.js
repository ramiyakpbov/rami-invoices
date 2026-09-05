/* תיק חשבוניות — service worker
   אסטרטגיה: network-first לקליפה, כדי שגרסה חדשה תמיד תיתפס.
   קריאות ל-API של גוגל ו-Gemini לא נכנסות לקאש בכלל. */

const CACHE = 'invoices-v6.1';
const SHELL = ['./', './index.html', './manifest.json', './logo.png', './version.json'];

/* פיצ'ר 7 — כתיבה ל-IndexedDB מתוך ה-SW.
   ה-SW לא יכול להשתמש בעוזרי ה-IDB שב-index.html, ולכן יש כאן
   מימוש מינימלי משלו. שם ה-DB וה-store זהים בדיוק לאלה שבאפליקציה
   ('invoices_db' / 'kv'), אחרת האפליקציה לא תמצא את מה שנשמר.
   שומרים Blob-ים כמו שהם - IndexedDB תומך בזה מובנה. */
function swIdbOpen(){
  return new Promise((res, rej) => {
    const r = indexedDB.open('invoices_db', 1);
    r.onupgradeneeded = () => { if(!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}
async function swStashShared(files){
  const payload = files.map(f => ({
    blob: f,
    name: f.name || ('share-' + Date.now() + (/pdf/i.test(f.type) ? '.pdf' : '.jpg')),
    type: f.type || 'application/octet-stream'
  }));
  const db = await swIdbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put({ at: Date.now(), files: payload }, 'sharedInbox');
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

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

  /* פיצ'ר 7 — יעד שיתוף (WhatsApp / כל אפליקציה אחרת).
     המערכת שולחת POST עם multipart/form-data ל-./share-target.
     אנחנו קולטים כאן, שומרים את הקבצים ב-IndexedDB (אותו DB
     שהאפליקציה משתמשת בו), ומחזירים redirect לאפליקציה עם דגל.
     חייב לרוץ לפני שאר הלוגיקה כי זה POST ולא GET. */
  if (e.request.method === 'POST' && url.includes('share-target')) {
    e.respondWith((async () => {
      try {
        const fd = await e.request.formData();
        const files = fd.getAll('file').filter(f => f && f.size);
        if (files.length) await swStashShared(files);
      } catch (err) { /* אם נכשל - עדיין מפנים, האפליקציה תציג שאין קבצים */ }
      return Response.redirect('./index.html?shared=1', 303);
    })());
    return;
  }

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

/* ============================================================
   v5.4 — תזכורת סריקה כשהאפליקציה סגורה.
   ה-SW לא סורק בעצמו: הטוקן של גוגל פג אחרי שעה ואי אפשר לחדש
   אותו כאן (ספריית GIS רצה רק בדף). לכן הוא רק בודק אם הגיע
   המועד ושולח התראה שפותחת את האפליקציה.
   מצב התזמון נקרא מ-IndexedDB כי ל-SW אין גישה ל-localStorage.
   ============================================================ */
function swIdbGet(key){
  return swIdbOpen().then(db => new Promise((res, rej) => {
    const t = db.transaction('kv', 'readonly');
    const r = t.objectStore('kv').get(key);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  }));
}
function swIdbPut(key, val){
  return swIdbOpen().then(db => new Promise((res, rej) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put(val, key);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  }));
}
/* אותה לוגיקה כמו schedDue() בדף, אבל על המצב המשוקף.
   בנוסף: לא מתריעים יותר מפעם ב-12 שעות, כדי שאירוע sync תכוף
   לא יהפוך לספאם. */
function swScanDue(s, now){
  if (!s || !s.on) return false;
  const parts = String(s.time || '09:00').split(':');
  const hh = parseInt(parts[0], 10) || 0, mm = parseInt(parts[1], 10) || 0;
  const d = new Date(now);
  const todayAt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0).getTime();
  if (now < todayAt) return false;
  if (s.lastRun && s.lastRun >= todayAt) return false;
  if (s.lastNotified && (now - s.lastNotified) < 12 * 60 * 60 * 1000) return false;
  return true;
}
self.addEventListener('periodicsync', e => {
  if (e.tag !== 'scan-reminder') return;
  e.waitUntil((async () => {
    try {
      const s = await swIdbGet('schedState');
      const now = Date.now();
      if (!swScanDue(s, now)) return;
      if (s.kinds && s.kinds.newDocs === false) return;
      await self.registration.showNotification('זמן לסרוק חשבוניות', {
        body: 'הקש כדי לפתוח את האפליקציה ולהתחיל סריקה.',
        icon: './icon-192.png', badge: './icon-192.png',
        dir: 'rtl', lang: 'he', tag: 'scan-reminder',
        data: { action: 'scan' }
      });
      s.lastNotified = now;
      await swIdbPut('schedState', s);
    } catch (err) { /* שקט - לא מפילים את אירוע ה-sync */ }
  })());
});
/* לחיצה על ההתראה: אם האפליקציה כבר פתוחה בטאב - מתמקדים בו,
   אחרת פותחים אותה עם דגל שמפעיל סריקה מיד. */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const wantScan = e.notification.data && e.notification.data.action === 'scan';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        if (wantScan) c.postMessage({ type: 'RUN_SCAN' });
        return c.focus();
      }
    }
    if (self.clients.openWindow)
      return self.clients.openWindow(wantScan ? './index.html?scan=1' : './index.html');
  })());
});
