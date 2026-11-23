export const playbackSpeeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
export function playbackSpeed(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0.25 && number <= 2 ? number : 1;
}
export function framePosition(value: number) {
  const milliseconds = Math.max(
    0,
    Math.floor(Number.isFinite(value) ? value * 1000 : 0),
  );
  const seconds = Math.floor(milliseconds / 1000),
    hours = Math.floor(seconds / 3600);
  return `${hours ? `${hours}:` : ""}${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.${String(milliseconds % 1000).padStart(3, "0")}`;
}
