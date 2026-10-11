function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return bytes;
}

function encodeLengthDelimited(field: number, payload: Uint8Array): Uint8Array {
  const tag = (field << 3) | 2;
  return Uint8Array.from([...encodeVarint(tag), ...encodeVarint(payload.length), ...payload]);
}

/** Encode RemoteAppLinkLaunchRequest (RemoteMessage field 90). */
export function encodeAppLinkLaunchMessage(appLink: string): Uint8Array {
  const trimmed = appLink.trim();
  if (!trimmed) {
    throw new Error('App link is empty.');
  }

  const linkBytes = new TextEncoder().encode(trimmed);
  const inner = encodeLengthDelimited(1, linkBytes);
  return encodeLengthDelimited(90, inner);
}
