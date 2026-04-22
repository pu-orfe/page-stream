// Move fixed-position elements to direct children of <body>
// so that position:fixed is not trapped by ancestor transforms.
(function pinElements() {
  var footerSelector = '.background-color-light-gray.constrained-bkg-constrained-content.layout.layout--twocol-75-25';
  var logoSelector = '.site-logo img';

  function styleFooter(el) {
    document.body.appendChild(el);
    el.style.cssText = [
      'position: fixed',
      'bottom: 40px',
      'left: 20px',
      'z-index: 1000',
      'max-width: 55vw',
      'overflow-wrap: break-word',
      'box-sizing: border-box',
      'transform: scale(0.65)',
      'transform-origin: bottom left'
    ].join(' !important; ') + ' !important;';
  }

  function styleLogo(el) {
    document.body.appendChild(el);
    el.style.cssText = [
      'position: fixed',
      'bottom: 60px',
      'right: 60px',
      'z-index: 1000',
      'max-height: 80px',
      'width: auto'
    ].join(' !important; ') + ' !important;';
  }

  function tryPin() {
    var footer = document.querySelector(footerSelector);
    var logo = document.querySelector(logoSelector);
    var done = true;

    if (footer && !footer.dataset.pinned) {
      styleFooter(footer);
      footer.dataset.pinned = '1';
    } else if (!footer) {
      done = false;
    }

    if (logo && !logo.dataset.pinned) {
      styleLogo(logo);
      logo.dataset.pinned = '1';
    } else if (!logo) {
      done = false;
    }

    return done;
  }

  if (!tryPin()) {
    var attempts = 0;
    var timer = setInterval(function() {
      if (tryPin() || ++attempts > 20) {
        clearInterval(timer);
      }
    }, 500);
  }
})();
