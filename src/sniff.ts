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

/** An MP3 stream starts with an ID3 tag or an MPEG audio frame sync. */
export function isMp3(bytes: Uint8Array): boolean {
  return bytes.length >= 4
    && ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
}

/** The two recordings the AI Hub transcription route accepts, decided by content and not by file name. */
export function sniffTranscriptionAudio(bytes: Uint8Array): "audio/wav" | "audio/mpeg" | undefined {
  return isWav(bytes) ? "audio/wav" : isMp3(bytes) ? "audio/mpeg" : undefined;
}

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...Array.from(bytes.subarray(start, end)));

/** Whether bytes the speech route returned look like the format that was asked for. `pcm` is headerless, so any audio passes. */
export function matchesSpeechFormat(format: string, bytes: Uint8Array): boolean {
  switch (format) {
    case "wav": return isWav(bytes);
    case "mp3": return isMp3(bytes);
    case "opus": return ascii(bytes, 0, 4) === "OggS" && ascii(bytes, 0, 128).includes("OpusHead");
    case "aac": return bytes.length > 7 && bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0;
    case "flac": return ascii(bytes, 0, 4) === "fLaC";
    case "pcm": return bytes.length > 0;
    default: return false;
  }
}

export function extensionFor(mime: string): string {
  return mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
}
