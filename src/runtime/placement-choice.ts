/**
 * 選んだ置き方を覚える（docs/PLACEMENT.md の「置き方を選ぶ」）。
 *
 * モデルごとに一つ。`auto`（おまかせ）に戻すと、覚えを消す。置く所は AAS_HOME のデータの下の `placement-choices.json`。
 * 画面のプロセス（選ぶ側）と、モデルを読むプロセス（使う側）の両方が読むので、読むたびにファイルを見る（持ち回らない）。
 * 壊れていたら、何も選んでいないものとして読む（読み込みを止めない）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stateDir } from '../core/home.ts';
import { isOptionId, type OptionId } from './placement.ts';

export function choicesFile(dir: string = stateDir()): string {
  return join(dir, 'placement-choices.json');
}

export async function readChoices(dir?: string): Promise<Record<string, OptionId>> {
  try {
    const raw: unknown = JSON.parse(await readFile(choicesFile(dir), 'utf8'));
    const choices = (raw as { choices?: unknown } | null)?.choices;
    if (!choices || typeof choices !== 'object') return {};
    const out: Record<string, OptionId> = {};
    for (const [ref, id] of Object.entries(choices as Record<string, unknown>)) {
      if (isOptionId(id) && id !== 'auto') out[ref] = id;
    }
    return out;
  } catch { return {}; }
}

/** そのモデルに選んである置き方。選んでいなければ `auto`。 */
export async function chosenOption(ref: string, dir?: string): Promise<OptionId> {
  return (await readChoices(dir))[ref] ?? 'auto';
}

/** 選ぶ。`auto` は覚えを消す（既定に戻す）。 */
export async function setChoice(ref: string, id: OptionId, dir?: string): Promise<void> {
  const choices = await readChoices(dir);
  if (id === 'auto') delete choices[ref];
  else choices[ref] = id;
  const file = choicesFile(dir);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, choices }, null, 2)}\n`);
  await rename(tmp, file);
}
