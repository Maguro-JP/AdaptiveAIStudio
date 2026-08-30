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

/**
 * 一覧。
 *
 * 列は必ず揃える。行ごとに幅が動くと、読むたびに目が探し直すことになる。
 * 揃えるのは好みではなく、読み取りの速さの問題。
 * subgrid を使って、行の中の列を一覧全体で共有する。
 */
function rows(items, render, columns = 3) {
  const box = document.createElement('div');
  box.className = 'rows';
  box.dataset.cols = String(columns);
  for (const item of items) {
    const row = render(item);
    // 足りない列は空で埋める。埋めないと、次の行がずれる。
    while (row.children.length < columns) row.appendChild(el('span'));
    box.appendChild(row);
  }
  return box;
}

export const PANELS = {
  conversation(body, ctx) {
    const wrap = el('div', 'chat');
    const log = el('div', 'log');
    const form = document.createElement('form');
    const input = document.createElement('input');
    input.placeholder = '指示を書く（/plan で分解して並列実行）';
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
      // 「/plan 〜」と書けば、分解して複数人で当たる。
      const isPlan = text.startsWith('/plan');
      const r = await fetch(isPlan ? '/api/plan' : '/api/send', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: isPlan ? text.slice('/plan'.length).trim() : text }),
      });
      if (!r.ok) line('bad', (await r.json()).error ?? '送れませんでした');
    };

    stop.onclick = () => fetch('/api/abort', { method: 'POST' });

    ctx.on('busy', (e) => {
      stop.disabled = !e.busy;
      input.placeholder = e.busy ? '作業中…' : '指示を書く（/plan で分解して並列実行）';
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
      else if (v.type === 'baseline') {
        line('dim', `作業前の状態: ${v.command} → ${v.passed ? '通っています' : '作業前から失敗しています'}`);
      } else if (v.type === 'rolledBack') {
        line('warn', `変更を巻き戻しました: ${v.paths.join(', ')}`);
      } else if (v.type === 'verify') {
        const e = v.event;
        if (e.type === 'running') line('dim', `検証 ${e.round}回目: ${e.command}`);
        else if (e.type === 'passed') line('good', `✓ 検証を通過しました (${(e.durationMs / 1000).toFixed(1)}s)`);
        else if (e.type === 'failed') {
          line('warn', `✗ 検証に失敗（${e.round}回目）`);
          line('dim mono', e.digest.split('\n').slice(-6).join('\n'));
        } else if (e.type === 'preexisting') {
          line('warn', 'この失敗は作業前から出ています。今回の作業が原因ではありません。');
        } else if (e.type === 'tampered') line('bad', `✗ ${e.reason}`);
        else if (e.type === 'fixing') line('dim', '修正させています…');
        else if (e.type === 'giveUp') line('warn', `検証を打ち切りました — ${e.detail}`);
      } else if (v.type === 'settled') {
        const mark = v.reason === 'completed' && v.verified ? 'good' : 'warn';
        line(mark, `${v.reason === 'completed' ? '完了' : v.reason}`
          + `${v.verified ? '' : '（検証は通っていません）'} (${v.seconds.toFixed(1)}s)`);
      } else if (v.type === 'finished' && v.reason !== 'completed') {
        line('warn', `終了: ${v.reason}${v.detail ? ` — ${v.detail}` : ''}`);
      }
    });

    ctx.on('planEvent', ({ event: v }) => {
      stream = null;
      if (v.type === 'planned') {
        line('key', `方針: ${v.plan.summary}`);
        for (const t of v.plan.items) {
          const wait = (t.deps ?? []).length > 0 ? ` ← ${t.deps.join(', ')} の後` : '（すぐ着手）';
          line('dim', `  [${t.id}] ${t.roleId} @${t.laneId}${wait} ${t.instruction.split('\n')[0]}`);
        }
      } else if (v.type === 'planRepaired') line('warn', `計画を直しました: ${v.detail}`);
      else if (v.type === 'baselineFailed') line('warn', '作業前から検査が失敗しています。切り分けて見ます。');
      else if (v.type === 'taskStart') line('', `▶ ${v.taskId} 着手 @${v.laneId}`);
      else if (v.type === 'taskEnd') {
        line(v.state === 'done' ? 'good' : 'bad',
          `${v.state === 'done' ? '✓' : '✗'} ${v.taskId} (${Math.round(v.ms / 1000)}s)${v.error ? ` ${v.error}` : ''}`);
      } else if (v.type === 'taskSkip') line('warn', `− ${v.taskId} 未実施: ${v.reason}`);
      else if (v.type === 'work') line(v.ok ? 'dim mono' : 'bad mono', `  [${v.taskId}] ${v.text}`);
      else if (v.type === 'verifying') line('dim', `検査: ${v.command}`);
      else if (v.type === 'accepted') {
        const r = v.report;
        const cls = r.verdict === 'accepted' ? 'good' : r.verdict === 'rejected' ? 'bad' : 'warn';
        const label = { accepted: '受け取りました', needsHuman: '判断をお願いします', rejected: '受け取れません' };
        line(cls, `検収: ${label[r.verdict] ?? r.verdict}`);
        const done = r.members.filter((m) => m.state === 'done').length;
        line('dim', `  作業: ${done}/${r.members.length}件完了 / 検査: ${r.verified} / 変更: ${r.changed.length}件`);
        for (const f of r.changed.slice(0, 10)) line('dim mono', `    ${f}`);
        if (r.concerns.length === 0) line('dim', '  指摘はありません。');
        for (const con of r.concerns) {
          line(con.severity === 'block' ? 'bad' : 'warn',
            `  [${con.severity === 'block' ? '要対応' : '確認'}] ${con.reason}`);
          for (const w of (con.where ?? []).slice(0, 5)) line('dim', `      ${w}`);
        }
      }
      else if (v.type === 'recalled') line('dim', v.text);
      else if (v.type === 'log') line('bad', v.text);
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
    /** 進行中の件。状態は出来事から組み立てる。画面は覚えない。 */
    let items = new Map();

    const draw = () => {
      body.replaceChildren();
      if (items.size === 0) return body.append(empty('進行中の作業はありません。'));
      body.append(rows([...items.values()], (t) => {
        const row = el('div', 'row');
        const mark = { running: '▶', done: '✓', failed: '✗', skipped: '−', waiting: '·' }[t.state];
        const cls = t.state === 'done' ? 'good' : t.state === 'failed' ? 'bad'
          : t.state === 'skipped' ? 'warn' : t.state === 'running' ? '' : 'dim';
        row.append(
          el('span', `key mono ${cls}`, `${mark} ${t.id}`),
          el('span', t.state === 'waiting' ? 'dim' : '', t.instruction),
          el('span', 'dim', t.roleId),
        );
        row.title = t.note ?? t.instruction;
        return row;
      }));
    };

    draw();
    ctx.on('planEvent', ({ event: v }) => {
      if (v.type === 'planned') {
        items = new Map(v.plan.items.map((t) => [t.id, {
          id: t.id, roleId: t.roleId, state: 'waiting',
          instruction: t.instruction.split('\n')[0],
        }]));
      } else if (v.type === 'taskStart') {
        const t = items.get(v.taskId);
        if (t) t.state = 'running';
      } else if (v.type === 'taskEnd') {
        const t = items.get(v.taskId);
        if (t) { t.state = v.state === 'done' ? 'done' : 'failed'; t.note = v.error; }
      } else if (v.type === 'taskSkip') {
        const t = items.get(v.taskId);
        if (t) { t.state = 'skipped'; t.note = v.reason; }
      } else return;
      draw();
    });
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
        body.append(rows(gone, (r) => {
          const row = el('div', 'row dim');
          row.append(el('span', 'key mono', r.codename),
            el('span', '', `→ ${(r.succeededBy ?? []).join(', ') || '(未設定)'}`));
          return row;
        }, 2));
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
          el('span', 'key', `${LABEL[m.kind] ?? m.kind} / ${trust}`),
          el('span', m.supersededBy ? 'dim' : '', m.title),
          el('span', m.outcome === 'failed' ? 'bad' : 'dim', m.outcome === 'failed' ? '失敗' : ''),
        );
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
      }, 2));
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
      }, 2));
    });
  },

  models(body, ctx) {
    ctx.onState((s) => {
      body.replaceChildren();
      if (!s.models || s.models.length === 0) return body.append(empty('まだ実測がありません。'));
      body.append(rows(s.models, (m) => {
        const row = el('div', 'row');
        const tps = typeof m.tokensPerSecond === 'number' ? `${m.tokensPerSecond.toFixed(1)} tok/s` : '';
        row.append(el('span', 'key mono', m.modelId ?? m.id ?? ''), el('span', 'num dim', tps));
        return row;
      }, 2));
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
