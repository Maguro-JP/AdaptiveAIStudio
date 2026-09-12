/**
 * 道の隣に置く「開く」「コピー」。
 *
 * 道は画面に出ていたが、それを開いて確かめる手が無く、打ち直すか貼り直すかしか
 * 無かった。開くのは本体（/api/open。このプログラムが使っている場所の中だけ）、
 * コピーはブラウザのクリップボード。
 *
 * `deps` は試験のためのもの。本物のブラウザ無しで押せるように、開く先と
 * コピーの手を差し込める。
 */
export function pathActions(path, deps = {}) {
  const box = document.createElement('span');
  box.className = 'path-actions';
  if (!path) return box;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'ghost tiny';
  open.textContent = '開く';
  open.title = `開く: ${path}`;
  open.onclick = async () => {
    const post = deps.open ?? ((p) => fetch('/api/open', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }),
    }).then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) })));
    const r = await post(path).catch((e) => ({ ok: false, body: { error: String(e?.message ?? e) } }));
    if (!r.ok) (deps.say ?? ((m) => window.alert(m)))(r.body?.error ?? '開けませんでした');
  };

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'ghost tiny';
  copy.textContent = 'コピー';
  copy.title = `コピー: ${path}`;
  copy.onclick = async () => {
    const write = deps.copy ?? ((t) => navigator.clipboard.writeText(t));
    try {
      await write(path);
      copy.textContent = 'コピーした';
    } catch {
      copy.textContent = 'コピーできない';
    }
    setTimeout(() => { copy.textContent = 'コピー'; }, 1200);
  };

  box.append(open, copy);
  return box;
}
