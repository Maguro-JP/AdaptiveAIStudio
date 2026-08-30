/**
 * 中身の作り方を、名前ごとに一つずつ。
 *
 * ここに関数を足せば、置ける中身が増える。
 * 増やすときに他を触らなくていいことが、いじりやすさになる。
 */

import { renderDiff } from './diff.js';

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
  /**
   * 会話。
   *
   * 端末の流れをそのまま写さない。それなら端末で足りる。
   * 起きたことを**札**にして、種類ごとに形を変える。
   * 道具の呼び出しは畳んでおき、書き換えは差分そのものを出す。
   */
  conversation(body, ctx) {
    const wrap = el('div', 'chat');
    const log = el('div', 'log');
    const form = document.createElement('form');
    const field = el('div', 'field');
    const input = document.createElement('textarea');
    input.rows = 1;
    input.placeholder = '指示を書く  （Enter で送る / Shift+Enter で改行 / 先頭に /plan で分解）';
    const send = el('button', 'primary send', '送る');
    const stop = el('button', 'ghost', '中断');
    stop.type = 'button';
    stop.disabled = true;
    field.append(input, send);
    form.append(field, stop);
    wrap.append(log, form);
    body.append(wrap);

    // 下まで見ているときだけ追いかける。読んでいる途中で飛ばさない。
    let pinned = true;
    log.onscroll = () => {
      pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      jump.hidden = pinned;
    };
    const jump = el('button', 'jump', '新しい動きへ ↓');
    jump.hidden = true;
    jump.onclick = () => { pinned = true; jump.hidden = true; log.scrollTop = log.scrollHeight; };
    wrap.append(jump);
    const follow = () => { if (pinned) log.scrollTop = log.scrollHeight; else jump.hidden = false; };

    const add = (node) => { log.append(node); follow(); return node; };

    /** 一言。種類で色が変わるだけの、いちばん軽い形。 */
    const note = (cls, text) => add(el('div', `note ${cls}`, text));

    /** 折り畳める札。開かなければ一行で済む。 */
    const card = (icon, title, meta, cls = '') => {
      const box = el('details', `card ${cls}`);
      const head = el('summary', 'card-head');
      head.append(el('span', 'card-icon', icon), el('span', 'card-title', title));
      if (meta) head.append(el('span', 'card-meta', meta));
      box.append(head);
      const inner = el('div', 'card-body');
      box.append(inner);
      add(box);
      return { box, head, body: inner };
    };

    let stream = null;
    const append = (delta) => {
      if (!stream) stream = add(el('div', 'said'));
      stream.textContent += delta;
      follow();
    };

    /** いま動いている道具の札。結果が返ったら中身を差し込む。 */
    const openTools = new Map();
    const toolStart = (name, summary, taskId) => {
      const c = card('▸', name, summary || '', 'tool running');
      c.head.querySelector('.card-icon').textContent = '⋯';
      if (taskId) c.head.append(el('span', 'chip', taskId));
      openTools.set(`${taskId ?? ''}:${name}`, c);
      return c;
    };
    const toolEnd = (name, ok, summary, taskId) => {
      const key = `${taskId ?? ''}:${name}`;
      const c = openTools.get(key) ?? card(ok ? '✓' : '✗', name, '', 'tool');
      openTools.delete(key);
      c.box.classList.remove('running');
      c.box.classList.add(ok ? 'ok' : 'ng');
      c.head.querySelector('.card-icon').textContent = ok ? '✓' : '✗';
      c.body.append(el('pre', 'tool-out', summary));
      if (!ok) c.box.open = true;
      follow();
    };

    /** 書き換え。文章で説明するより、差分そのものを見せる方が速い。 */
    const showDiff = (v) => {
      const c = card('◈', v.path, `+${v.added} -${v.removed}`, 'diff-card');
      c.head.classList.add(v.created ? 'created' : 'changed');
      c.box.open = true;
      c.body.append(renderDiff(v.diff));
      follow();
    };

    const submit = async () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      input.style.height = '';
      stream = null;
      add(el('div', 'asked', text));
      const isPlan = text.startsWith('/plan');
      const r = await fetch(isPlan ? '/api/plan' : '/api/send', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: isPlan ? text.slice('/plan'.length).trim() : text }),
      });
      if (!r.ok) note('bad', (await r.json()).error ?? '送れませんでした');
    };

    form.onsubmit = (e) => { e.preventDefault(); void submit(); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
    };
    // 書いた分だけ伸びる。書きながら全体が見える。
    input.oninput = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    };
    stop.onclick = () => fetch('/api/abort', { method: 'POST' });
    ctx.focusInput = () => input.focus();

    ctx.on('busy', (e) => {
      stop.disabled = !e.busy;
      send.disabled = e.busy;
      wrap.classList.toggle('working', e.busy);
      if (!e.busy) { stream = null; openTools.clear(); }
    });

    ctx.on('session', ({ event: v }) => {
      if (v.type === 'text') return append(v.delta);
      stream = null;
      if (v.type === 'toolStart') toolStart(v.name, v.summary);
      else if (v.type === 'toolEnd') toolEnd(v.name, v.ok, v.summary);
      else if (v.type === 'diff') showDiff(v);
      else if (v.type === 'fallback') note('warn', `${v.from} → ${v.to} に切替（${v.reason}）`);
      else if (v.type === 'recalled') {
        const c = card('◔', '思い出したこと', '', 'recall');
        c.body.append(el('pre', 'tool-out', v.text));
      } else if (v.type === 'log') note(v.level === 'error' ? 'bad' : 'warn', v.text);
      else if (v.type === 'baseline') {
        const again = v.cached ? '確認済み・再実行なし' : v.command;
        note(v.unknown ? 'warn' : v.passed ? 'dim' : 'warn',
          v.unknown ? (v.detail || `作業前の検査は確認できませんでした（${v.command}）`)
            : v.passed ? `作業前の検査は通っています（${again}）`
            : `作業前から検査が失敗しています（${again}）`);
      } else if (v.type === 'salvaged') {
        note('dim', `本文に書かれていた ${v.name} の呼び出しを拾いました`);
      } else if (v.type === 'rolledBack') note('warn', `変更を巻き戻しました: ${v.paths.join(', ')}`);
      else if (v.type === 'verify') showVerify(v.event);
      else if (v.type === 'settled') {
        const okAll = v.reason === 'completed' && v.verified;
        add(el('div', `verdict ${okAll ? 'ok' : 'ng'}`,
          `${okAll ? '完了' : v.reason === 'completed' ? '完了（検証は通っていません）' : v.reason}`
          + ` · ${v.seconds.toFixed(1)}秒`));
      }
    });

    const showVerify = (e) => {
      if (e.type === 'running') note('dim', `検証 ${e.round}回目: ${e.command}`);
      else if (e.type === 'passed') note('good', `検証を通過しました（${(e.durationMs / 1000).toFixed(1)}秒）`);
      else if (e.type === 'failed') {
        const c = card('✗', `検証に失敗（${e.round}回目）`, '', 'ng');
        c.box.open = true;
        c.body.append(el('pre', 'tool-out', e.digest.split('\n').slice(-12).join('\n')));
      } else if (e.type === 'preexisting') {
        note('warn', 'この失敗は作業前から出ています。今回の作業が原因ではありません。');
      } else if (e.type === 'tampered') note('bad', e.reason);
      else if (e.type === 'fixing') note('dim', '修正させています…');
      else if (e.type === 'giveUp') note('warn', `検証を打ち切りました — ${e.detail}`);
    };

    ctx.on('planEvent', ({ event: v }) => {
      stream = null;
      if (v.type === 'planned') {
        const c = card('◇', v.plan.summary, `${v.plan.items.length}件`, 'planned');
        c.box.open = true;
        c.body.append(rows(v.plan.items, (t) => {
          const row = el('div', 'row');
          row.append(
            el('span', 'key mono', t.id),
            el('span', '', t.instruction.split('\n')[0]),
            el('span', 'chip', t.roleId),
          );
          return row;
        }));
      } else if (v.type === 'planRepaired') note('warn', `計画を直しました: ${v.detail}`);
      else if (v.type === 'baselineFailed') note('warn', '作業前から検査が失敗しています。切り分けて見ます。');
      else if (v.type === 'taskStart') note('dim', `▶ ${v.taskId} 着手 @${v.laneId}`);
      else if (v.type === 'taskEnd') {
        note(v.state === 'done' ? 'good' : 'bad',
          `${v.state === 'done' ? '✓' : '✗'} ${v.taskId}（${Math.round(v.ms / 1000)}秒）${v.error ?? ''}`);
      } else if (v.type === 'taskSkip') note('warn', `− ${v.taskId} 未実施: ${v.reason}`);
      else if (v.type === 'work') toolEnd(v.text.split(' ')[0], v.ok, v.text, v.taskId);
      else if (v.type === 'diff') showDiff(v);
      else if (v.type === 'verifying') note('dim', `検査: ${v.command}`);
      else if (v.type === 'recalled') {
        const c = card('◔', '思い出したこと', '', 'recall');
        c.body.append(el('pre', 'tool-out', v.text));
      } else if (v.type === 'log') note('bad', v.text);
      else if (v.type === 'accepted') showAcceptance(v.report);
    });

    /** 検収。ここだけは畳まない。人が見る前提の一枚だから。 */
    const showAcceptance = (r) => {
      const label = { accepted: '受け取りました', needsHuman: '判断をお願いします', rejected: '受け取れません' };
      const box = el('div', `acceptance ${r.verdict}`);
      box.append(el('div', 'acceptance-head', `検収 — ${label[r.verdict] ?? r.verdict}`));
      const done = r.members.filter((m) => m.state === 'done').length;
      const stats = el('div', 'acceptance-stats');
      stats.append(
        el('span', '', `作業 ${done}/${r.members.length}`),
        el('span', '', `検査 ${r.verified}`),
        el('span', '', `変更 ${r.changed.length}件`),
      );
      box.append(stats);
      if (r.changed.length > 0) {
        box.append(rows(r.changed, (f) => {
          const row = el('div', 'row');
          row.append(el('span', 'key mono', f));
          return row;
        }, 2));
      }
      for (const con of r.concerns) {
        const line = el('div', `concern ${con.severity}`);
        line.append(el('span', 'chip', con.severity === 'block' ? '要対応' : '確認'), el('span', '', con.reason));
        box.append(line);
        for (const w of (con.where ?? []).slice(0, 5)) box.append(el('div', 'concern-where', w));
      }
      if (r.concerns.length === 0) box.append(el('div', 'dim', '指摘はありません。'));
      add(box);
    };

    // 暇なときに考えたこと。頼んでいないのに動いていることが、ここで見える。
    ctx.on('thinkEvent', ({ event: v }) => {
      if (v.type === 'chose') {
        note('dim', `［${v.codename}］${v.name} — ${v.roleCodename}${v.isDuty ? `（${v.reason}）` : ''}`);
      } else if (v.type === 'noFinding') {
        note('dim', `［${v.codename}］報告することはありませんでした`);
      } else if (v.type === 'proposal') {
        const c = card('💡', v.proposal.title, v.codename, 'proposal');
        c.box.open = true;
        c.body.append(el('div', 'dim', v.proposal.rationale));
        if (v.proposal.suggestedAction) {
          c.body.append(el('div', 'proposal-action', v.proposal.suggestedAction));
        }
        const menu = el('div', 'ask-menu');
        const yes = el('button', 'primary', 'やってもらう');
        const no = el('button', '', '却下');
        const decide = (verdict) => {
          fetch('/api/proposal', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: v.proposal.id, verdict }),
          });
          menu.replaceChildren(el('span', 'dim', verdict === 'accepted' ? '着手します…' : '却下しました'));
        };
        yes.onclick = () => decide('accepted');
        no.onclick = () => decide('rejected');
        menu.append(yes, no);
        c.body.append(menu);
      }
    });

    // 承認。押されるまで、向こう側は止まって待っている。
    ctx.on('approval', (e) => {
      const req = e.request;
      const what = req.kind === 'write' ? `${req.created ? '新規作成' : '変更'}: ${req.path}`
        : req.kind === 'command' ? `コマンド実行: ${req.command}`
        : `外部への問い合わせ: ${req.url}`;
      const box = el('div', 'ask');
      box.append(el('div', 'ask-head', what));
      if (req.kind === 'write' && req.diff) box.append(renderDiff(req.diff));
      if (req.kind === 'network') box.append(el('div', 'dim', '取得のみ。資格情報は送りません。'));

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
      add(box);
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

  /**
   * 提案。
   *
   * 溜めるだけで、実行はしない。採るかどうかは人が決める。
   * ここで押せることが、この場所を「勝手に動く道具」ではなくする。
   */
  proposals(body, ctx) {
    const KIND = { bug: '不具合', risk: '危うさ', question: '確認', idea: '思いつき' };

    const draw = async () => {
      const r = await fetch('/api/proposals').then((x) => x.json()).catch(() => null);
      body.replaceChildren();
      if (!r) return body.append(empty('提案を読めませんでした。'));
      if (r.open.length === 0) {
        body.append(empty('未処理の提案はありません。'));
      }
      for (const p of r.open) {
        const box = el('details', 'card proposal');
        const head = el('summary', 'card-head');
        head.append(
          el('span', 'chip', KIND[p.kind] ?? p.kind),
          el('span', 'card-title', p.title),
          el('span', 'card-meta mono', p.id),
        );
        box.append(head);
        const inner = el('div', 'card-body');
        inner.append(el('div', 'dim', p.rationale));
        if (p.suggestedAction) inner.append(el('div', 'proposal-action', p.suggestedAction));
        const menu = el('div', 'ask-menu');
        const yes = el('button', 'primary', 'やってもらう');
        const no = el('button', '', '却下');
        const decide = async (verdict) => {
          menu.replaceChildren(el('span', 'dim', verdict === 'accepted' ? '着手します…' : '却下しました'));
          await fetch('/api/proposal', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: p.id, verdict }),
          });
          setTimeout(draw, 400);
        };
        yes.onclick = () => decide('accepted');
        no.onclick = () => decide('rejected');
        menu.append(yes, no);
        inner.append(menu);
        box.append(inner);
        body.append(box);
      }

      const foot = el('div', 'proposal-foot');
      foot.append(el('span', 'dim', `この1時間で考えた量 ${r.spent}`));
      if (r.due.length > 0) foot.append(el('span', 'warn', `未了の日課: ${r.due.join(', ')}`));
      const now = el('button', 'ghost tiny', 'いま考えさせる');
      now.onclick = async () => { await fetch('/api/think', { method: 'POST' }); setTimeout(draw, 800); };
      foot.append(now);
      body.append(foot);
    };

    void draw();
    ctx.onState(() => { void draw(); });
    ctx.on('thinkEvent', ({ event: v }) => { if (v.type === 'proposal') void draw(); });
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

  /**
   * この対話で何を書き換えたか。
   * 会話を遡らないと分からない、では見落とす。一箇所に集める。
   */
  changes(body, ctx) {
    const files = new Map();

    const draw = () => {
      body.replaceChildren();
      if (files.size === 0) {
        return body.append(empty('まだ何も書き換えていません。'));
      }
      const list = [...files.values()].reverse();
      const head = el('div', 'changes-head');
      const added = list.reduce((n, f) => n + f.added, 0);
      const removed = list.reduce((n, f) => n + f.removed, 0);
      head.append(
        el('span', 'dim', `${list.length} ファイル`),
        el('span', 'good', `+${added}`),
        el('span', 'bad', `-${removed}`),
      );
      body.append(head);

      for (const f of list) {
        const box = el('details', 'card diff-card');
        const h = el('summary', 'card-head');
        h.append(
          el('span', 'card-icon', f.created ? '＋' : '◈'),
          el('span', 'card-title mono', f.path),
          el('span', 'card-meta', `+${f.added} -${f.removed}`),
        );
        box.append(h);
        const inner = el('div', 'card-body');
        let drawn = false;
        // 開いたときに初めて描く。閉じたままの差分に手間をかけない。
        box.ontoggle = () => {
          if (box.open && !drawn) { inner.append(renderDiff(f.diff)); drawn = true; }
        };
        box.append(inner);
        body.append(box);
      }
    };

    draw();
    const record = (v) => {
      const prev = files.get(v.path);
      files.set(v.path, {
        path: v.path,
        diff: v.diff,
        added: v.added,
        removed: v.removed,
        created: prev?.created ?? v.created,
      });
      draw();
    };
    ctx.on('session', ({ event: v }) => { if (v.type === 'diff') record(v); });
    ctx.on('planEvent', ({ event: v }) => { if (v.type === 'diff') record(v); });
  },

  note(body, _ctx, spec) {
    body.append(el('div', 'dim', String(spec.options?.text ?? '（覚え書き）')));
  },
};

export const TITLES = {
  conversation: '会話', plan: '進行中', roster: '人員', memory: '記憶',
  proposals: '提案', duties: '日課', models: 'モデル', changes: '変更',
  log: '流れ', note: '覚え書き',
};
