export function monthIndex(date: Date) {
  return date.getFullYear() * 12 + date.getMonth();
}

export function monthStart(index: number) {
  const date = new Date(0);
  date.setFullYear(Math.floor(index / 12), index % 12, 1);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function localDay(date: Date) {
  date.setHours(0, 0, 0, 0);
  return date;
}
