/**
 * 中身の作り方を、名前ごとに一つずつ。
 *
 * ここに関数を足せば、置ける中身が増える。
 * 増やすときに他を触らなくていいことが、いじりやすさになる。
 */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const empty = (text) => el('div', 'empty', text);

function rows(items, render) {
  const box = document.createElement('div');
  for (const item of items) box.appendChild(render(item));
  return box;
}

export const PANELS = {
  conversation(body, ctx) {
    const wrap = el('div', 'chat');
    const log = el('div', 'log');
    log.appendChild(el('div', 'dim',
      'ここからの指示出しはまだ繋がっていません。いまは CLI（npm run agent）から動かしてください。'));
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.placeholder = '指示を書く（未接続）';
    input.disabled = true;
    form.append(input);
    wrap.append(log, form);
    body.append(wrap);
    ctx.on('log', (e) => {
      log.appendChild(el('div', e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : '', e.text));
      log.scrollTop = log.scrollHeight;
    });
  },

  plan(body, ctx) {
    const render = (items) => {
      body.replaceChildren();
      if (!items || items.length === 0) return body.append(empty('進行中の作業はありません。'));
      body.append(rows(items, (t) => {
        const r = el('div', 'row');
        r.append(el('span', 'key mono', t.id ?? '?'), el('span', '', t.instruction ?? ''),
          el('span', 'dim', t.roleId ?? ''));
        return r;
      }));
    };
    render(null);
    ctx.on('plan', (e) => render(e.items));
  },

  roster(body, ctx) {
    ctx.onState((s) => {
      body.replaceChildren();
      const live = s.roles.filter((r) => !r.retired);
      body.append(rows(live, (r) => {
        const row = el('div', 'row');
        row.append(el('span', 'key mono', r.codename), el('span', '', r.name),
          el('span', 'dim', r.access.join('/')));
        row.title = r.disposition;
        return row;
      }));
      const gone = s.roles.filter((r) => r.retired);
      if (gone.length > 0) {
        body.append(el('div', 'dim', '引き継ぎ済み'));
        body.append(rows(gone, (r) => el('div', 'row dim',
          `${r.codename} → ${(r.succeededBy ?? []).join(', ') || '(未設定)'}`)));
      }
    });
  },

  memory(body, ctx) {
    const LABEL = {
      decision: '決めたこと', attempt: '試したこと', fact: '分かったこと',
      preference: '好み', incident: '起きたこと',
    };
    ctx.onState((s) => {
      body.replaceChildren();
      if (s.memory.length === 0) return body.append(empty('まだ何も覚えていません。'));
      body.append(rows(s.memory, (m) => {
        const row = el('div', 'row');
        const trust = m.confirms >= 3 ? '確か' : m.confirms === 2 ? 'おそらく' : '一度だけ';
        row.append(
          el('span', 'key', `[${LABEL[m.kind] ?? m.kind}/${trust}]`),
          el('span', m.supersededBy ? 'dim' : '', m.title),
        );
        if (m.outcome === 'failed') row.append(el('span', 'bad', '失敗'));
        if (m.detail) row.title = m.detail;
        return row;
      }));
      body.append(el('div', 'dim', `全 ${s.memorySize} 件`));
    });
  },

  proposals(body, ctx) {
    ctx.onState((s) => {
      body.replaceChildren();
      const open = (s.proposals ?? []).filter((p) => p.state === 'open' || !p.state);
      if (open.length === 0) return body.append(empty('未処理の提案はありません。'));
      body.append(rows(open, (p) => {
        const row = el('div', 'row');
        row.append(el('span', 'key mono', p.id ?? ''), el('span', '', p.title ?? ''));
        if (p.rationale) row.title = p.rationale;
        return row;
      }));
    });
  },

  duties(body, ctx) {
    ctx.onState((s) => {
      body.replaceChildren();
      if (!s.duties || s.duties.length === 0) return body.append(empty('日課の記録はまだありません。'));
      body.append(rows(s.duties, (d) => {
        const row = el('div', 'row');
        const when = d.lastRunAt ? new Date(d.lastRunAt).toLocaleString('ja-JP') : '未実施';
        row.append(el('span', 'key mono', d.dutyId ?? d.id ?? ''), el('span', 'dim', when));
        return row;
      }));
    });
  },

  models(body, ctx) {
    ctx.onState((s) => {
      body.replaceChildren();
      if (!s.models || s.models.length === 0) return body.append(empty('まだ実測がありません。'));
      body.append(rows(s.models, (m) => {
        const row = el('div', 'row');
        const tps = typeof m.tokensPerSecond === 'number' ? `${m.tokensPerSecond.toFixed(1)} tok/s` : '';
        row.append(el('span', 'key mono', m.modelId ?? m.id ?? ''), el('span', 'dim', tps));
        return row;
      }));
    });
  },

  log(body, ctx) {
    body.append(el('div', 'dim', '動いているものがここに流れます。'));
    ctx.on('log', (e) => {
      body.appendChild(el('div', e.level === 'error' ? 'bad mono' : e.level === 'warn' ? 'warn mono' : 'mono', e.text));
      while (body.childNodes.length > 500) body.removeChild(body.firstChild);
      body.scrollTop = body.scrollHeight;
    });
  },

  note(body, _ctx, spec) {
    body.append(el('div', 'dim', String(spec.options?.text ?? '（覚え書き）')));
  },
};

export const TITLES = {
  conversation: '会話', plan: '進行中', roster: '人員', memory: '記憶',
  proposals: '提案', duties: '日課', models: 'モデル', log: '流れ', note: '覚え書き',
};
