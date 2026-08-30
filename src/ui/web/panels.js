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
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.placeholder = '指示を書く（Enter で送る）';
    const stop = el('button', '', '中断');
    stop.type = 'button';
    stop.disabled = true;
    form.append(input, stop);
    wrap.append(log, form);
    body.append(wrap);

    const line = (cls, text) => {
      const n = el('div', cls, text);
      log.append(n);
      log.scrollTop = log.scrollHeight;
      return n;
    };

    // 流れてくる本文は一つの行に足していく。途中で切らない。
    let stream = null;
    const append = (delta) => {
      if (!stream) stream = line('', '');
      stream.textContent += delta;
      log.scrollTop = log.scrollHeight;
    };

    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      stream = null;
      line('key', `> ${text}`);
      const r = await fetch('/api/send', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) line('bad', (await r.json()).error ?? '送れませんでした');
    };

    stop.onclick = () => fetch('/api/abort', { method: 'POST' });

    ctx.on('busy', (e) => {
      stop.disabled = !e.busy;
      input.placeholder = e.busy ? '作業中…' : '指示を書く（Enter で送る）';
      if (!e.busy) stream = null;
    });

    ctx.on('session', ({ event: v }) => {
      if (v.type === 'text') return append(v.delta);
      stream = null;
      if (v.type === 'toolStart') line('dim mono', `· ${v.name} ${v.summary}`);
      else if (v.type === 'toolEnd') line(v.ok ? 'dim mono' : 'bad mono', `  ${v.ok ? '✓' : '✗'} ${v.summary}`);
      else if (v.type === 'fallback') line('warn', `⤷ ${v.from} → ${v.to}（${v.reason}）`);
      else if (v.type === 'recalled') line('dim', v.text);
      else if (v.type === 'log') line(v.level === 'error' ? 'bad' : 'warn', v.text);
      else if (v.type === 'finished' && v.reason !== 'completed') {
        line('warn', `終了: ${v.reason}${v.detail ? ` — ${v.detail}` : ''}`);
      }
    });

    // 承認。押されるまで、向こう側は止まって待っている。
    ctx.on('approval', (e) => {
      const box = el('div', 'ask');
      const req = e.request;
      const what = req.kind === 'write' ? `${req.created ? '新規作成' : '変更'}: ${req.path}`
        : req.kind === 'command' ? `コマンド実行: ${req.command}`
        : `外部への問い合わせ: ${req.url}`;
      box.append(el('div', 'warn', what));
      if (req.kind === 'write' && req.diff) {
        const pre = el('pre', 'diff', req.diff);
        box.append(pre);
      }
      const yes = el('button', 'primary', '許可');
      const no = el('button', '', '拒否');
      const answer = (approved) => {
        fetch('/api/approve', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: e.id, approved }),
        });
        box.replaceChildren(el('div', approved ? 'good' : 'dim', `${what} → ${approved ? '許可' : '拒否'}`));
      };
      yes.onclick = () => answer(true);
      no.onclick = () => answer(false);
      const menu = el('div', 'ask-menu');
      menu.append(yes, no);
      box.append(menu);
      log.append(box);
      log.scrollTop = log.scrollHeight;
      // 別の口（端末など）で答えられたら、こちらは閉じる。
      ctx.on('approvalDone', (d) => {
        if (d.id === e.id && box.querySelector('button')) {
          box.replaceChildren(el('div', 'dim', `${what} → ${d.approved ? '許可' : '拒否'}`));
        }
      });
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
