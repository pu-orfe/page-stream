// Simple demo injection JS: insert a banner and add a pulsing class to the first <h1> if present
(function () {
  try {
    const banner = document.createElement('div');
    banner.id = 'demo-inject-banner';
    banner.textContent = 'Injected CSS/JS active';
    document.documentElement.appendChild(banner);

    // Add pulse to the first heading we can find
    const h1 = document.querySelector('h1');
    if (h1) h1.classList.add('pulse');

    // Small console marker for debugging in tests
    console.log('[demo-inject] inject.js loaded');
  } catch (e) {
    // Avoid throwing in page context
    console.warn('[demo-inject] injection failed', e);
  }
})();
