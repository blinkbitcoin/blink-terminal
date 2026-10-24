export function checkPngDataUrl(
  dataUrl: unknown,
  limits?: { maxSide?: number; maxDataUrlLength?: number },
): { ok: true; width: number; height: number } | { ok: false; reason: string }
