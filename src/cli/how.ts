/**
 * 打つ一手の書き方。**無いものを打てと言わない。**
 *
 * 配った形（portable も、setup.exe で入れた形も）に npm は入っていない。
 * 入口（`AdaptiveAIStudio.cmd`）が package.json をそのまま読んで同じ仕事を
 * 動かすので、呼び方だけが違う。
 *
 * ここは doctor の中に閉じていたので、clean は `npm run clean -- --yes` と
 * 書いたままだった。**配った形では、その一手が打てない。**
 * 「片づけられます」と言いながら、片づける道がどこにも無い形になっていた。
 */
import { isDistributed, installRoot } from '../core/home.ts';

/**
 * `root` は、どこに置かれているかを渡す口。**既定は自分の居場所。**
 * 渡せるようにしてあるのは、確かめるときに置かれ方を作れるようにするため
 * （渡せないと、走らせた場所の形でしか確かめられない）。
 */
export function how(task: string, args = '', root: string = installRoot()): string {
  if (isDistributed(root)) return `AdaptiveAIStudio.cmd ${task}${args ? ` ${args}` : ''}`;
  return `npm run ${task}${args ? ` -- ${args}` : ''}`;
}

/**
 * モデルが一つも無いときの案内（GGUF を読む道のとき）。打てる形で言う（配った形で `npm run models -- --get` と言っていた）。
 */
export function noModelsHint(root: string = installRoot()): string {
  return `  \`${how('models', '--get', root)}\` で取ってきます（まず動く軽いものが入ります）。\n`
    + `  一覧は \`${how('models', '--available', root)}\`。\n`
    + '  手持ちがあるなら、同じ置き場に .gguf を入れるだけでも使えます。';
}
