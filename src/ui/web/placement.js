/**
 * 置き方を選ぶ（docs/PLACEMENT.md の「置き方を選ぶ」）。設定のモデルの一覧と、モデルのパネルの両方から使う。
 *
 * 1 回押せば選べる。選んであるものと既定は、言葉で言う（色だけで伝えない）。「おまかせ」を押せば既定に戻る。
 * 押した結果は、押した場所の下に出す（`say`）。入らないモデルには、動く形（別の版）を先に出す。
 */
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

async function send(url, method, body) {
  try {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const got = await res.json().catch(() => ({}));
    return { ok: res.ok, body: got };
  } catch (e) {
    return { ok: false, body: { error: `繋がりませんでした（${e?.message ?? e}）` } };
  }
}

/**
 * 別の版（動く形）。一覧に在るものだけが届く。手元に無ければ「取ってくる」を 1 回押す。
 * `m.alternatives` が無ければ null。
 */
export function placementAlternatives(m, { say } = {}) {
  const list = Array.isArray(m.alternatives) ? m.alternatives : [];
  if (list.length === 0) return null;
  const box = el('div', 'placement-alternatives');
  for (const a of list) {
    const row = el('div', 'note placement-alternative');
    row.append(el('span', '', `動く形: ${a.line}`));
    if (a.downloaded) {
      row.append(el('span', 'dim', '（手元に在ります。一覧から選べます）'));
    } else {
      const get = el('button', 'ghost', `${a.id} を取ってくる`);
      get.type = 'button';
      get.onclick = async () => {
        get.disabled = true;
        get.textContent = `${a.id} を取得中…`;
        const r = await send('/api/models/get', 'POST', { id: a.id });
        if (!r.ok) {
          get.disabled = false;
          get.textContent = `${a.id} を取ってくる`;
        }
        say?.(r.ok ? `${a.id} を取ってきています。終わると一覧に出ます。` : (r.body.error || '取ってこられませんでした'), r.ok);
      };
      row.append(get);
    }
    box.append(row);
  }
  return box;
}

/**
 * 選べる置き方。2 つ以上あるときだけ出す（1 つなら選ぶものが無い）。
 * `onChange` は、選んだあとに一覧を描き直す。`say` は、結果の一行を出す。
 */
export function placementChoices(m, { onChange, say } = {}) {
  const options = Array.isArray(m.options) ? m.options : [];
  if (options.length < 2) return null;
  const group = el('div', 'placement-options');
  group.dataset.ref = m.ref ?? '';
  group.role = 'group';
  group.ariaLabel = `${m.ref} の置き方`;
  const picks = [];
  group.append(el('div', 'dim', '置き方（押すと選べます。「おまかせ」で既定に戻ります）'));
  for (const o of options) {
    const pick = el('button', `ghost placement-option${o.chosen ? ' chosen' : ''}`);
    pick.type = 'button';
    pick.dataset.option = o.id;
    pick.ariaPressed = o.chosen ? 'true' : 'false';
    picks.push(pick);
    const marks = `${o.isDefault ? '（既定）' : ''}${o.chosen ? '（選択中）' : ''}`;
    pick.append(el('span', 'placement-option-name', `${o.chosen ? '●' : '○'} ${o.label}${marks}`), el('span', 'placement-option-line', o.line));
    pick.onclick = async () => {
      if (o.chosen) { say?.(`いま「${o.label}」です。`, true); return; }
      for (const b of picks) b.disabled = true;
      const r = await send('/api/models/placement', 'PUT', { ref: m.ref, option: o.id });
      if (r.ok) await onChange?.();
      else for (const b of picks) b.disabled = false;
      say?.(r.ok ? `${m.ref}: ${r.body.note}${r.body.when}` : (r.body.error || '選べませんでした'), r.ok);
    };
    group.append(pick);
  }
  // 快適で、何も選んでいないモデルでは畳む（一覧を長くしない）。それ以外は、開かずに 1 回で押せるように出しておく
  if (m.fit === 'comfortable' && (m.chosen ?? 'auto') === 'auto') {
    const fold = el('details', 'placement-choose');
    fold.append(el('summary', '', `置き方を選ぶ（${options.length} 通り）`), group);
    return fold;
  }
  return group;
}
