import { ref } from "vue";
import {
  normalizeImageAdjustments,
  defaultImageAdjustments,
  type ImageAdjustments,
} from "../electron/image-adjustments.mjs";
import type { Histogram } from "./image-pixels.mjs";
export const copiedImageEdits = ref<ImageAdjustments | null>(null);
export const editGroups = [
  {
    id: "tone",
    label: "Свет и тон",
    controls: [
      ["exposure", "Экспозиция"],
      ["brightness", "Яркость"],
      ["contrast", "Контраст"],
      ["toneDepth", "Глубина тона"],
      ["shadows", "Тени"],
      ["highlights", "Светлые участки"],
    ],
  },
  {
    id: "detail",
    label: "Детали",
    controls: [
      ["sharpness", "Резкость"],
      ["clarity", "Чёткость"],
      ["definition", "Локальный контраст"],
      ["glamour", "Мягкое свечение"],
      ["grain", "Зерно"],
      ["vignette", "Виньетка"],
    ],
  },
  {
    id: "color",
    label: "Цвет",
    controls: [
      ["temperature", "Температура"],
      ["tint", "Оттенок"],
      ["vibrance", "Сочность"],
      ["saturation", "Насыщенность"],
      ["grayscale", "Чёрно-белое"],
      ["sepia", "Сепия"],
      ["fade", "Выцветание"],
    ],
  },
] as const;
export const imagePresets: {
  label: string;
  values: Partial<ImageAdjustments>;
}[] = [
  {
    label: "Чистый свет",
    values: { exposure: 6, contrast: 104, saturation: 103, clarity: 5 },
  },
  {
    label: "Яркие цвета",
    values: { contrast: 111, vibrance: 28, saturation: 108, definition: 18 },
  },
  {
    label: "Мягкий портрет",
    values: { temperature: 7, shadows: 8, glamour: 30, sharpness: 8 },
  },
  {
    label: "Закат",
    values: {
      temperature: 27,
      tint: 5,
      vibrance: 16,
      highlights: -14,
      vignette: 14,
    },
  },
  {
    label: "Ночной кадр",
    values: {
      exposure: 20,
      shadows: 35,
      highlights: -20,
      definition: 10,
      grain: 3,
    },
  },
  {
    label: "Кино",
    values: {
      temperature: -10,
      contrast: 112,
      saturation: 89,
      shadows: 10,
      fade: 12,
      vignette: 18,
    },
  },
  {
    label: "Матовая плёнка",
    values: { contrast: 92, fade: 26, grain: 16, sepia: 10, saturation: 91 },
  },
  {
    label: "Выразительное ЧБ",
    values: {
      grayscale: 100,
      contrast: 119,
      toneDepth: 15,
      sharpness: 18,
      vignette: 12,
    },
  },
];
export function smartAuto(
  histogram: Histogram,
  input: ImageAdjustments,
): ImageAdjustments {
  const total = histogram.bins.reduce((sum, value) => sum + value, 0);
  if (!total) return normalizeImageAdjustments(input);
  const mean =
    histogram.bins.reduce(
      (sum, value, index) => sum + (value * (index + 0.5)) / 64,
      0,
    ) / total;
  return normalizeImageAdjustments({
    ...input,
    exposure: Math.max(
      -40,
      Math.min(
        40,
        input.exposure + 50 * Math.log2(0.46 / Math.max(0.04, mean)),
      ),
    ),
    shadows: Math.min(100, input.shadows + Math.min(30, histogram.shadows * 2)),
    highlights: Math.max(
      -100,
      input.highlights - Math.min(30, histogram.highlights * 2),
    ),
    vibrance: Math.min(100, input.vibrance + 10),
  });
}
export function resetColorAndTone(
  input: ImageAdjustments,
  values: Partial<ImageAdjustments>,
) {
  const result = { ...input };
  for (const group of editGroups)
    for (const [key] of group.controls)
      result[key] = defaultImageAdjustments[key];
  return normalizeImageAdjustments({ ...result, ...values });
}
export function fitCrop(
  input: ImageAdjustments,
  ratio: number,
  imageWidth: number,
  imageHeight: number,
) {
  const result = { ...input },
    normalized = (ratio * imageHeight) / imageWidth;
  const cx = input.cropX + input.cropWidth / 2,
    cy = input.cropY + input.cropHeight / 2;
  result.cropWidth = Math.min(input.cropWidth, input.cropHeight * normalized);
  result.cropHeight = result.cropWidth / normalized;
  result.cropX = Math.max(
    0,
    Math.min(1 - result.cropWidth, cx - result.cropWidth / 2),
  );
  result.cropY = Math.max(
    0,
    Math.min(1 - result.cropHeight, cy - result.cropHeight / 2),
  );
  // Very thin ratios still need a usable handle area.
  if (result.cropWidth < 0.02 || result.cropHeight < 0.02) return input;
  return normalizeImageAdjustments(result);
}
