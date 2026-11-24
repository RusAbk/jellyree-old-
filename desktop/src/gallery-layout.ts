export const galleryGap = 14;
export const fallbackGalleryRatio = 4 / 3;

export type GalleryItem = { id: string; ratio: number };
export type GalleryTile = { id: string; width: number };
export type GalleryRow = {
  tiles: GalleryTile[];
  height: number;
  open: boolean;
};

export function appendGalleryRows(
  existing: GalleryRow[],
  incoming: GalleryItem[],
  width: number,
  targetHeight: number,
): GalleryRow[] {
  const rows = existing.slice();
  const ratios = incoming.map(({ ratio }) =>
    Number.isFinite(ratio) && ratio > 0
      ? Math.min(6, Math.max(0.45, ratio))
      : fallbackGalleryRatio,
  );
  let index = 0;
  const tail = rows.at(-1);
  if (tail?.open && incoming.length) {
    const tiles = tail.tiles.slice();
    let used =
      tiles.reduce((sum, tile) => sum + tile.width, 0) +
      (tiles.length - 1) * galleryGap;
    while (index < incoming.length) {
      const tileWidth = ratios[index]! * tail.height;
      if (used + galleryGap + tileWidth > width) break;
      tiles.push({ id: incoming[index]!.id, width: tileWidth });
      used += galleryGap + tileWidth;
      index++;
    }
    rows[rows.length - 1] = { ...tail, tiles, open: index === incoming.length };
  }

  while (index < incoming.length) {
    let end = index;
    let sum = 0;
    let height = targetHeight;
    let closed = false;
    for (; end < incoming.length; end++) {
      const ratio = ratios[end]!;
      const available = width - (end - index) * galleryGap;
      const fit = available / (sum + ratio);
      if (fit <= targetHeight) {
        if (end > index && fit < targetHeight * 0.75) {
          height = Math.min(
            targetHeight * 1.22,
            (available + galleryGap) / sum,
          );
        } else {
          height = fit;
          end++;
        }
        closed = true;
        break;
      }
      sum += ratio;
    }
    rows.push({
      height,
      open: !closed,
      tiles: incoming.slice(index, end).map(({ id }, offset) => ({
        id,
        width: ratios[index + offset]! * height,
      })),
    });
    index = end;
  }
  return rows;
}
