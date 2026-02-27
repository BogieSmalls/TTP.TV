const params = new URLSearchParams(window.location.search);
const totalMinutes = parseInt(params.get('minutes') ?? '0', 10);
const type = params.get('type') ?? 'up'; // 'up' or 'down'
const color = params.get('color') ?? 'D4AF37';
const bg = params.get('bg') ?? '000000';

const timerEl = document.getElementById('timer')!;
timerEl.style.color = `#${color}`;
document.body.style.backgroundColor = bg === 'transparent' ? 'transparent' : `#${bg}`;

const startTime = Date.now();
const totalMs = totalMinutes * 60 * 1000;

function formatTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function tick(): void {
  const elapsed = Date.now() - startTime;

  if (type === 'down') {
    const remaining = totalMs - elapsed;
    timerEl.textContent = formatTime(remaining);
    if (remaining <= 0) {
      timerEl.textContent = '0:00:00';
      return;
    }
  } else {
    timerEl.textContent = formatTime(elapsed);
  }

  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);

export {};
