export function parseSingleByteRange(value, size) {
  if (!value) return null;
  if (!Number.isSafeInteger(size) || size <= 0) return { invalid: true };
  if (!/^bytes=\d*-\d*$/.test(value) || value.includes(',')) return { invalid: true };

  const [startText, endText] = value.slice(6).split('-');
  let start;
  let end;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
      return { invalid: true };
    }
    end = Math.min(end, size - 1);
  }
  if (start >= size) return { invalid: true };
  return { start, end };
}
