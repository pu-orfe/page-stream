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
      'max-width: 80vw',
      'width: 80vw',
      'overflow-wrap: break-word',
      'box-sizing: border-box',
      'transform: scale(0.5)',
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
      'max-height: 96px',
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

// Apply subtle accent colors to individual FPO event listings,
// cycling through colors sampled from the printed FPO announcement stock.
(function accentListings() {
  var colors = [
    'rgb(201,140,32)',
    'rgb(197,184,98)',
    'rgb(227,208,162)',
    'rgb(142,171,136)',
    'rgb(127,155,163)',
    'rgb(141,120,153)',
    'rgb(182,134,131)'
  ];

  function applyColors() {
    var items = document.querySelectorAll('.content-list-item');
    if (!items.length) return false;
    for (var i = 0; i < items.length; i++) {
      var c = colors[i % colors.length];
      items[i].style.borderLeft = '6px solid ' + c;
      items[i].style.paddingLeft = '12px';
      items[i].style.paddingTop = '8px';
      items[i].style.paddingBottom = '8px';
      items[i].style.backgroundColor = c.replace('rgb(', 'rgba(').replace(')', ',0.07)');
    }
    return true;
  }

  if (!applyColors()) {
    var attempts = 0;
    var timer = setInterval(function() {
      if (applyColors() || ++attempts > 20) {
        clearInterval(timer);
      }
    }, 500);
  }
})();
