/**
 * 役職 — この世界に住まわせるAIの定義。
 *
 * 重要なのは肩書きではなく**気質**。
 * 同じツールを渡しても、手順どおり確かめる真面目な検査役と、
 * わざと誤った使い方を試す捻くれた破壊役では、見つけるものが違う。
 *
 * 一人の優秀なAIより、気質の違う数人の方が広く拾える。
 * ローカルは計算が無料なので、人数を増やす代償がほとんどない。
 *
 * 役職は3つの要素で決まる。
 *   責務   何をする人か
 *   気質   どういう態度で臨むか  ← ここが効く
 *   権限   何ができるか（プロンプトではなくツールの割り当てで決める）
 */

export type ToolAccess = 'read' | 'write' | 'execute';

export interface Role {
  id: string;
  /**
   * 呼び名。役職ではなく「その人」を指す名前。
   * 肩書きで呼ぶと機能に見えるが、名前で呼ぶと人に見える。
   * 社会として動かすなら、後者の方が正しい。
   */
  codename: string;
  name: string;
  /** 何をする人か */
  responsibility: string;
  /**
   * どういう態度で臨むか。
   * ここがそのまま出力の質を変えるので、抽象的な美辞麗句は書かない。
   */
  disposition: string;
  /**
   * 持たせる権限。禁じるのではなく、渡さないことで守る。
   *   read    読む・探す
   *   write   書き換える
   *   execute コマンドを実行する
   */
  access: ToolAccess[];
  /** 具体的な指示。気質を行動に落とす。 */
  instructions: string[];
  /** 出力の形式。守らせたい形があるなら明記する。 */
  outputContract?: string;
  /** この役職に向くモデルの性質。自動選択の手がかり。 */
  prefers?: 'strong' | 'fast' | 'any';
}

/** 役職からシステムプロンプトを組み立てる。 */
export function buildSystemPrompt(role: Role): string {
  const lines = [
    `あなたは ${role.codename}（${role.name}）です。`,
    '',
    `## 責務`,
    role.responsibility,
    '',
    `## 姿勢`,
    role.disposition,
    '',
    `## 具体的な進め方`,
    ...role.instructions.map((i) => `- ${i}`),
  ];

  if (!role.access.includes('write')) {
    lines.push('', '書き込みツールは渡されていません。調べて報告するのが仕事です。');
  }
  if (role.outputContract) {
    lines.push('', '## 出力の形式', role.outputContract);
  }
  return lines.join('\n');
}
