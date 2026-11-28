/**
 * 選んだ置き方を覚える（docs/PLACEMENT.md の「置き方を選ぶ」）。
 *
 * モデルごとに一つ。`auto`（おまかせ）に戻すと、覚えを消す。置く所は AAS_HOME のデータの下の `placement-choices.json`。
 * 画面のプロセス（選ぶ側）と、モデルを読むプロセス（使う側）の両方が読むので、読むたびにファイルを見る（持ち回らない）。
 * 壊れていたら脇へ移し、何も選んでいないものとして読む（読み込みを止めない）。在るのに読めないときは、上書きしない（`journal-file.ts`）。
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stateDir } from '../core/home.ts';
import { readJournal, writeWhole } from '../core/journal-file.ts';
import { isOptionId, type OptionId } from './placement.ts';

export function choicesFile(dir: string = stateDir()): string {
  return join(dir, 'placement-choices.json');
}

export async function readChoices(dir?: string): Promise<Record<string, OptionId>> {
  const r = await readJournal(choicesFile(dir));
  return r.kind === 'value' ? choicesOf(r.value) : {};
}

function choicesOf(raw: unknown): Record<string, OptionId> {
  const choices = (raw as { choices?: unknown } | null)?.choices;
  if (!choices || typeof choices !== 'object') return {};
  const out: Record<string, OptionId> = {};
  for (const [ref, id] of Object.entries(choices as Record<string, unknown>)) {
    if (isOptionId(id) && id !== 'auto') out[ref] = id;
  }
  return out;
}

/** そのモデルに選んである置き方。選んでいなければ `auto`。 */
export async function chosenOption(ref: string, dir?: string): Promise<OptionId> {
  return (await readChoices(dir))[ref] ?? 'auto';
}

/** 選ぶ。`auto` は覚えを消す（既定に戻す）。 */
export async function setChoice(ref: string, id: OptionId, dir?: string): Promise<void> {
  const file = choicesFile(dir);
  const r = await readJournal(file);
  // 在るのに読めない（掴まれている・権限）ときは、ほかのモデルの選択を消さないよう、書かずに言う
  if (r.kind === 'unreadable') throw new Error('選んだ置き方の記録を読めないので、書き換えませんでした（少し待って、もう一度押してください）');
  const choices = r.kind === 'value' ? choicesOf(r.value) : {};
  if (id === 'auto') delete choices[ref];
  else choices[ref] = id;
  await mkdir(dirname(file), { recursive: true });
  if (!(await writeWhole(file, `${JSON.stringify({ version: 1, choices }, null, 2)}\n`))) throw new Error('選んだ置き方を保存できませんでした');
}
