/**
 * マシン諸元の検出。
 *
 * 利用者に VRAM やモデルサイズを入力させない。
 * 分かることは自分で調べ、分からないことは安全側に倒す。
 */
import { spawn } from 'node:child_process';
import { totalmem } from 'node:os';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type MachineSpec, GB } from './spec.ts';
import { chunkReader } from '../core/text.ts';

export interface DetectedMachine extends MachineSpec {
  gpuName?: string;
  /** 帯域が実測ではなく推定値か。実測tok/sが溜まれば重要度は下がる。 */
  bandwidthEstimated: boolean;
  /** 検出した時刻。古い検出結果は取り直す（後から入れた GPU のドライバ・足した RAM を拾う）。 */
  detectedAt?: number;
  /** GPU を調べ切れなかった（nvidia-smi が時間内に返らなかった）。「GPU なし」と決まったわけではないので、記録に残さない。 */
  gpuUnsure?: true;
}

/** 検出結果を使い続ける長さ。 */
const MACHINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** GPUが無い/検出できない場合の保守的な既定。 */
const NO_GPU: Omit<DetectedMachine, 'ramBytes'> = {
  vramBytes: 0,
  ramBandwidthBytesPerSec: 40 * GB,
  vramBandwidthBytesPerSec: 0,
  diskBandwidthBytesPerSec: 1 * GB,
  bandwidthEstimated: true,
};

export async function detectMachine(): Promise<DetectedMachine> {
  const ramBytes = totalmem();
  const detectedAt = Date.now();
  const gpu = await detectNvidia();

  if (gpu === 'timeout') return { ...NO_GPU, ramBytes, detectedAt, gpuUnsure: true };
  if (!gpu) return { ...NO_GPU, ramBytes, detectedAt };

  return {
    ramBytes,
    detectedAt,
    vramBytes: gpu.vramBytes,
    gpuName: gpu.name,
    // 世代ごとの実測帯域は持たない。名前から概算し、
    // 実測tok/sが溜まればそちらが優先される。
    vramBandwidthBytesPerSec: estimateVramBandwidth(gpu.name),
    ramBandwidthBytesPerSec: estimateRamBandwidth(ramBytes),
    diskBandwidthBytesPerSec: 2 * GB,
    bandwidthEstimated: true,
  };
}

async function detectNvidia(): Promise<{ name: string; vramBytes: number } | 'timeout' | undefined> {
  const { out, timedOut } = await probe('nvidia-smi', [
    '--query-gpu=name,memory.total', '--format=csv,noheader,nounits',
  ]);
  if (timedOut) return 'timeout';
  if (out === undefined) return undefined;
  const line = out.split('\n')[0]?.trim();
  if (!line) return undefined;
  const [name, mb] = line.split(',').map((s) => s.trim());
  const megabytes = Number(mb);
  if (!name || !Number.isFinite(megabytes)) return undefined;
  return { name, vramBytes: megabytes * 1024 * 1024 };
}

/** 世代の大まかな区分のみ。精度より「外さないこと」を優先する。 */
function estimateVramBandwidth(name: string): number {
  const n = name.toLowerCase();
  if (/50[789]0|4090|4080/.test(n)) return 800 * GB;
  if (/4070|3080|3090/.test(n)) return 500 * GB;
  if (/4060|3070|3060/.test(n)) return 272 * GB;
  if (/3050|2060|1660/.test(n)) return 200 * GB;
  return 200 * GB;
}

/** 容量から世代を推測する。DDR5世代は容量が大きい傾向という弱い仮定。 */
function estimateRamBandwidth(ramBytes: number): number {
  return ramBytes >= 32 * GB ? 70 * GB : 45 * GB;
}

/**
 * 命令を走らせて出力を取る。**時間切れで打ち切る**（`environment.ts` と同じ 5 秒）。ドライバが固まって nvidia-smi が返らないと、
 * 検出を待つ送信の前処理ごと止まり、送った依頼が全部順番待ちのまま・■も効かない、になっていた。
 */
export function runProbe(cmd: string, args: string[], timeoutMs = 5000): Promise<string | undefined> {
  return probe(cmd, args, timeoutMs).then((r) => r.out);
}

