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
