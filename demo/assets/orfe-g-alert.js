// Move the congratulatory alert banner to a direct child of <body>,
// then apply all styles inline to avoid inheritance/specificity issues.
(function pinAlert() {
  function styleAlert(el) {
    // Move to body so position:fixed is relative to viewport
    document.body.appendChild(el);

    // Banner container
    el.style.cssText = [
      'position: fixed',
      'bottom: 60px',
      'left: 0',
      'width: 100%',
      'z-index: 99999',
      'min-height: 120px',
      'margin: 0',
      'padding: 1.5rem 3rem',
      'box-sizing: border-box',
      'display: flex',
      'flex-direction: row',
      'align-items: baseline',
      'background: #000',
      'color: #fff',
      'border-radius: 0'
    ].join(' !important; ') + ' !important;';

    // Title: left side, vertically centered
    var title = el.querySelector('.alert-title');
    if (title) {
      title.style.cssText = [
        'font-size: 4rem',
        'line-height: 1.3',
        'margin: 0',
        'color: #fff',
        'flex-shrink: 0'
      ].join(' !important; ') + ' !important;';
    }

    // Body: right-aligned
    var body = el.querySelector('.alert-body');
    if (body) {
      body.style.cssText = [
        'display: flex',
        'visibility: visible',
        'opacity: 1',
        'align-items: center',
        'margin-left: auto',
        'text-align: right',
        'color: #fff',
        'font-size: 1.4rem',
        'line-height: 1.4',
        'max-height: none',
        'height: auto',
        'overflow: visible'
      ].join(' !important; ') + ' !important;';
    }

    // Hide close button
    var close = el.querySelector('.close-alert');
    if (close) {
      close.style.display = 'none';
    }
  }

  var el = document.querySelector('.alert-row.alert-id-12481');
  if (el) {
    styleAlert(el);
  } else {
    var attempts = 0;
    var timer = setInterval(function() {
      var el = document.querySelector('.alert-row.alert-id-12481');
      if (el) {
        styleAlert(el);
        clearInterval(timer);
      } else if (++attempts > 20) {
        clearInterval(timer);
      }
    }, 500);
  }
})();
