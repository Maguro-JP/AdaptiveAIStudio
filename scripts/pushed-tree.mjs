/**
 * 確かめた木と、押す木を、同じものにする。
 *
 * pre-push は**いまの作業の木**を確かめる。押されるのは、git が push の
 * 時点で読み直した**ref の先**。この二つは同じだと思い込んでいたが、違う。
 *
 * 実際にずれた。10 分の確かめが試験の段を終えたあと、その裏で次の作業を
 * commit した。確かめは前の木を見たまま「通りました」と言い、push は
 * 新しい commit を出した。**一度も試験を通っていないものが、通った顔で外に出た。**
 *
 * ずれ方は三つある。どれも「確かめの結果が、出した物を説明していない」。
 *
 *   ・作業の木が汚れている（commit していない直しを確かめて、commit 済みを押す）
 *   ・押す先が、いま出ているブランチではない（別の木を確かめている）
 *   ・確かめている最中に HEAD が動いた（上のやつ）
 *
 * 確かめの側が嘘をつくと、確かめを迂回する癖がつく。ここで止める。
 */

/** 木の状態。`head` は HEAD の sha、`dirty` は git status --porcelain の行。 */
/**
 * 止める理由を返す。止めなくてよければ undefined。
 *
 * @param {{
 *   sending: string,
 *   before: { head: string, dirty: readonly string[] },
 *   after: { head: string, dirty: readonly string[] },
 * }} push
 *   sending 押す先の sha（git が pre-push へ渡す local_sha）
 *   before  確かめを始める前の木
 *   after   確かめが終わった後の木
 * @returns {string | undefined}
 */
export function pushedTree(push) {
  const { sending, before, after } = push;

  if (before.dirty.length > 0) {
    return `commit していない直しが ${before.dirty.length} 件あります。\n`
      + `${list(before.dirty)}\n`
      + 'このまま押すと、確かめるのはこの直しを含む木で、出るのは commit 済みの木です。\n'
      + '  ・commit してから押す\n'
      + '  ・git stash で退けてから押す\n'
      + '  ・出さないものなら .gitignore に足す';
  }

  /*
   * 押す先と HEAD を突き合わせる。**突き合わせられるときだけ。**
   *
   * タグを押すときの sha は commit ではない（タグの object）。HEAD と比べると
   * 必ず食い違うので、`v*` のタグで release を出す道が丸ごと塞がる。
   * 突き合わせるのはブランチを押すときだけにして、呼ぶ側が渡さないときは飛ばす。
   * 汚れているか・動いたかは、タグでも見る（確かめる木は同じ）。
   */
  if (comparable(sending) && before.head !== sending) {
    return `押す先（${short(sending)}）が、いま出ている HEAD（${short(before.head)}）と違います。\n`
      + '確かめるのはいま出ている木なので、押す物を確かめたことになりません。\n'
      + '  ・押すブランチを git switch で出してから押す';
  }

  return treeMoved(before, after);
}

/**
 * 確かめている間に、木が変わったか。
 *
 * push の手前だけでなく、`npm run check` を直に回したときも要る。あちらは
 * **汚れていても回す**（回さないと何も確かめられない）ので、汚れそのものを
 * 止める条件と、動いたことを言う条件は分けておく。
 *
 * @param {{ head: string, dirty: readonly string[] }} before
 * @param {{ head: string, dirty: readonly string[] }} after
 * @returns {string | undefined}
 */
export function treeMoved(before, after) {
  if (after.head !== before.head) {
    return `確かめている間に HEAD が動きました（${short(before.head)} → ${short(after.head)}）。\n`
      + `確かめたのは ${short(before.head)} の木で、出るのは ${short(after.head)} です。\n`
      + '  ・もう一度回す（今度は動かした後の木を確かめます）';
  }

  // 数ではなく中身で見る。一つ片付いて一つ汚れると、数は同じまま木が変わる。
  const grew = after.dirty.filter((l) => !before.dirty.includes(l));
  if (grew.length > 0) {
    return `確かめている間に、commit していない直しが ${grew.length} 件増えました。\n`
      + `${list(grew)}\n`
      + '確かめの途中で木が変わっているので、結果がどちらの木の話か決まりません。\n'
      + '  ・もう一度回す（今度は止まったところから確かめ直します）';
  }

  return undefined;
}

/** 突き合わせられる sha か。空と、消す push の全部 0 は比べない。 */
function comparable(sha) {
  return Boolean(sha) && !/^0+$/.test(sha);
}

function short(sha) {
  return String(sha).slice(0, 7);
}

/** 多いときは切る。全部並べると、肝心の一行目が流れる。 */
function list(lines) {
  const show = lines.slice(0, 10).map((l) => `    ${l}`);
  if (lines.length > show.length) show.push(`    ほか ${lines.length - show.length} 件`);
  return show.join('\n');
}