/** `runProbe` と同じ。時間切れだったかも返す（「無い」と「調べ切れなかった」を分けるため）。 */
function probe(cmd: string, args: string[], timeoutMs = 5000): Promise<{ out?: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args);
    } catch {
      return resolve({ timedOut: false });
    }
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve({ timedOut: true }); }, timeoutMs);
    const read = chunkReader();
    child.stdout?.on('data', (b: Buffer) => { out += read(b); });
    child.on('error', () => { clearTimeout(timer); resolve({ timedOut: false }); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? { out, timedOut: false } : { timedOut: false }); });
  });
}

let tmpSeq = 0;

/** 調べ切れなかった結果を、このプロセスの中で使い回す長さ。 */
const UNSURE_REUSE_MS = 10 * 60 * 1000;
const unsureFor = new Map<string, { machine: DetectedMachine; at: number }>();

/** 検出結果は毎回取らずキャッシュする。ハードは頻繁に変わらない。 */
export class MachineCache {
  readonly #path: string;
  readonly #detect: () => Promise<DetectedMachine>;
  readonly #now: () => number;
  /** 試験では、検出と時刻を入れ替える。 */
  constructor(path: string, opts: { detect?: () => Promise<DetectedMachine>; now?: () => number } = {}) {
    this.#path = path;
    this.#detect = opts.detect ?? detectMachine;
    this.#now = opts.now ?? Date.now;
  }

  async get(): Promise<DetectedMachine> {
    try {
      const got = JSON.parse(await readFile(this.#path, 'utf8')) as unknown;
      // 形を確かめる。`null` で doctor が落ち、`{}` で「RAM NaNGB」のまま使っていた。違えば検出し直して書き直す。
      // 一度書いたら取り直さなかったので、後から入れた GPU のドライバや足した RAM を拾えなかった。
      // RAM が今と違う・検出から 7 日を過ぎた・検出した時刻が無い（前の版の記録）なら取り直す
      if (isMachine(got) && got.ramBytes === totalmem() && got.detectedAt !== undefined
        && this.#now() - got.detectedAt < MACHINE_TTL_MS && this.#now() >= got.detectedAt) return got;
    } catch { /* 無い・壊れている。下で検出し直す */ }
    // 調べ切れなかった結果は、このプロセスの中でしばらく使い回す（呼ばれるたびに 5 秒待たせない）
    const recent = unsureFor.get(this.#path);
    if (recent && this.#now() - recent.at < UNSURE_REUSE_MS && this.#now() >= recent.at) return recent.machine;
    const detected = await this.#detect();
    // GPU を調べ切れなかった結果はファイルに残さない（「GPU なし」を次からも使い続けない）。しばらくしたら調べ直す
    if (detected.gpuUnsure) {
      unsureFor.set(this.#path, { machine: detected, at: this.#now() });
      return detected;
    }
    unsureFor.delete(this.#path);
    await mkdir(dirname(this.#path), { recursive: true }).catch(() => undefined);
    // 一時ファイルに書いてから置き換える（書きかけで落ちると、壊れた検出結果が残る）。
    const tmp = `${this.#path}.${process.pid}.${++tmpSeq}.tmp`; // 同じプロセスで並んで呼ばれても名前をぶつけない
    await writeFile(tmp, JSON.stringify(detected, null, 2), 'utf8')
      .then(() => rename(tmp, this.#path))
      .catch(() => rm(tmp, { force: true }).catch(() => undefined));
    return detected;
  }
}

/** 検出結果の形。数は有限で 0 以上。 */
function isMachine(v: unknown): v is DetectedMachine {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  const count = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  return count(m.vramBytes) && count(m.ramBytes) && m.ramBytes as number > 0
    && count(m.ramBandwidthBytesPerSec) && count(m.vramBandwidthBytesPerSec)
    && (m.diskBandwidthBytesPerSec === undefined || count(m.diskBandwidthBytesPerSec))
    && typeof m.bandwidthEstimated === 'boolean'
    && (m.gpuName === undefined || typeof m.gpuName === 'string')
    && (m.detectedAt === undefined || (typeof m.detectedAt === 'number' && Number.isFinite(m.detectedAt)));
}

export function describeMachine(m: DetectedMachine): string {
  const vram = m.vramBytes > 0
    ? `${m.gpuName ?? 'GPU'} ${(m.vramBytes / GB).toFixed(0)}GB`
    : 'GPUなし (CPU実行)';
  return `${vram} / RAM ${(m.ramBytes / GB).toFixed(0)}GB`;
}
