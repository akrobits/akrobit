// Service Worker extension for PWA Web Share Target (.vcf / shared contact text)
const SHARE_CACHE_NAME = 'akrobit-shared-contact-v1';
const SHARE_CACHE_KEY = '/_shared_contact_payload.json';

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share-contact') {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          const vcardChunks = [];

          const files = formData.getAll('vcard');
          for (const entry of files) {
            if (entry && typeof entry.text === 'function') {
              const content = await entry.text();
              if (content) {
                vcardChunks.push(content);
              }
            }
          }

          const payload = {
            vcardsText: vcardChunks.join('\n'),
            title: String(formData.get('title') || ''),
            text: String(formData.get('text') || ''),
            url: String(formData.get('url') || ''),
            receivedAt: Date.now(),
          };

          const cache = await caches.open(SHARE_CACHE_NAME);
          await cache.put(
            SHARE_CACHE_KEY,
            new Response(JSON.stringify(payload), {
              headers: { 'Content-Type': 'application/json' },
            })
          );
        } catch (err) {
          console.error('Error processing shared contact:', err);
        }

        return Response.redirect('/?sharedContact=1', 303);
      })()
    );
  }
});
