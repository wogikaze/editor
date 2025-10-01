export function clamp(value, min, max) {
  if (typeof value !== "number" || typeof min !== "number" || typeof max !== "number") {
    throw new TypeError("clamp expects numeric arguments");
  }
  if (min > max) {
    [min, max] = [max, min];
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function normalizeNewlines(text) {
  if (typeof text !== "string") {
    return text;
  }
  return text.replace(/\r\n/g, "\n");
}

export function colorWithAlpha(color, alpha) {
  if (typeof color !== "string" || color.length === 0) {
    return `rgba(255, 0, 0, ${alpha})`;
  }
  const hexMatch = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!hexMatch) {
    if (color.startsWith("rgb")) {
      return color.replace(/rgba?\(([^)]+)\)/, (_match, channel) => {
        const parts = channel.split(",").map((part) => part.trim());
        const [r = "255", g = "0", b = "0"] = parts;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      });
    }
    return color;
  }
  let hex = hexMatch[1];
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${Number.isNaN(r) ? 255 : r}, ${Number.isNaN(g) ? 0 : g}, ${Number.isNaN(b) ? 0 : b}, ${alpha})`;
}
