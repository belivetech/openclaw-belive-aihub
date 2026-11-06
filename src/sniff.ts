/** Content checks on bytes the gateway returned, or on inputs we are about to upload. */
export function sniffImage(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | undefined {
  const at = (i: number) => bytes[i];
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  const tag = (offset: number) => String.fromCharCode(...Array.from(bytes.subarray(offset, offset + 4)));
  if (bytes.length >= 12 && tag(0) === "RIFF" && tag(8) === "WEBP") return "image/webp";
  return undefined;
}

export function isMp4(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && String.fromCharCode(...Array.from(bytes.subarray(4, 8))) === "ftyp";
}

export function isWav(bytes: Uint8Array): boolean {
  const tag = (offset: number) => String.fromCharCode(...Array.from(bytes.subarray(offset, offset + 4)));
  return bytes.length >= 12 && tag(0) === "RIFF" && tag(8) === "WAVE";
}

export function extensionFor(mime: string): string {
  return mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
}
