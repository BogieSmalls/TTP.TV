const params = new URLSearchParams(window.location.search);
const eventName = params.get('event') ?? '';
const round = params.get('round') ?? '';
const cycleSeconds = parseInt(params.get('cycle') ?? '10', 10);

const slides: string[] = [];
if (eventName) slides.push(eventName);
if (round) slides.push(round);
// Add combined slide if both exist
if (eventName && round) slides.push(`${eventName}  \u2022  ${round}`);

// Fallback if no params given
if (slides.length === 0) slides.push('Triforce Triple Play');

const footer = document.getElementById('footer')!;

// Create slide elements
const slideEls = slides.map((text) => {
  const div = document.createElement('div');
  div.className = 'slide';
  div.textContent = text;
  footer.appendChild(div);
  return div;
});

let current = 0;
slideEls[0].classList.add('active');

if (slides.length > 1) {
  setInterval(() => {
    slideEls[current].classList.remove('active');
    current = (current + 1) % slides.length;
    slideEls[current].classList.add('active');
  }, cycleSeconds * 1000);
}

export {};
