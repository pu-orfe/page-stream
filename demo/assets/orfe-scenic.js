// Auto-advance slideshow by clicking .btn-next every 10 seconds
setInterval(() => {
  const btn = document.querySelector('.btn-next');
  if (btn) {
    btn.click();
    console.log('Clicked .btn-next to advance slideshow');
  } else {
    console.warn('Button .btn-next not found');
  }
}, 10000);