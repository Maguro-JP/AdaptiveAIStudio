/**
 * マシン諸元の検出。
 *
 * 利用者に VRAM やモデルサイズを入力させない。
 * 分かることは自分で調べ、分からないことは安全側に倒す。
 */
import { spawn } from 'node:child_process';
import { totalmem } from 'node:os';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type MachineSpec, GB } from './spec.ts';
import { chunkReader } from '../core/text.ts';

export interface DetectedMachine extends MachineSpec {
  gpuName?: string;
  /** 帯域が実測ではなく推定値か。実測tok/sが溜まれば重要度は下がる。 */
  bandwidthEstimated: boolean;
}

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
  const gpu = await detectNvidia();

  if (!gpu) return { ...NO_GPU, ramBytes };

  return {
    ramBytes,
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

async function detectNvidia(): Promise<{ name: string; vramBytes: number } | undefined> {
  const out = await run('nvidia-smi', [
    '--query-gpu=name,memory.total', '--format=csv,noheader,nounits',
  ]);
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

function run(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args);
    } catch {
      return resolve(undefined);
    }
    let out = '';
    const read = chunkReader();
    child.stdout?.on('data', (b: Buffer) => { out += read(b); });
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => resolve(code === 0 ? out : undefined));
  });
}

/** 検出結果は毎回取らずキャッシュする。ハードは頻繁に変わらない。 */
export class MachineCache {
  readonly #path: string;
  constructor(path: string) { this.#path = path; }

  async get(): Promise<DetectedMachine> {
    try {
      return JSON.parse(await readFile(this.#path, 'utf8')) as DetectedMachine;
    } catch {
      const detected = await detectMachine();
      await mkdir(dirname(this.#path), { recursive: true }).catch(() => undefined);
      await writeFile(this.#path, JSON.stringify(detected, null, 2), 'utf8').catch(() => undefined);
      return detected;
    }
  }
}

export function describeMachine(m: DetectedMachine): string {
  const vram = m.vramBytes > 0
    ? `${m.gpuName ?? 'GPU'} ${(m.vramBytes / GB).toFixed(0)}GB`
    : 'GPUなし (CPU実行)';
  return `${vram} / RAM ${(m.ramBytes / GB).toFixed(0)}GB`;
}
