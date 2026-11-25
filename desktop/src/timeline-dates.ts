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

const twoDigits = (value: number) => String(value).padStart(2, "0");

export function dateInputValue(date: Date) {
  if (!Number.isFinite(date.getTime())) return "";
  return [
    String(date.getFullYear()).padStart(4, "0"),
    twoDigits(date.getMonth() + 1),
    twoDigits(date.getDate()),
  ].join("-");
}

export function timeInputValue(date: Date) {
  if (!Number.isFinite(date.getTime())) return "";
  return [twoDigits(date.getHours()), twoDigits(date.getMinutes())].join(":");
}

export function captureDateOnDay(previous: string, day: string, time: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day.startsWith("0000")) return null;
  const date = new Date(previous);
  const previousTime = timeInputValue(date);
  const localTime = time || previousTime || "00:00";
  if (!/^\d{2}:\d{2}$/.test(localTime)) return null;
  if (!time && dateInputValue(date) === day) return date.toISOString();
  const seconds = !time && previousTime ? date.getSeconds() : 0;
  const millis = !time && previousTime ? date.getMilliseconds() : 0;
  const changed = new Date(
    `${day}T${localTime}:${twoDigits(seconds)}.${String(millis).padStart(3, "0")}`,
  );
  if (
    dateInputValue(changed) !== day ||
    timeInputValue(changed) !== localTime ||
    changed.getUTCFullYear() < 1 ||
    changed.getUTCFullYear() > 9999
  )
    return null;
  return changed.toISOString();
}
