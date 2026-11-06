/* Only public installation assets are cached. Never financial pages or APIs. */
const CACHE = "entre-nos-public-v3";
const PUBLIC = ["/offline.html", "/icons/icon-192-v3.png", "/icons/icon-512-v3.png", "/icons/apple-touch-icon-v3.png"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PUBLIC)));
  self.skipWaiting();
});
self.addEventListener('push',event=>{
  // Ignore supplied text: lock-screen notifications never expose financial data.
  let test = false;
  try { test = event.data?.json()?.type === 'test'; } catch { /* Untrusted payload text is never displayed. */ }
  event.waitUntil(self.registration.showNotification('Entre Nós',{body:test ? 'Teste de notificações: este aparelho está recebendo os avisos.' : 'Há contas para conferir no nosso mês.',icon:'/icons/icon-192-v3.png',badge:'/icons/icon-192-v3.png',tag:test ? 'entre-nos-teste' : 'entre-nos-contas',data:{url:'/?view=month'}}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(async windows=>{
    const client=windows.find(w=>new URL(w.url).origin===self.location.origin);
    if(client){await client.navigate('/?view=month');return client.focus();}
    return clients.openWindow('/?view=month');
  }));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("entre-nos-public-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/offline.html")));
  } else if (PUBLIC.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});
