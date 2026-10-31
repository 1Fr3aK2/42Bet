export function fmt(price) {
  return '€' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function formatTime(s) {
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

