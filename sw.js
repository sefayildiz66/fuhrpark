// YILDIZ TAXI Fuhrpark – Service Worker (nur für Push-Erinnerungen)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'YILDIZ TAXI', body: e.data ? e.data.text() : '' }; }
  const jobs = [self.registration.showNotification(d.title || 'YILDIZ TAXI', {
    body: d.body || '', icon: 'icon-192.png', badge: 'icon-192.png', tag: 'fristen', renotify: true, data: { url: d.url || './' }
  })];
  if (d.count && self.navigator && self.navigator.setAppBadge) jobs.push(self.navigator.setAppBadge(d.count).catch(() => {}));
  e.waitUntil(Promise.all(jobs));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) if ('focus' in w) return w.focus();
    return self.clients.openWindow(url);
  }));
});
