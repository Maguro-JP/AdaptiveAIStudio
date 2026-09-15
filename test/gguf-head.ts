/**
 * 本物の GGUF の頭を組む（テンソルは無し）。
 *
 * **偽のファイル（中身が "GGUF" だけ）で試すと、読む道を通らない。**
 * 通らなければ、読めていなくても既定に落ちて試験は通る。それでは
 * 何も確かめていない（実際に、そういう試験を書いていた）。
 */
export function ggufHead(kv: Record<string, number | string>): Buffer {
  const parts: Buffer[] = [];
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (v: string) => {
    const body = Buffer.from(v, 'utf8');
    return Buffer.concat([u64(body.length), body]);
  };
  parts.push(Buffer.from('GGUF', 'latin1'), u32(3), u64(0), u64(Object.keys(kv).length));
  for (const [key, value] of Object.entries(kv)) {
    parts.push(str(key));
    if (typeof value === 'string') parts.push(u32(8), str(value));
    else parts.push(u32(4), u32(value)); // UINT32
  }
  return Buffer.concat(parts);
}
