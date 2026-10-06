'use strict';

// Keep the ordinary image until the shared slide controls are ready.
(async () => {
  const root = document.querySelector('.landing-planks');
  if (!root || !window.PlankWidgets) return;

  const host = root.querySelector('.intro-plank-diagram');
  const fallback = host.querySelector('img');
  let artwork;
  try {
    const response = await fetch(fallback.currentSrc || fallback.src);
    if (!response.ok) return;
    const parsed = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
    const svg = parsed.documentElement;
    if (svg.localName !== 'svg' || parsed.querySelector('parsererror')) return;
    artwork = svg.outerHTML;
  } catch {
    return;
  }

  const {PlankModel, PlankDiagram} = window.PlankWidgets;
  const model = new PlankModel('landing');
  const q = model.q.slice();
  [.4, .39, .37].forEach((width, i) => { q[3 * i + 1] = width; });
  model.initial = q.slice();
  model.commit({q, pristine: true});
  root.dataset.introPlanks = '3';
  const diagram = new PlankDiagram(host, model, {
    detailed: true,
    artwork,
    percentageDigits: 1,
  });
  diagram.bindHints(root);

  const caption = root.querySelector('figcaption');
  const reset = root.querySelector('.intro-plank-reset');
  const play = root.querySelector('.landing-plank-play');
  const relation = root.querySelector('[data-width-relation]');
  const total = root.querySelector('[data-width-sum]');
  const widthLabels = [...root.querySelectorAll('[data-width]')];
  const rounded = width => Math.round(width * 1000) / 10;

  function update() {
    reset.hidden = !model.changed;
    const widths = model.planks().map(plank => plank.rw);
    const sum = widths.reduce((a, b) => a + b, 0);
    widthLabels.forEach(node => { node.textContent = rounded(widths[Number(node.dataset.width)]); });
    total.textContent = rounded(sum);
    relation.textContent = Math.abs(widths.reduce((s, w) => s + rounded(w), 0) - rounded(sum)) < 1e-8 ? '=' : '≈';
  }

  let frame = null;
  let previousTime = null;
  let visible = true;
  function tick(now) {
    frame = null;
    const dt = previousTime === null ? 0 : Math.min(.05, (now - previousTime) / 1000);
    previousTime = now;
    model.tick(dt);
    schedule();
  }
  function schedule() {
    const running = model.playing && visible && !document.hidden;
    if (running && frame === null) frame = requestAnimationFrame(tick);
    if (!running) {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      previousTime = null;
    }
  }
  function updatePlay() {
    const label = model.playing ? 'Pause' : 'Animate';
    play.setAttribute('aria-label', label);
    play.title = label;
    play.setAttribute('aria-pressed', String(model.playing));
    schedule();
  }

  model.addEventListener('change', update);
  model.addEventListener('playchange', updatePlay);
  play.addEventListener('click', () => model.playing ? model.stop() : model.start());
  reset.addEventListener('click', () => { diagram.cancel(); model.reset(); });
  document.addEventListener('visibilitychange', schedule);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      schedule();
    }).observe(host);
  }

  // No autoplay, including when the reader prefers reduced motion.
  root.introPlanks = {model, diagram};
  update();
  updatePlay();
  caption.hidden = false;
})();
