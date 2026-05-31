// guide.js - tab switching for the usage guide (external file so it complies
// with the page's strict CSP: script-src 'self', no inline scripts).
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  const mode = t.dataset.mode;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.mode === mode));
  document.querySelectorAll('section.mode').forEach(s => s.classList.toggle('active', s.classList.contains(mode)));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}));
