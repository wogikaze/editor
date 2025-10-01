const WORD_REGEX = /[\w_]/;

function isWordChar(ch) {
  return typeof ch === "string" && ch.length > 0 && WORD_REGEX.test(ch);
}

export function findWordBoundary(text, index, direction) {
  if (typeof text !== "string") {
    return 0;
  }
  if (direction < 0) {
    let i = Math.max(0, index - 1);
    const targetType = isWordChar(text[i]);
    while (i > 0 && isWordChar(text[i - 1]) === targetType) {
      i -= 1;
    }
    return i;
  }
  let i = Math.min(text.length, index);
  const targetType = isWordChar(text[i]) || isWordChar(text[i - 1]);
  while (i < text.length && isWordChar(text[i]) === targetType) {
    i += 1;
  }
  return i;
}
