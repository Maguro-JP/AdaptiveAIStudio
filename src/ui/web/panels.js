/**
 * 中身の作り方を、名前ごとに一つずつ。
 *
 * ここに関数を足せば、置ける中身が増える。
 * 増やすときに他を触らなくていいことが、いじりやすさになる。
 */

import { getJson } from './get-json.js';
import { renderDiff, splitHunkTexts } from './diff.js';
import { decorate } from './color.js';
import { verdictText, slowNote } from './verdict.js';
import { renderMarkdown } from './markdown.js';
import { isSendKey, isPlainEnter } from './keys.js';
import { pathActions } from './paths.js';
import { sizeText } from './size.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const empty = (text) => el('div', 'empty', text);
/**
 * このページで作ったエディタのパネル（名札 → そのパネルの入れ物）。同じページの中のパネルは、生きているかを
 * 時刻でなく、切り離されたかどうかで見る（並びを組み直した直後、前のパネルの時刻はまだ新しい）。
 */
const EDITORS_HERE = new Map(); // 名札 → 捨てられたか（() => boolean）

/**
 * 文の中の https:// を、押せる形にする。
 *
 * 「手で取るなら: ブラウザで開く: https://…」と出しても、写して貼らせるのでは
 * 案内になっていない。**文字は文字のまま**入れる（HTML として流し込まない。
 * 外から来た文が画面を書き換える口になる）。開く先は新しい窓。
 */
export function linkify(text) {
  const frag = document.createDocumentFragment();
  const re = /https?:\/\/[^\s<>"）」]+/g;
  let at = 0;
  for (const m of String(text).matchAll(re)) {
    if (m.index > at) frag.append(document.createTextNode(text.slice(at, m.index)));
    const a = el('a', 'link', m[0]);
    a.href = m[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    frag.append(a);
    at = m.index + m[0].length;
  }
  if (at < text.length) frag.append(document.createTextNode(text.slice(at)));
  return frag;
}

/**
 * 一覧。
 *
 * 列は必ず揃える。行ごとに幅が動くと、読むたびに目が探し直すことになる。
 * 揃えるのは好みではなく、読み取りの速さの問題。
 * subgrid を使って、行の中の列を一覧全体で共有する。
 */
/**
 * 本体へ書き込みを頼む。断られた（400・404・409・500）ら本体の文を返す。**効いた顔をしない。**
 * 成功は `{ ok: true, body }`、失敗は `{ ok: false, error }`（繋がらなかったときも失敗として返す）。
 */
async function tell(path, payload, what) {
  try {
    const r = await fetch(path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, body } : { ok: false, error: body.error ?? `${what}（${r.status}）` };
  } catch (e) {
    return { ok: false, error: `${what}（${e?.message ?? e}）` };
  }
}

/**
 * 提案の採否を伝える。提案のパネルと会話の中のカードの両方から使う（片方だけ直して、もう片方に同じ不具合を残した）。
 * 送っている間は「伝えています…」。断られたら本体の文と押す口を戻し、受け取られてから「着手します」と言う。
 */
async function decideProposal(id, verdict, menu, buttons) {
  menu.replaceChildren(el('span', 'dim', '伝えています…'));
  const got = await tell('/api/proposal', { id, verdict }, '伝えられませんでした');
  if (!got.ok) {
    menu.replaceChildren(el('span', 'warn', got.error), ...buttons);
    return false;
  }
  menu.replaceChildren(el('span', 'dim', verdict === 'accepted' ? '着手します…' : '却下しました'));
  return true;
}

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

/**
 * 裏で動いている仕事、一件ぶんの行。
 *
 * 取得の進み具合は 1.5 秒ごとに記録へ流れていて、記録が埋まって読めなかった（実機）。
 * だから**流れではなく、いまの状態だけ**を一行で出す。
 */
function jobRow(j, elapsed) {
  const row = el('div', `job ${j.state}`);
  const head = el('div', 'job-head');
  head.append(
    el('span', 'job-mark', j.state === 'running' ? '⏳' : j.state === 'done' ? '✓' : '✗'),
    el('span', 'job-title', j.title),
  );
  if (j.state === 'running' && j.startedAt) {
    head.append(el('span', 'job-elapsed dim', `${elapsed(j.startedAt)} 経過`));
  }
  row.append(head);
  if (j.progress && typeof j.progress.pct === 'number') {
    const bar = el('div', 'job-bar');
    const fill = el('div', 'job-fill');
    fill.style.width = `${Math.max(0, Math.min(100, j.progress.pct))}%`;
    bar.append(fill);
    row.append(bar);
  }
  if (j.detail) {
    const d = el('div', `job-detail mono ${j.state === 'failed' ? 'bad' : 'dim'}`, j.detail);
    d.style.whiteSpace = 'pre-wrap';
    row.append(d);
  }
  return row;
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
    // 狭い画面で切れない長さにする。/plan の案内は ⌘ の一覧にある。
    /*
     * **案内は一行で収まる長さにする。**
     *
     * 「指示を書く（Enter で送る・Shift+Enter で改行）」は、会話のパネルの幅
     * （既定 380px）でも二行に折れて、二行目が切れていた（実測。狭い配置では
     * 「指示を」しか読めない）。詳しい方は title に置く（指で触る画面では出ないが、
     * 送るボタンが在るので送り方は分かる）。
     */
    input.placeholder = '指示を書く';
    input.title = 'Enter で送る・Shift+Enter で改行';
    const send = el('button', 'primary send', '送る');
    // 動いていないときは、そもそも出さない。**押せないものは邪魔なだけ。**
    const stop = el('button', 'ghost icon', '■');
    stop.type = 'button';
    stop.title = '中断';
    stop.hidden = true;

    // 添付。落とす・貼る・選ぶ、どれでも渡せるようにする。
    const clip = el('button', 'ghost icon', '📎');
    clip.type = 'button';
    clip.title = 'ファイルを添える（落としても貼り付けてもよい）';
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.style.display = 'none';

    // 声。使えない環境では、そもそも出さない（押せないボタンは邪魔なだけ）。
    const Recog = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    // 狭いときに引っ込める側（名前で分かるようにしておく。style.css の @container）。
    const mic = el('button', 'ghost icon opt', '🎤');
    mic.type = 'button';
    mic.title = Recog ? '声で入れる' : 'この環境では声を使えません';
    if (!Recog) mic.style.display = 'none';

    // コマンド。**送る所の隣に置く。**
    // 横の板の並びに置いていたので、書いている手から遠かった。
    // 使うのは「いま書いているとき」なので、書く所の隣に在るべきもの。
    const cmd = el('button', 'ghost icon opt', '⌘');
    cmd.type = 'button';
    cmd.title = 'コマンド (Ctrl+K)';
    cmd.onclick = () => window.aasOpenPalette?.();

    const tray = el('div', 'attachments');
    tray.style.display = 'none';

    /*
     * 打ち込みのコマンド。先頭が `/` のあいだ、合う名前を入力欄の上に出す。
     * 一覧は本体から取る（組み込みと、作業場の skill）。`/plan` はこちらの道。
     */
    const slash = el('div', 'slash-list');
    slash.hidden = true;
    let slashCursor = 0;
    let slashShown = [];
    let known = null;
    const fetchCommands = async () => {
      if (known) return known;
      const r = await fetch('/api/commands', { signal: AbortSignal.timeout(5000) }).catch(() => null);
      const j = r?.ok ? await r.json().catch(() => null) : null;
      known = [{ name: 'plan', description: '分解して、一段ずつ進める', source: 'builtin' }, ...(j?.commands ?? [])];
      return known;
    };
    const drawSlash = () => {
      slash.replaceChildren();
      slash.hidden = slashShown.length === 0;
      slashShown.forEach((c, i) => {
        const row = el('div', `slash-row${i === slashCursor ? ' on' : ''}`);
        row.append(el('span', 'mono', `/${c.name}`), el('span', 'dim', c.description + (c.source === 'skill' ? '（skill）' : '')));
        row.onmousedown = (e) => { e.preventDefault(); pickSlash(c); };
        slash.append(row);
      });
    };
    const pickSlash = (c) => {
      const rest = input.value.replace(/^\/\S*/, '');
      input.value = `/${c.name} ${rest.trimStart()}`;
      slashShown = [];
      drawSlash();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    };
    const updateSlash = async () => {
      const m = /^\/([A-Za-z0-9_-]*)$/.exec(input.value);
      if (!m) { slashShown = []; drawSlash(); return; }
      const q = m[1].toLowerCase();
      const all = await fetchCommands();
      slashShown = all.filter((c) => c.name.toLowerCase().startsWith(q));
      slashCursor = 0;
      drawSlash();
    };
    // 作業場が変わったら、skill も変わる。次に `/` を打ったときに読み直す。
    ctx.forgetCommands = () => { known = null; };

    // 中断も入力欄の中に置く。**外に浮かせない。**
    // 送るの隣に在るのが自然で、離すと押し間違える。
    field.append(input, clip, cmd, mic, stop, send, picker);
    form.append(slash, tray, field);
    wrap.append(log, form);
    body.append(wrap);

    // ---- 添えたものを覚えておく -------------------------------
    const attached = new Map();

    const drawTray = () => {
      tray.textContent = '';
      tray.style.display = attached.size > 0 ? '' : 'none';
      for (const [id, item] of attached) {
        const chip = el('span', 'attachment');
        const icon = item.kind === 'image' ? '🖼' : item.kind === 'binary' ? '📦' : '📄';
        chip.append(el('span', 'attachment-icon', icon));
        chip.append(el('span', 'attachment-name', item.name));
        chip.append(el('span', 'dim', kb(item.bytes)));
        const x = el('button', 'attachment-x', '×');
        x.type = 'button';
        x.title = '外す';
        x.onclick = async () => {
          attached.delete(id);
          drawTray();
          // 依頼には添えなくなる（画面の預かりから外した）。預けたコピーを消せたかは、返事を見て言う
          try {
            const r = await fetch(`/api/attach?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
            const body = await r.json().catch(() => ({}));
            if (!r.ok) note('warn', `「${item.name}」を外しましたが、預けたコピーを消せたかを確かめられません（${body.error ?? r.status}）`);
            else if (body.kept) note('warn', `「${item.name}」を外しましたが、預けたコピーを消せませんでした（${body.kept}）。一日経つと、立ち上げたときに片づけます`);
          } catch (e) {
            note('warn', `「${item.name}」を外しましたが、預けたコピーを消せたかを確かめられません（繋がりません: ${e?.message ?? e}）`);
          }
        };
        chip.append(x);
        tray.append(chip);
      }
    };

    /*
     * 大きさの出し方。**小さいものを 1KB と言わない。**
     *
     * 1KB 未満を切り上げていたので、20 バイトのファイルも「1KB」と出ていた
     * （押して実測）。渡したものが正しく渡っているかを、ここで見る人もいる。
     */
    const kb = (n) => sizeText(n);

    /** 渡されたものを預ける。落とす・貼る・選ぶ、どの道でもここへ来る。 */
    /** 一つの大きさの上限（本体と同じ）と、一度に渡せる数。超えたものは送る前に断る（全部受け取ってから断ると、その間ずっと待たせる）。 */
    const ATTACH_MAX = 25 * 1024 * 1024;
    const ATTACH_AT_ONCE = 20;
    const take = async (all) => {
      const files = [...all];
      if (files.length > ATTACH_AT_ONCE) {
        note('warn', `一度に渡せるのは ${ATTACH_AT_ONCE} 件までです（${files.length} 件のうち、残りは渡していません）`);
        files.length = ATTACH_AT_ONCE;
      }
      for (const file of files) {
        if (file.size > ATTACH_MAX) {
          note('bad', `${file.name}: 大きすぎるので渡しません（${kb(file.size)}。上限は ${kb(ATTACH_MAX)}）`);
          continue;
        }
        const pending = el('span', 'attachment pending');
        pending.textContent = `${file.name} を渡しています…`;
        tray.style.display = '';
        tray.append(pending);
        try {
          const r = await fetch(`/api/attach?name=${encodeURIComponent(file.name)}`, {
            method: 'POST', body: file,
          });
          const item = await r.json();
          if (!r.ok) throw new Error(item.error ?? '渡せませんでした');
          attached.set(item.id, item);
        } catch (e) {
          note('bad', `${file.name}: ${e.message}`);
        }
        pending.remove();
        drawTray();
      }
    };

    clip.onclick = () => picker.click();
    picker.onchange = () => { void take([...picker.files]); picker.value = ''; };

    // 落とす。画面のどこに落としても受ける。狙わせない。
    let dragDepth = 0;
    wrap.ondragenter = (e) => { e.preventDefault(); dragDepth++; wrap.classList.add('dropping'); };
    wrap.ondragover = (e) => { e.preventDefault(); };
    wrap.ondragleave = () => { if (--dragDepth <= 0) wrap.classList.remove('dropping'); };
    wrap.ondrop = (e) => {
      e.preventDefault();
      dragDepth = 0;
      wrap.classList.remove('dropping');
      if (e.dataTransfer?.files?.length) void take([...e.dataTransfer.files]);
    };

    // 貼り付け。画面の切り取りを直接貼れるのが要点。
    input.onpaste = (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length === 0) return; // ただの文字。そのまま貼らせる
      e.preventDefault();
      void take(files);
    };

    // ---- 声 ---------------------------------------------------
    // 書き起こしの精度はブラウザ任せ。**入口だけ用意する。**
    // 気に入らなければ、他の道具で書き起こして貼り付ければよい。
    let listening;
    mic.onclick = () => {
      if (listening) { listening.stop(); return; }
      const r = new Recog();
      r.lang = 'ja-JP';
      r.interimResults = true;
      r.continuous = true;
      const before = input.value;
      r.onresult = (ev) => {
        let said = '';
        for (let i = 0; i < ev.results.length; i++) said += ev.results[i][0].transcript;
        input.value = before ? `${before} ${said}` : said;
        input.dispatchEvent(new Event('input'));
      };
      r.onerror = (ev) => { note('bad', `声を拾えませんでした: ${ev.error}`); };
      r.onend = () => { listening = undefined; mic.classList.remove('listening'); };
      r.start();
      listening = r;
      mic.classList.add('listening');
    };

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

    /*
     * **まだ何も無いときに、何を書けばいいか分からない。**
     *
     * 開いた直後の会話は、空の箱と「指示を書く」だけだった。初めて触る人は、
     * ここで何を打てるのかが分からない（押せば入る例が在れば、そこから始められる）。
     * 例は**入れるだけで送らない**。押した瞬間に走り出すと、確かめる間が無い。
     */
    const guide = el('div', 'chat-guide');
    {
      guide.append(el('div', '', 'やってほしいことを、そのまま書いてください。'));
      const chips = el('div', 'chat-chips');
      for (const text of [
        'このリポジトリの構成を教えて',
        'いま開いているファイルが何をしているか説明して',
        'テストを書いて',
      ]) {
        const chip = el('button', 'ghost chip-btn', text);
        chip.type = 'button';
        chip.title = '書きかけの指示に入れる（送りません）';
        chip.onclick = () => { input.value = text; input.focus(); };
        chips.append(chip);
      }
      guide.append(chips);
      guide.append(el('div', 'dim', 'ファイルは横の一覧の @ で添えられます。Ctrl+K でコマンド。'));
    }
    /** 何か出たら、案内は引っ込める。空に戻ったら、また出す。 */
    let guided = false;
    const showGuide = () => {
      if (guided || log.childNodes.length > 0) return;
      log.append(guide);
      guided = true;
    };
    const hideGuide = () => {
      if (!guided) return;
      guide.remove();
      guided = false;
    };
    /*
     * 出し先。ふだんは `log`。**古い分を継ぎ足すときだけ**、いったん別の入れ物へ
     * 出してから頭に差し込む（`card()` の中でも `add()` を呼ぶので、出し先は
     * ここで切り替えられるようにしておく）。
     */
    let sink = null;
    const add = (node) => {
      if (sink) { sink.append(node); return node; }
      hideGuide();
      log.append(node);
      follow();
      return node;
    };

    /** 一言。種類で色が変わるだけの、いちばん軽い形。 */
    const note = (cls, text) => {
      const n = el('div', `note ${cls}`);
      n.append(linkify(text ?? ''));
      return add(n);
    };

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

    /** 答えの一塊。素の文を持ち、届くたびに読める形へ組み直す。 */
    const said = (text) => {
      const box = el('div', 'said');
      box.replaceChildren(renderMarkdown(text, document));
      return box;
    };
    let stream = null;
    let streamText = '';
    const append = (delta) => {
      if (!stream) { stream = add(el('div', 'said')); streamText = ''; }
      streamText += delta;
      // 囲いが閉じていなくても、そこまでをコードとして出す（流れている途中）。
      stream.replaceChildren(renderMarkdown(streamText, document));
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
      // 当てた変更を、塊ごと・行ごとに戻せる（Cursor の Reject）。
      const rendered = renderDiff(v.diff, { onRevert: (picks) => revertPicks(v, picks, c.body) });
      // 書いてある色の隣に見本を出す。コードを読んでいる最中がいちばん要る。
      decorate(rendered, {
        onPick: (from, to) => {
          // 押した結果は、そのまま指示にする。
          // ここで直に書き換えると、承認も差分も通らずにファイルが変わる。
          input.value = `${v.path} の ${from} を ${to} に変えて`;
          input.focus();
        },
      });
      c.body.append(rendered);
      follow();
    };

    /** 差分の札から、塊・行を戻す。戻したあとの差分は本体が流すので、ここでは結果だけ言う。 */
    const revertPicks = async (v, picks, into) => {
      let r;
      try {
        r = await fetch('/api/revert', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: v.path, diff: v.diff, picks }),
          signal: AbortSignal.timeout(20000),
        });
        // 守っているファイル（.env など）は、確かめてから戻す
        if (r.status === 409) {
          const peek = await r.clone().json().catch(() => ({}));
          if (peek.confirm && peek.protected) {
            if (!confirm(peek.error)) return;
            r = await fetch('/api/revert', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: v.path, diff: v.diff, picks, confirmProtected: true }),
              signal: AbortSignal.timeout(20000),
            });
          }
        }
      } catch (e) {
        into.append(el('div', 'note bad', `戻せませんでした（${e.message ?? e}）`));
        return;
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { into.append(el('div', 'note warn', j.error ?? '戻せませんでした')); return; }
      into.append(el('div', 'note dim', j.reverted ? `戻しました（+${j.added} -${j.removed}）` : '戻すものはありませんでした'));
    };

    const submit = async () => {
      const text = input.value.trim();
      // 添えただけで送れる。「この画面を見て」だけで用が足りることがある。
      if (!text && attached.size === 0) return;
      // 送った時点で見ている会話（null はトップ）。返事を待つ間に別の会話を選び直されても、送り先と受け取り方はこれで決める
      const from = ctx.conversationId ? (ctx.conversationId() ?? null) : null;
      input.value = '';
      input.style.height = '';
      stream = null;

      const asked = el('div', 'asked', text);
      for (const item of attached.values()) {
        asked.append(el('div', 'asked-file', `📎 ${item.name}`));
      }
      add(asked);

      const ids = [...attached.keys()];
      attached.clear();
      drawTray();

      const isPlan = text.startsWith('/plan');
      /*
       * **送れなかったことを、画面に出す。**
       *
       * ここは投げっぱなしで、`fetch` 自体が失敗したときの受け手が無かった。
       * 落ちるのは呼び出しの外（`void submit()`）なので、**画面には自分が
       * 書いた分だけが残って、何も返らない。**送ったのに無視されたようにしか
       * 見えないし、何を直せばいいかも分からない。
       */
      /*
       * 受け取ったことが返るまで、しばらく何も出ない（モデルを読むあいだは
       * 長い）。**黙ったままにしない。**送ったのに何も起きないように見える。
       */
      const slow = setTimeout(() => {
        note('dim', 'まだ返事がありません。モデルを読んでいるところかもしれません（「流れ」に出ます）。');
      }, 10000);
      let r;
      ctx.sending?.();
      try {
        r = await fetch(isPlan ? '/api/plan' : '/api/send', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: isPlan ? text.slice('/plan'.length).trim() : text,
            attachments: ids,
            // いま開いている所（名前・行・選んでいる字）。開いていなければ付かない。
            ...(ctx.editorNow?.() ? { editor: ctx.editorNow() } : {}),
            // どの会話へ送るか（null はトップ＝新しい会話）。本体の「見ている会話」は別のタブや見回りが書き換えるので、ここで言う
            ...(!isPlan && ctx.conversationId ? { conversationId: from } : {}),
          }),
        });
      } catch (e) {
        ctx.adopt?.(null);
        note('bad', `送れませんでした（${e?.message ?? e}）。`
          + '本体が落ちているかもしれません。画面を開き直してください。');
        return;
      } finally {
        clearTimeout(slow);
      }
      const body = await r.json().catch(() => ({}));
      // トップから送ったなら、ここで自分の会話の名前が決まる。以後はその会話を見る。
      // 名前を付けて送ったときは受け取らない（返事を待つ間に別の会話を選んでいたら、前の会話へ引き戻すことになる）
      ctx.adopt?.(from === null ? (body.conversationId ?? null) : null);
      // 見ていた会話が、別のタブで消されていた。トップへ戻す（送るたびに断られ続けないため）
      if (r.status === 404 && from !== null) ctx.conversationGone?.(from);
      if (!r.ok) note('bad', body.error ?? `送れませんでした（${r.status}）`);
    };

    form.onsubmit = (e) => { e.preventDefault(); void submit(); };
    input.onkeydown = (e) => {
      if (!slash.hidden && slashShown.length > 0) {
        if (e.key === 'ArrowDown') { slashCursor = Math.min(slashCursor + 1, slashShown.length - 1); drawSlash(); e.preventDefault(); return; }
        if (e.key === 'ArrowUp') { slashCursor = Math.max(slashCursor - 1, 0); drawSlash(); e.preventDefault(); return; }
        if (e.key === 'Tab' || isSendKey(e)) { e.preventDefault(); pickSlash(slashShown[slashCursor]); return; }
        if (e.key === 'Escape') { slashShown = []; drawSlash(); e.preventDefault(); return; }
      }
      // 日本語入力の変換を確定する Enter では送らない（keys.js）。
      if (isSendKey(e)) { e.preventDefault(); void submit(); }
    };
    // 書いた分だけ伸びる。書きながら全体が見える。
    input.oninput = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
      void updateSlash();
    };
    input.onblur = () => { slashShown = []; drawSlash(); };
    // 繋がらないときに黙ると、止めたつもりで止まっていない
    stop.onclick = async () => {
      try {
        const r = await fetch('/api/abort', { method: 'POST' });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          note('bad', `止められませんでした（${body.error ?? r.status}）`);
        }
      } catch (e) {
        note('bad', `止められませんでした（繋がりません: ${e?.message ?? e}）`);
      }
    };
    ctx.focusInput = () => input.focus();
    ctx.prefill = (head) => {
      if (!input.value.startsWith(head)) input.value = head + input.value;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      void updateSlash();
    };

    /**
     * 残してあるやりとりを、そのまま並べ直す。
     *
     * 道具の呼び出しと結果は畳んで出す。開いたときに読みたいのは
     * 「何を頼んで、何が返ったか」で、途中の呼び出しではない。
     */
    /*
     * **作り直されたら、自分で取り直す。**
     *
     * ログのパネルと同じ形（`/api/logs` から取り直す）。パネルの × を押す、
     * 表示からパネルを出し入れする、設定→配置で型を変える、のどれでも
     * `render()` が全部を作り直す。流し込む側（`ctx.showHistory`）を呼ぶのは
     * 頁を開いた最初の一回と会話を選んだときだけなので、作り直すと空になる。
     */
    const restore = async () => {
      const id = ctx.conversationId?.();
      if (!id) {
        // 会話を開いていなくても、待っている承認は出す（承認は会話によらない。出さないと押す口が無い）
        try {
          const waiting = await getJson('/api/approvals');
          if (waiting.approvals?.length) ctx.showApprovals?.(waiting.approvals);
        } catch { /* 取れなければ、これから来る分だけ */ }
        return;
      }
      try {
        const body = await getJson(`/api/conversations/messages?id=${encodeURIComponent(id)}`);
        if (body.messages?.length) ctx.showHistory(body.messages);
        if (body.inFlight) ctx.showInFlight?.(body.inFlight);
        // 待っている承認。押す口が無いと、本体は 10 分待ち続ける。
        if (body.approvals?.length) ctx.showApprovals?.(body.approvals);
      } catch { /* 取れなければ、これから来る分だけ */ }
    };

    /** やりとりを並べる。出し先は `add()` が決める（`log` か、継ぎ足し用の入れ物）。 */
    const lay = (messages) => {
      for (const m of messages) {
        if (m.role === 'user') { add(el('div', 'asked', m.content)); continue; }
        if (m.role === 'assistant') {
          if (m.content.trim()) add(said(m.content));
          for (const call of m.toolCalls ?? []) {
            const c = card('✓', call.name, '', 'tool');
            c.box.open = false;
          }
          continue;
        }
        // 道具の結果。直前の札の中へ入れる。
        if (m.role === 'tool') {
          const last = (sink ?? log).lastElementChild;
          if (last?.classList.contains('tool')) {
            last.querySelector('.card-body')?.append(el('pre', 'tool-out', m.content));
          }
        }
      }
    };

    /**
     * 一度に並べる数。
     *
     * **長い会話を開くと、画面が固まっていた。**1500 往復（3000 件）の会話を
     * 開いたところ、**5.8 秒**返らず、その間フレームが一度も進まなかった（実測）。
     * 何時間も動かし続ける作りなので、会話は普通に伸びる。
     *
     * 出すのは後ろから。古い分は「前を出す」で足す（押さなければ描かない）。
     */
    const SHOWN = 200;
    /** 会話の欄を描き直した回数。描き直すと出していた承認の箱も消えるので、出し直してよい。 */
    let drawn = 0;
    /**
     * 出している承認の箱（id ごと）。開いたときの読み込みと、繋ぎ直したときの取り直しの両方から来るので、
     * まだ押せる箱が出ているなら同じものを二つ出さない。押して送れなかった箱は、本体がまだ待っているので出し直す
     */
    const asking = new Map();

    ctx.showHistory = (messages) => {
      log.textContent = '';
      drawn++;
      /*
       * **消したことを、案内の側にも知らせる。**`textContent = ''` は案内の節ごと
       * 消すが、`guided`（出したかどうか）は残る。残ったままだと、次に出そうとしても
       * 「もう出ている」と判じて出さない（配る形の中で実際に出なかった）。
       */
      guided = false;
      // 話が一つも無い会話に切り替えたら、案内をまた出す。
      if (!messages || messages.length === 0) setTimeout(showGuide, 0);
      stream = null;
      openTools.clear();
      const all = messages ?? [];
      let from = Math.max(0, all.length - SHOWN);
      if (from > 0) {
        const more = el('button', 'ghost log-more', `前の ${from} 件を出す`);
        more.type = 'button';
        more.onclick = () => {
          const next = Math.max(0, from - SHOWN);
          // いったん別の入れ物へ出してから、押し場所の後ろへ差し込む。
          const held = document.createElement('div');
          sink = held;
          try { lay(all.slice(next, from)); } finally { sink = null; }
          // 差し込む前の「下からの距離」を覚えて、読んでいた所を動かさない。
          const bottom = log.scrollHeight - log.scrollTop;
          more.after(...held.childNodes);
          log.scrollTop = log.scrollHeight - bottom;
          from = next;
          if (from === 0) more.remove();
          else more.textContent = `前の ${from} 件を出す`;
        };
        log.append(more);
      }
      lay(all.slice(from));
      follow();
    };

    /**
     * 動いている会話へ戻ったとき、途中までを写す。
     *
     * 離れていた間の出来事は描いていない（見ている会話のものしか通さない）。
     * 本体が持っている「ここまで」を、頼んだ文と一緒に出し、続きはそのまま流す。
     */
    ctx.showInFlight = (f) => {
      add(el('div', 'asked', f.asked));
      stream = null;
      if (f.text) append(f.text);
      wrap.classList.add('working');
      stop.hidden = false;
    };

    // 作り直されたぶんを、ここで取り戻す。**流し込む側を待たない。**
    void restore();

    ctx.on('busy', (e) => {
      stop.hidden = !e.busy;
      // **入力を止めない。**動いている間に送ったものは順番に積まれる（本体が 202 で受ける）。
      // 押せなくすると、書いたものを持ったまま待たされる。それがいちばん不快。
      send.disabled = false;
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
        const c = card('◔', '前の作業から引き継いだこと', '', 'recall');
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
      } else if (v.type === 'trimmed') {
        // **黙って落とさない。**読んだはずのものが消えていることを、
        // 見えるようにする。見えないと、急に忘れたように振る舞う。
        note('dim', v.dropped > 0
          ? `文脈に収まらないので、古い ${v.dropped} 往復を省きました`
          : '文脈に収まらないので、古い道具の結果を縮めました');
      } else if (v.type === 'nudged') {
        // **黙って押し戻さない。**何が起きているか分からないまま
        // 往復が増えると、動きが遅いだけに見える。
        note('dim', `途中で手が止まったので、続きを促しました（あと ${v.left} 回）`);
      } else if (v.type === 'rolledBack') {
        // 戻せなかった分を黙らない。戻ったつもりで開くと、半分だけ戻った作業場を見ることになる。
        note('warn', `変更を巻き戻しました: ${v.paths.join(', ')}`
          + (v.notRestored?.length ? `（戻せなかった: ${v.notRestored.join(', ')} — 大きすぎて前の中身を記録していません）` : ''));
      }
      else if (v.type === 'toolsFailed') {
        // **言葉より結果。**本文が「書き換えました」でも、止められていれば
        // 作業場は変わっていない。完了の顔をさせない。
        note('bad', `ツールが通りませんでした（${v.names.join(', ')}）。ファイルは変わっていません。`);
      } else if (v.type === 'outsideChanged') {
        // **外のツールで書いた回を、確かめた顔でも確かめていない顔でも黙らせない。**
        // 作業前の成否は測っていないので、落ちても今回の変更が原因とは限らない。
        if (v.beforeBaseline) {
          const where = Array.isArray(v.paths) ? outsideNames(v.paths) : '比べられませんでした';
          note('warn', v.remembered
            ? `外のツールが先に作業場を変えました（${where}）。作業前の成否は、この回より前に測った結果を使います。`
            : `外のツールが先に作業場を変えました（${where}）。作業前の状態は測れないので、このあと落ちたものは今回の作業のものとして直させます。`);
        } else if (Array.isArray(v.paths)) {
          note('warn', `外のツールが作業場を変えました（${outsideNames(v.paths)}）。作業前の状態は測っていないので、落ちても今回の変更が原因とは限りません。一度だけ確かめます。`);
        } else {
          /*
           * **一度伝われば済む警告には、了解の口を付ける。**
           *
           * git の管理下でない作業場（社用 PC の Z: など）で使う人は、比べられないことを
           * 一度了解すれば足りる。了解は作業場ごとに本体が覚え（`/api/acks`）、
           * 次からは Session が出さない。取り消しは設定の中。
           */
          const n = el('div', 'note warn');
          n.append(linkify('外のツールを使いましたが、作業場が変わったかを比べられませんでした（git の管理下でない作業場など）。確かめは回していません。'));
          if (v.ackable) {
            const bar = el('div', 'btnbar');
            const ok = el('button', 'ghost', '了解（この作業場では次から出さない）');
            ok.type = 'button';
            ok.onclick = async () => {
              ok.disabled = true;
              try {
                const r = await fetch('/api/acks', {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ id: v.ackable, ...(v.root ? { root: v.root } : {}) }),
                });
                if (!r.ok) throw new Error(String(r.status));
                ok.textContent = '了解しました（設定 → 外の道具 で、また出せます）';
              } catch {
                ok.disabled = false;
                ok.textContent = '了解を保存できませんでした。もう一度押してください';
              }
            };
            bar.append(ok);
            n.append(bar);
          }
          add(n);
        }
      } else if (v.type === 'verify') showVerify(v.event);
      else if (v.type === 'finished' && v.reason !== 'completed' && v.detail) {
        /*
         * **うまく終わらなかった理由を、会話に出す。**
         *
         * 「failed · 32.5秒」だけでは、次に何をすればいいか分からない（実機）。
         * 理由は流れ（log）にしか出ていなかったが、既定の配置にそのパネルは無い。
         *
         * ここは `failed` の回だけ出していた。`noProgress` にも
         * 「返事が空でした」という理由が付いているのに、**捨てていた。**
         * 画面には `noProgress` という符丁だけが残り、何も分からなかった。
         */
        note('bad', `${v.reason === 'failed' ? '落ちました' : '終わりませんでした'}: ${v.detail}`);
      } else if (v.type === 'settled') {
        // **確かめていないことを、確かめた顔で出さない。**
        // 試験の無い作業場では、何もしていなくても「完了」に見えていた。
        // 訊かれただけの回は、確かめるものが無い。**確かめていないことを
        // 落ちた顔で出さない。**（作業の回は、これまでどおり検証で判じる）
        const okAll = v.reason === 'completed' && (v.chat === true || v.verified);
        add(el('div', `verdict ${okAll ? 'ok' : 'ng'}`, verdictText(v)));
        // **遅い理由を、その場で言う。**設定の奥の数字は誰も見ない。
        const slow = slowNote(v);
        if (slow) note('warn', slow);
      }
    });

    /** 変わったファイルの名前。多いときは頭の数件と残りの件数。 */
    const outsideNames = (paths) => paths.length <= 5
      ? paths.join(', ')
      : `${paths.slice(0, 5).join(', ')} ほか ${paths.length - 5} 件`;

    const showVerify = (e) => {
      if (e.type === 'running') note('dim', `検証 ${e.round}回目: ${e.command}`);
      else if (e.type === 'passed') note('good', `検証を通過しました（${(e.durationMs / 1000).toFixed(1)}秒）`);
      else if (e.type === 'failed') {
        const c = card('✗', `検証に失敗（${e.round}回目）`, '', 'ng');
        c.box.open = true;
        /*
         * **切ったことを、黙って隠さない。**
         *
         * ここは末尾 12 行だけを出していた。本体は 40 行まで持っているので、
         * **最初に落ちた所が上にあると、それが見えないまま**「これで全部」に見える。
         */
        const lines = e.digest.split('\n');
        const tail = lines.slice(-12);
        if (lines.length > tail.length) {
          c.body.append(el('div', 'dim', `（前の ${lines.length - tail.length} 行は出していません）`));
        }
        c.body.append(el('pre', 'tool-out', tail.join('\n')));
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
      } else if (v.type === 'handoff') {
        note('dim', `${v.from.join(', ')} → ${v.taskId} へ申し送り`);
      } else if (v.type === 'taskSkip') note('warn', `− ${v.taskId} 未実施: ${v.reason}`);
      else if (v.type === 'work') toolEnd(v.text.split(' ')[0], v.ok, v.text, v.taskId);
      else if (v.type === 'diff') showDiff(v);
      else if (v.type === 'verifying') note('dim', `検査: ${v.command}`);
      else if (v.type === 'rolledBack') {
        // 確かめて落ちたので戻した。戻せなかった道を黙らない。
        note('warn', `確かめて落ちたので、この依頼の変更を巻き戻しました: ${v.paths.join(', ') || 'なし'}`
          + (v.notRestored?.length ? `（戻せなかった: ${v.notRestored.join(', ')}）` : ''));
      }
      else if (v.type === 'recalled') {
        const c = card('◔', '前の作業から引き継いだこと', '', 'recall');
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
        // 機械の符丁を、人に見せる語に引き直す（`unsure` のまま出さない）
        el('span', '', `検査 ${({ passed: '通過', failed: '失敗', skipped: '未実施', preexisting: '元から失敗', unsure: '不明' })[r.verified] ?? r.verified}`),
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
        // 場所は 5 か所まで。**切ったことは言う**（無いのと区別が付かなくなる）。
        const where = con.where ?? [];
        for (const w of where.slice(0, 5)) box.append(el('div', 'concern-where', w));
        if (where.length > 5) box.append(el('div', 'concern-where dim', `ほかに ${where.length - 5} か所`));
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
      } else if (v.type === 'failed') {
        // 選んで試したが、落ちた。選んだ一行だけで終わらせない
        note('warn', `［${v.codename}］考えられませんでした: ${v.reason}`);
      } else if (v.type === 'declined') {
        // **押したのに何も起きない、を作らない。**断ったなら、断ったと言う。
        note('dim', `今回は考えませんでした: ${v.reason}`);
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
        const decide = (verdict) => { void decideProposal(v.proposal.id, verdict, menu, [yes, no]); };
        yes.onclick = () => decide('accepted');
        no.onclick = () => decide('rejected');
        menu.append(yes, no);
        c.body.append(menu);
      }
    });

    /*
     * 承認。押されるまで、向こう側は止まって待っている。
     *
     * **作り直されても取り直せるように、描き手に名前を付ける。**
     * 押す札はこの DOM にしか無かったので、パネルを一枚出し入れするだけで
     * 押す口が消えていた（`render()` が全部作り直す）。本体は待ったままで、
     * 10 分経つまでどの依頼も進まない。
     */
    const showApproval = (e) => {
      const was = asking.get(e.id);
      if (was && was.drawn === drawn && was.open) return;
      const mark = { drawn, open: true };
      asking.set(e.id, mark);
      const req = e.request;
      const what = req.kind === 'write' ? `${req.created ? '新規作成' : '変更'}: ${req.path}`
        : req.kind === 'command' ? `コマンド実行: ${req.command}`
        : req.kind === 'deliberation' ? '協議: 重大な変更の申し出'
        : `外部への問い合わせ: ${req.url}`;
      const box = el('div', 'ask');
      box.append(el('div', 'ask-head', what));
      // 通す塊。2か所以上あるときだけ、選べるようにする。
      const picks = [];
      if (req.kind === 'write' && req.diff) {
        // **採否を決める場所こそ、色が見えないと判断できない。**
        // ここでは押しても何もしない（見るだけ）。承認の途中に
        // 別の指示を差し込ませない。
        const parts = splitHunkTexts(req.diff);
        if (parts.length > 1) {
          parts.forEach((part, i) => {
            const row = el('div', 'ask-hunk');
            const tick = document.createElement('input');
            tick.type = 'checkbox';
            tick.checked = true;
            tick.id = `${e.id}-h${i}`;
            const label = el('label', 'dim', `この塊を通す（${i + 1}/${parts.length}）`);
            label.htmlFor = tick.id;
            row.append(tick, label);
            const rendered = renderDiff(part.text);
            decorate(rendered);
            row.append(rendered);
            box.append(row);
            picks.push(tick);
          });
        } else {
          const rendered = renderDiff(req.diff);
          decorate(rendered);
          box.append(rendered);
        }
      }
      if (req.kind === 'network') box.append(el('div', 'dim', '取得のみ。資格情報は送りません。'));
      // 協議は中身を読ませるためのもの。畳まずに全部出す。
      if (req.kind === 'deliberation') {
        for (const line of String(req.summary || '').split('\n')) {
          box.append(el('div', 'dim', line));
        }
      }

      const yes = el('button', 'primary', '許可');
      const no = el('button', '', '拒否');
      /*
       * **5 ファイル直すと 5 回訊かれる。**1 回目で中身を見て納得している
       * のに、残り 4 回も同じ手を動かすことになる。人はそこで中身を見ずに
       * 押すようになり、承認そのものが形だけになる。
       *
       * 書き込みのときだけ出す。コマンドも、外へ出るのも、協議も、毎回訊く。
       */
      const all = req.kind === 'write' ? el('button', '', 'この依頼は以降訊かない') : null;
      const answer = async (approved, everything) => {
        // 選ばれた塊。全部に印が付いていれば、そのまま全部通す。
        const chosen = picks.map((t, i) => (t.checked ? i : -1)).filter((i) => i >= 0);
        // チェックを全部外して許可は、拒否と同じ。何も通さない（「以降訊かない」も同じ）。
        if (approved && picks.length > 0 && chosen.length === 0) { approved = false; everything = false; }
        /*
         * **外した塊を、押し場所によって黙って通さない。**
         *
         * ここは「以降訊かない」のときだけ塊の番号を送らず、本体は全文を
         * 書いていた。チェックを外してからそちらを押した人は、外したはずの塊まで
         * 書かれる（画面は「許可（この依頼は以降訊かない）」と出す）。
         * 選んだ塊は、どちらの押し場所でも送る。
         */
        const partial = approved && picks.length > 0 && chosen.length < picks.length;
        const said = !approved ? '拒否'
          : partial ? `一部だけ許可（${chosen.length}/${picks.length}${everything ? '、以降訊かない' : ''}）`
          : everything ? '許可（この依頼は以降訊かない）'
          : '許可';
        /*
         * **返事を見てから、押した結果を出す。**
         *
         * 送ったところで「許可」に書き換えていたので、10 分で切れたあとに
         * 押すと、本体は 404（その承認は既に終わっています）を返し、モデルには
         * 「拒否しました」が渡っているのに、**画面だけが「許可」になる。**
         */
        mark.open = false;
        box.replaceChildren(el('div', 'dim', `${what} → 送っています…`));
        let ok = false;
        let why = '';
        try {
          const r = await fetch('/api/approve', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: e.id, approved,
              ...(partial ? { hunks: chosen } : {}),
              ...(everything ? { all: true } : {}),
            }),
            signal: AbortSignal.timeout(20000),
          });
          ok = r.ok;
          if (!ok) {
            const j = await r.json().catch(() => ({}));
            why = j.error ?? `${r.status}`;
          }
        } catch (err) {
          why = err?.message ?? String(err);
        }
        box.replaceChildren(ok
          ? el('div', approved ? 'good' : 'dim', `${what} → ${said}`)
          : el('div', 'dim', `${what} → 送れませんでした（${why}）`));
      };
      yes.onclick = () => { void answer(true); };
      no.onclick = () => { void answer(false); };
      if (all) all.onclick = () => { void answer(true, true); };
      const menu = el('div', 'ask-menu');
      menu.append(yes, no);
      if (all) menu.append(all);
      box.append(menu);
      add(box);
      ctx.on('approvalDone', (d) => {
        if (d.id === e.id) mark.open = false;
        if (d.id === e.id && box.querySelector('button')) {
          box.replaceChildren(el('div', 'dim', `${what} → ${d.approved ? '許可' : '拒否'}`));
        }
      });
    };
    ctx.on('approval', showApproval);
    // 作り直されたら、待っている承認も取り直す（`restore` から渡ってくる）。
    ctx.showApprovals = (waiting) => { for (const a of waiting) showApproval(a); };

    // まだ何も無いなら、何を書けばいいかを出す（続きの在る会話では出ない）。
    showGuide();
  },

  /*
   * いま動いているものを、一枚にまとめる。
   *
   * ここと「裏の仕事」で二枚に分けていた。どちらも「いま動いているもの」で、
   * 札が二つ並ぶだけになっていた（実機の画面で、変更したファイル／実行中のタスク／
   * 診断／裏の仕事、と四つ並んでいた）。**分けた根拠が無いので、一枚にする。**
   *
   * 上が、頼まれた件を分けたもの（出来事から組み立てる。画面は覚えない）。
   * 下が、裏で動いているもの（取得・点検・報告。本体が状態ごと流してくる）。
   */
  plan(body, ctx) {
    let items = new Map();
    let jobs = [];

    const elapsed = (iso) => {
      const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
      return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
    };

    const draw = () => {
      body.replaceChildren();
      if (items.size > 0) {
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
      }
      // 空でも箱は置く。「何も無い」と言う場所が要る。
      const list = el('div', 'jobs');
      if (jobs.length === 0 && items.size === 0) list.append(empty('動いているものはありません。'));
      for (const j of jobs) list.append(jobRow(j, elapsed));
      body.append(list);
    };

    draw();
    ctx.on('jobs', (e) => { jobs = Array.isArray(e.jobs) ? e.jobs : []; draw(); });
    const tick = setInterval(() => {
      // 外された（描き直しで捨てられた）パネルの時計を、回し続けない。
      if (!body.isConnected) { clearInterval(tick); return; }
      if (jobs.some((j) => j.state === 'running')) draw();
    }, 1000);
    (async () => {
      try {
        const got = await getJson('/api/jobs');
        jobs = Array.isArray(got.jobs) ? got.jobs : [];
      } catch { /* 取れなければ空。変わったときに流れてくる */ }
      draw();
    })();

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
        const access = el('span', 'dim', r.access.join('/'));
        // 狭いと末尾が切れる。**何を許してあるかは、切れて困る。**指せば全部出す。
        access.title = r.access.join('/');
        row.append(el('span', 'key mono', r.codename), el('span', '', r.name), access);
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
      preference: '好み', incident: '起きたこと', displeasure: '二度としないこと',
    };
    // 読めずに退けた行は、思い出すときに使っていない。黙ると、手で直した行が効いていないことに気づけない。
    // 全部の行が読めないときも出す（覚えが 0 件の分岐より先に作る）。
    const skippedNote = (s) => s.memorySkipped > 0
      ? [el('div', 'warn', `読めない行が ${s.memorySkipped} 行あり、使っていません（memory.jsonl に元の文のまま残しています。直すと次から読みます）`)]
      : [];
    // 忘れて戻せる覚え（本体が持っている分を、新しい順に `memoryForgotten` で受け取る）。押し間違えを、その場で戻せるようにする。
    // 最後の一件は目の前に出し、それより前の分は畳んで並べる（続けて二つ忘れると、前は一つ目を戻せなかった）。
    // 本体へ送るのは番号だけ。中身を送らせると、記憶へ任意の文を書き込める口になる。
    let lastState;
    // この画面で忘れた覚えの写し。戻したときに、知らせを待たずに一覧へ差し戻すためだけに使う
    const forgotHere = new Map();
    // 「閉じる」を押したら、次に忘れるまで出さない（戻す口は本体に残っていて、開き直せばまた出る）
    let hideForgotten = false;
    // 畳んだ分を開いているか。本体の状態は 5 秒ごとに読み直して描き直すので、覚えておかないと開いたそばから閉じる
    let moreOpen = false;
    // 一覧は新しい順（本体が `slice(-60).reverse()` で渡す）。戻した行は、覚えた時刻の位置へ差し込む
    const withEntry = (list, entry) => {
      const at = list.findIndex((x) => x.at < entry.at);
      return at < 0 ? [...list, entry] : [...list.slice(0, at), entry, ...list.slice(at)];
    };
    const forgottenOf = (st) => (Array.isArray(st?.memoryForgotten) ? st.memoryForgotten : []);
    const withoutForgotten = (st, id) => ({ ...st, memoryForgotten: forgottenOf(st).filter((x) => x.id !== id) });
    const undoButton = (item) => {
      const { id } = item;
      const undo = el('button', 'ghost tiny', '戻す');
      undo.title = '忘れた覚えを元に戻す';
      undo.onclick = async () => {
        undo.disabled = true; // 二度押すと、二本目が「戻せる覚えがありません」になる
        try {
          const r = await fetch('/api/memory/restore', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
          });
          const got = await r.json().catch(() => ({}));
          if (!r.ok) {
            // 押しても戻らない口は残さない（立ち上げ直した・読み直した・同じものを覚え直した）
            if (got.gone && lastState) render(withoutForgotten(lastState, id));
            else undo.disabled = false;
            return alert(got.error ?? '戻せませんでした');
          }
          if (!lastState) return;
          // 知らせを待たずに、戻した行を一覧へ戻す（手元の写しは見せるためだけ。本体へは番号しか送らない）
          const entry = forgotHere.get(id);
          forgotHere.delete(id);
          const next = withoutForgotten(lastState, id);
          render(entry && !next.memory.some((x) => x.id === id)
            ? { ...next, memory: withEntry(next.memory, entry), memorySize: next.memorySize + 1 }
            : next);
        } catch (e) {
          undo.disabled = false;
          alert(`戻せませんでした（${e?.message ?? e}）`);
        }
      };
      return undo;
    };
    const forgottenNote = () => {
      const list = forgottenOf(lastState);
      if (list.length === 0 || hideForgotten) return [];
      const [latest, ...older] = list;
      const note = el('div', 'row dim', `「${latest.title}」を忘れました`);
      const close = el('button', 'ghost tiny', '閉じる');
      close.onclick = () => { hideForgotten = true; if (lastState) render(lastState); };
      note.append(undoButton(latest), close);
      if (older.length === 0) return [note];
      const more = el('details', 'forgotten-more');
      more.open = moreOpen;
      more.ontoggle = () => { moreOpen = more.open; };
      more.append(el('summary', 'dim', `ほかにも ${older.length} 件戻せます`));
      for (const item of older) {
        const row = el('div', 'row dim', `「${item.title}」`);
        row.append(undoButton(item));
        more.append(row);
      }
      return [note, more];
    };
    const render = (s) => {
      lastState = s;
      body.replaceChildren();
      if (s.memory.length === 0) return body.append(empty('まだ何も覚えていません。'), ...skippedNote(s), ...forgottenNote());
      body.append(...skippedNote(s), ...forgottenNote()); // 一覧の上に出す（下だと、60 件の一覧をたどらないと見えない）
      // **嫌がられたことを、いちばん上に。**これだけは話題に関係なく効く。
      const sorted = [
        ...s.memory.filter((m) => m.kind === 'displeasure'),
        ...s.memory.filter((m) => m.kind !== 'displeasure'),
      ];
      body.append(rows(sorted, (m) => {
        const row = el('div', 'row');
        const trust = m.confirms >= 3 ? '確か' : m.confirms === 2 ? 'おそらく' : '一度だけ';
        // **効いたかどうかを出す。**出さないと、なぜ上に来るのかが分からない。
        const helped = m.helped ?? 0;
        const misled = m.misled ?? 0;
        const worth = helped + misled === 0 ? ''
          : misled > helped ? `外した ${misled}/${helped + misled}`
          : `効いた ${helped}/${helped + misled}`;
        row.append(
          el('span', m.kind === 'displeasure' ? 'key bad' : 'key',
            m.kind === 'displeasure' ? `${LABEL[m.kind]} ×${m.confirms}` : `${LABEL[m.kind] ?? m.kind} / ${trust}`),
          el('span', m.supersededBy ? 'dim' : '', m.title),
          el('span', misled > helped ? 'bad' : 'good', worth),
        );
        if (m.outcome === 'failed') row.append(el('span', 'bad', '失敗'));
        // 覚え違いは、その場で消せる。消せないと溜まる一方になる。
        const drop = el('button', 'ghost tiny', '忘れる');
        drop.title = 'この覚えを消す';
        drop.onclick = async () => {
          try {
            const r = await fetch(`/api/memory?id=${encodeURIComponent(m.id)}`, { method: 'DELETE' });
            const got = await r.json().catch(() => ({}));
            if (!r.ok) return alert(got.error ?? '消せませんでした');
            // 題は本体が実際に忘れたものから取る（一覧は別に読み直したもので、ずれていることがある）
            forgotHere.set(m.id, m);
            hideForgotten = false;
            if (!lastState) return;
            // 知らせ（stateChanged）を待たずに、忘れた行を消して戻す口を出す
            const item = { id: m.id, title: got.title ?? m.title, kind: m.kind, at: Date.now() };
            const next = { ...withoutForgotten(lastState, m.id) };
            next.memoryForgotten = [item, ...next.memoryForgotten];
            render(next.memory.some((x) => x.id === m.id)
              ? { ...next, memory: next.memory.filter((x) => x.id !== m.id), memorySize: next.memorySize - 1 }
              : next);
          } catch (e) {
            alert(`消せませんでした（${e?.message ?? e}）`);
          }
        };
        row.append(drop);
        if (m.detail) row.title = m.detail;
        return row;
      }));
      body.append(el('div', 'dim', `全 ${s.memorySize} 件`));
    };
    ctx.onState(render);
  },

  /**
   * 提案。
   *
   * 溜めるだけで、実行はしない。採るかどうかは人が決める。
   * ここで押せることが、この場所を「勝手に動く道具」ではなくする。
   */
  proposals(body, ctx) {
    const KIND = { bug: '不具合', risk: '危うさ', question: '確認', idea: '思いつき' };
    /*
     * 描き直しをまたいで持つもの。5 秒ごとの描き直しで、開いて読んでいた札が閉じ、断られた理由の文が消え、
     * 伝えている最中の札に押し場所が戻って二度押せた（memory パネルの `moreOpen` と同じ形）
     */
    const opened = new Set();
    const sending = new Set();
    const refused = new Map();

    const draw = async () => {
      const r = await getJson('/api/proposals').catch(() => null);
      body.replaceChildren();
      if (!r) return body.append(empty('提案を読めませんでした。'));
      if (r.open.length === 0) {
        body.append(empty('未処理の提案はありません。'));
      }
      for (const p of r.open) {
        const box = el('details', 'card proposal');
        if (opened.has(p.id)) box.open = true;
        box.ontoggle = () => { if (box.open) opened.add(p.id); else opened.delete(p.id); };
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
          sending.add(p.id);
          refused.delete(p.id);
          // 断られても、通信が落ちても、少し置いて描き直す（押す口が消えたまま残らない）。断られた理由は描き直しても残す
          const done = await decideProposal(p.id, verdict, menu, [yes, no]).finally(() => sending.delete(p.id));
          if (!done) refused.set(p.id, menu.firstChild?.textContent ?? '伝えられませんでした');
          setTimeout(draw, 1500);
        };
        yes.onclick = () => decide('accepted');
        no.onclick = () => decide('rejected');
        if (sending.has(p.id)) menu.append(el('span', 'dim', '伝えています…'));
        else {
          if (refused.has(p.id)) menu.append(el('span', 'warn', refused.get(p.id)));
          menu.append(yes, no);
        }
        inner.append(menu);
        box.append(inner);
        body.append(box);
      }

      const foot = el('div', 'proposal-foot');
      foot.append(el('span', 'dim', `この1時間で考えた量 ${r.spent}`));
      // 上限で古い提案を落としている。**落としたことを黙らない。**
      // 黙ると、前に出ていた提案が消えたときに、忘れたのか却下したのかが
      // 分からなくなる。
      if (r.dropped > 0) {
        foot.append(el('span', 'warn', `溜まりすぎたので、古い ${r.dropped} 件を落としました`));
      }
      if (r.due.length > 0) foot.append(el('span', 'warn', `未了の日課: ${r.due.join(', ')}`));
      const now = el('button', 'ghost tiny', 'いま考えさせる');
      const said = el('span', 'dim', '');
      now.onclick = async () => {
        now.disabled = true; // 二度押すと、二本目が「いま別の作業をしています」で断られ、失敗に見える
        const got = await tell('/api/think', undefined, '考えさせられませんでした');
        now.disabled = false;
        // 作業中は断られる（409）。黙って押せなかったことにしない
        if (!got.ok) { said.className = 'warn'; said.textContent = got.error; return; }
        setTimeout(draw, 800);
      };
      foot.append(now, said);
      body.append(foot);
    };

    void draw();
    ctx.onState(() => { void draw(); });
    ctx.on('thinkEvent', ({ event: v }) => { if (v.type === 'proposal') void draw(); });
  },

  /**
   * 日課。**仕込んであるもの全部を出す。**
   *
   * ここまでは記録（いつ回ったか）だけを出していたので、**まだ一度も回って
   * いないと空**で、何が仕込まれているのかも、いつ起きるのかも分からなかった。
   * しかも読んでいた欄（`lastRunAt`）は記録に無い名前で、**記録が在っても
   * 必ず「未実施」**になっていた。
   */
  duties(body, ctx) {
    ctx.onState((s) => {
      body.replaceChildren();
      if (!s.duties || s.duties.length === 0) return body.append(empty('日課はまだありません。'));
      body.append(rows(s.duties, (d) => {
        const row = el('div', 'row');
        const last = typeof d.lastAt === 'number' ? new Date(d.lastAt).toLocaleString('ja-JP') : '未実施';
        const when = el('span', 'dim', d.when ?? '');
        const name = el('span', '', d.name ?? d.id ?? '');
        // いま発生しているものは、そう分かるようにする。
        const state = el('span', d.due ? 'warn' : 'dim', d.due ? `${d.catchUp ? '未了（前の分）' : '未了'} · ${last}` : last);
        row.append(el('span', 'key mono', d.codename ?? d.id ?? ''), name, when, state);
        row.title = d.purpose ?? '';
        return row;
      }, 4));
    });
  },

  /**
   * モデル。実測を眺めるだけでなく、**ここで用意も乗り換えもできる**ようにする。
   *
   * 端末でしかできない状態だと、画面から使う人はモデルを持てない。
   * ローカルで動かす以上、古いものを使い続ける理由が無いので、
   * 「新しいのが出ています」も、押せば取ってこられる形で出す。
   */
  models(body, ctx) {
    const status = el('div', 'stack');
    const list = el('div', 'stack');
    const store = el('div', 'stack');
    body.append(status, list, store);

    const draw = async () => {
      let data;
      try {
        data = await getJson('/api/models');
      } catch {
        status.replaceChildren(el('div', 'warn', 'モデルの状態を取れませんでした。'));
        return;
      }

      status.replaceChildren();
      const head = el('div', 'row');
      head.append(el('span', 'key', 'ランタイム'), el('span', 'num mono', data.runtime ?? '不明'));
      status.append(head);
      if (data.runtime === 'llamacpp') {
        const row = el('div', 'row');
        row.append(
          el('span', 'key', 'llama-server'),
          el('span', `num mono ${data.llamaServer ? 'dim' : 'warn'}`,
            data.llamaServer ? '用意済み' : '未用意（npm run llama）'),
        );
        status.append(row);
      }
      // GGUF を自分で置く道では、どこを見ているかが分からないと詰む。
      // 「置いたのに出ない」の切り分けが、この一行でつく。
      if (data.runtime !== 'ollama' && data.modelsDir) {
        const row = el('div', 'row');
        const where = el('span', 'num mono dim wrap', data.modelsDir);
        where.append(pathActions(data.modelsDir));
        row.append(el('span', 'key', '保存先'), where);
        status.append(row);
      }

      /*
       * 置いたものを拾い直す。
       *
       * **取ってこられなかったときの逃げ道がここ。**配布元の名前は変わるし、
       * 会社の PC はブラウザでしか落とせない。落として置き場に入れたあと、
       * 拾い直す手が無いと、立ち上げ直すまで出てこない。
       * 案内の文（「読み直す」）が指しているのは、この押し場所。
       */
      /*
       * **何を読み直すのかは、動かし方で違う。**Ollama のときに
       * 「置いたものを読み直す」と出していたので、押しても何も変わらない
       * （Ollama は保存先の .gguf を使わない）。押せるのに効かない口は、
       * 壊れていると読まれる。
       */
      const ollama = data.runtime === 'ollama';
      const again = el('button', 'ghost', ollama ? '⟳ 一覧を取り直す' : '⟳ 置いたものを読み直す');
      again.type = 'button';
      again.title = ollama
        ? 'Ollama に入っているモデルを一覧し直します'
        : '保存先に自分で入れた .gguf を拾い直します';
      again.onclick = async () => {
        again.disabled = true;
        again.textContent = '読み直しています…';
        try { await draw(); } finally { /* draw が組み直すので、戻しは要らない */ }
      };
      status.append(again);

      // 手元にあるもの
      list.replaceChildren(el('div', 'dim', ollama ? 'Ollama に入っているモデル' : '手元のモデル'));
      if (!data.installed || data.installed.length === 0) {
        /*
         * **在るものを「ありません」と言わない。**保存先に .gguf を入れても、
         * Ollama のときは一つも出ず「まだありません」とだけ出ていた。落として
         * 置いた人には、何が起きているのか分からない（社用PCはブラウザでしか
         * 落とせないので、置く道がいちばん使われる）。
         */
        const why = ollama && data.localGguf > 0;
        const note = empty(why
          ? `Ollama には入っていません。\n保存先には .gguf が ${data.localGguf} 件ありますが、`
            + 'いまの動かし方（Ollama）では使いません。\n設定 → モデル で「中で読む」に切り替えると使えます。'
          : 'まだありません。下から取ってこられます。');
        // 何行もある案内は、行の頭をそろえる（中央寄せだと読む所を目で探す）。
        if (why) note.className = 'empty guide';
        list.append(note);
      } else {
        for (const m of data.installed) {
          const row = el('div', 'row');
          const size = sizeText(m.sizeBytes);
          const name = el('span', `key mono${m.path ? ' wrap' : ''}`, m.ref);
          // モデルの道。どこに在るかを、開いて・コピーして確かめられる。
          if (m.path) name.append(pathActions(m.path));
          row.append(name, el('span', 'num dim', size));
          list.append(row);
        }
      }

      // 取ってこられるもの
      store.replaceChildren(el('div', 'dim', '取ってくる'));
      /*
       * **押した結果を、押した場所に出す。**
       *
       * ここまで、失敗はログの板へ流すだけだった。押したのはこの板なので、
       * ログの板を開いていない人には**何も見えない**。押しても永久に
       * 何も起きないように見える。
       * 403（同意が要る・回線で塞がれている・回数上限）も、ここに出る。
       *
       * **一覧の下ではなく、上に出す。**下に置いたら板の外へはみ出して、
       * 結局読めなかった（画面を見て直した）。
       */
      const fetching = data.fetching;
      if (fetching) {
        const box = el('div', fetching.state === 'failed' ? 'bad' : 'dim');
        box.style.whiteSpace = 'pre-wrap';
        box.textContent = fetching.state === 'running'
          ? `${fetching.id} を取得中… ${fetching.message}`
          : fetching.message;
        store.append(box);
      }

      for (const m of data.catalog ?? []) {
        const row = el('div', 'row');
        const get = el('button', 'ghost', `${m.id}（約${m.approxGB}GB）`);
        get.title = `${m.note}\n${m.ref}`;
        get.onclick = async () => {
          get.disabled = true;
          get.textContent = `${m.id} を取得中…`;
          let res;
          try {
            res = await fetch('/api/models/get', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: m.id }),
            });
          } catch (e) {
            alert(`取ってこられませんでした（${e?.message ?? e}）`);
            get.disabled = false;
            get.textContent = `${m.id}（約${m.approxGB}GB）`;
            return;
          }
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert(err.error || '取ってこられませんでした');
            get.disabled = false;
            get.textContent = `${m.id}（約${m.approxGB}GB）`;
          }
        };
        row.append(get);
        store.append(row);
      }

      // 新しい世代が出ていないか
      const check = el('button', 'ghost', '新しい世代を確認する');
      check.onclick = async () => {
        check.disabled = true;
        check.textContent = '確認中…';
        try {
          const r = await getJson('/api/models/newer');
          const found = r.findings ?? [];
          check.textContent = found.length === 0
            ? '新しい世代はありません'
            : found.map((f) => `${f.current} → ${f.found.join(', ')}`).join(' / ');
        } catch (e) {
          // 訊けなかった（502）のを「新しい世代はありません」と取り違えない
          check.textContent = `配布元に訊けませんでした（${e?.message ?? e}）`;
        }
        check.disabled = false;
      };
      store.append(check);
    };

    void draw();
    ctx.onState(() => { void draw(); });
  },

  /**
   * 作っているものを、その場で見る。
   *
   * 映すのは**別の口**（別ポート）で配られているもの。
   * 同じ口から作業物を出すと、書いたページが操作用の API を叩けてしまう。
   * そのうえで sandbox も付ける。出所が分かれていれば要らないはずだが、
   * **守りは一枚だと外れたときに何も残らない。**
   */
  preview(body, ctx) {
    const bar = el('div', 'preview-bar');
    const addr = document.createElement('input');
    addr.className = 'preview-addr';
    addr.placeholder = '/ から始める（例: index.html）';
    const reload = el('button', 'ghost icon', '⟳');
    reload.type = 'button';
    reload.title = '読み直す';
    const open = el('button', 'ghost icon', '↗');
    open.type = 'button';
    open.title = '別の窓で開く';
    bar.append(addr, reload, open);

    const frame = document.createElement('iframe');
    frame.className = 'preview-frame';
    // 出所が分かれていても、こちらでも縛る。
    frame.sandbox = 'allow-scripts allow-forms allow-popups allow-modals';
    const hint = el('div', 'dim preview-hint', 'ファイルを読み込んでいます…');

    body.append(bar, hint, frame);

    let base = '';
    const go = (path) => {
      if (!base) return;
      const p = (path ?? addr.value ?? '').replace(/^\/+/, '');
      frame.src = base + p;
    };

    reload.onclick = () => {
      // src を入れ直す。中身が別の出所なので、中の window は触れない。
      const src = frame.src;
      frame.src = 'about:blank';
      setTimeout(() => { frame.src = src; }, 0);
    };
    open.onclick = () => { if (frame.src) window.open(frame.src, '_blank', 'noopener'); };
    addr.onkeydown = (e) => { if (isPlainEnter(e)) { e.preventDefault(); go(); } };

    void (async () => {
      try {
        const r = await fetch('/api/preview');
        const info = await r.json();
        if (!r.ok) throw new Error(info.error ?? '口を開けませんでした');
        base = info.url;
        hint.textContent = `${info.root}  →  ${info.url}`;
        go('');
      } catch (e) {
        hint.className = 'bad preview-hint';
        hint.textContent = `見る口を開けませんでした: ${e.message}`;
      }
    })();
  },

  /*
   * **過去分は本体が持っている。**
   *
   * 行を DOM にしか持っていなかったので、配置を変える・パネルを出し入れする・
   * 設定を閉じる（描き直す）たびに全部消えた。既定の配置にこのパネルは無いので、
   * 後から開いても空だった（実機でそうなった）。開いたら本体（/api/logs）から
   * 取り直し、届く分は番号（seq）で重ねない。取り直している間に届いた分は、
   * 順を崩さないよう、取り終えてから流す。
   */
  log(body, ctx) {
    body.append(el('div', 'dim', '動いているものがここに流れます。'));
    const line = (e) => el('div', `log-line mono${e.level === 'error' ? ' bad' : e.level === 'warn' ? ' warn' : ''}`, e.text);
    let upTo = -1;
    const show = (e) => {
      if (typeof e.seq === 'number') {
        if (e.seq <= upTo) return;
        upTo = e.seq;
      }
      body.appendChild(line(e));
      while (body.childNodes.length > 500) body.removeChild(body.firstChild);
      body.scrollTop = body.scrollHeight;
    };
    let ready = false;
    const pending = [];
    ctx.on('log', (e) => { if (ready) show(e); else pending.push(e); });
    (async () => {
      try {
        const { lines } = await getJson('/api/logs');
        for (const l of lines) show(l);
      } catch { /* 取れなければ、これから来る分だけ */ }
      ready = true;
      for (const e of pending) show(e);
      pending.length = 0;
    })();
  },


  /**
   * 探す。
   *
   * **画面には、探す口が一つも無かった。**モデルは `search_text` を持って
   * いるのに、使う側は「あの文字がどこに在るか」を見る手段が無い。開いて直す
   * ための画面としては、これが無いと使えない（一覧を上から開いて回ることになる）。
   *
   * 当たった行を押すと、その行を開く。**開くだけでは足りない。**1000 行の
   * 頭が出ても、探している行は画面の外に在る。
   *
   * 打ち切ったことも、大きすぎて開いていないことも、そのまま出す。
   * **見ていない分を、無かったことにしない。**
   */
  search(body, ctx) {
    const form = el('div', 'search-head');
    const q = document.createElement('input');
    q.className = 'search-q';
    q.placeholder = '探す文字';
    q.spellcheck = false;
    const where = document.createElement('input');
    where.className = 'search-where mono';
    where.placeholder = '場所（省略すると全部）';
    where.spellcheck = false;
    const go = el('button', 'primary', '探す');
    form.append(q, where, go);
    const state = el('div', 'dim search-state', '');
    const list = el('div', 'search-hits');
    body.append(form, state, list);

    let asking = null;
    const look = async () => {
      const text = q.value.trim();
      list.replaceChildren();
      // 前の検索は、空で押したときも止める（止める前に返していたので、空にした後で前の結果が出た）
      if (asking) { asking.abort(); asking = null; }
      if (!text) { state.textContent = '探す文字を入れてください。'; return; }
      const ac = new AbortController();
      asking = ac;
      state.textContent = '探しています…';
      let r;
      try {
        const at = where.value.trim();
        r = await fetch(`/api/search?q=${encodeURIComponent(text)}${at ? `&path=${encodeURIComponent(at)}` : ''}`,
          { signal: AbortSignal.any([ac.signal, AbortSignal.timeout(25000)]) });
      } catch (e) {
        if (!ac.signal.aborted) state.textContent = `探せませんでした（${e.message ?? e}）`;
        return;
      }
      if (ac.signal.aborted) return;
      const j = await r.json().catch(() => ({}));
      // 本文を読む間に次の検索が始まっていたら、古い結果を足さない
      if (ac.signal.aborted || asking !== ac) return;
      if (!r.ok) { state.textContent = j.error ?? '探せませんでした'; return; }

      const hits = j.hits ?? [];
      if (hits.length === 0) {
        state.textContent = `見つかりませんでした: ${text}`;
        list.append(empty('別の言葉か、場所を変えて探してみてください。'));
        return;
      }
      const notes = [];
      if (j.capped) notes.push('打ち切りました（これで全部ではありません）');
      if (j.walkCapped) notes.push('ファイルが多いので、途中までしか見ていません');
      if (j.tooBig > 0) notes.push(`大きすぎて開いていないファイルが ${j.tooBig} 個あります`);
      if (j.unreadable > 0) notes.push(`二進のため見ていないファイルが ${j.unreadable} 個あります`);
      state.textContent = `${hits.length} 件${notes.length ? ` — ${notes.join(' / ')}` : ''}`;

      for (const h of hits) {
        const row = el('div', 'search-hit');
        const at = el('button', 'mono as-link search-at', `${h.path}:${h.line}`);
        at.title = 'ここを開く';
        at.onclick = () => { ctx.revealFile?.(h.path, h.line); };
        /*
         * **探した所を、会話へ渡す。**
         *
         * 見つけた行を AI に訊くとき、道と行を打ち直していた（`src/a.ts:120`）。
         * 打ち間違えれば、別の所の話になる。押した所から渡す。
         */
        const ask = el('button', 'icon search-ask', '@');
        ask.type = 'button';
        ask.title = '依頼に添える（この場所を渡す）';
        ask.onclick = () => { ctx.insertText?.(`${h.path}:${h.line}`); };
        const head = el('div', 'search-hit-head');
        head.append(at, ask);
        row.append(head, el('div', 'mono search-line', h.text));
        list.append(row);
      }
    };

    go.onclick = () => { void look(); };
    // **変換中の Enter で走らせない。**日本語を打つと、確定のたびに探しに行く。
    q.onkeydown = (e) => { if (isPlainEnter(e)) { e.preventDefault(); void look(); } };
    where.onkeydown = (e) => { if (isPlainEnter(e)) { e.preventDefault(); void look(); } };
    // 出したらすぐ打てる。探すために出したのに、もう一度押させない。
    q.focus?.();
  },

  /**
   * この対話で何を書き換えたか。
   * 会話を遡らないと分からない、では見落とす。一箇所に集める。
   */
  changes(body, ctx) {
    const files = new Map();
    /** 塊・行を戻す。結果だけ言う（戻したあとの差分は本体が流す）。 */
    const revert = async (f, picks, into) => {
      let r;
      try {
        r = await fetch('/api/revert', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: f.path, diff: f.diff, picks }),
          signal: AbortSignal.timeout(20000),
        });
        // 守っているファイル（.env など）は、確かめてから戻す
        if (r.status === 409) {
          const peek = await r.clone().json().catch(() => ({}));
          if (peek.confirm && peek.protected) {
            if (!confirm(peek.error)) return;
            r = await fetch('/api/revert', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: f.path, diff: f.diff, picks, confirmProtected: true }),
              signal: AbortSignal.timeout(20000),
            });
          }
        }
      } catch (e) {
        into.append(el('div', 'note bad', `戻せませんでした（${e.message ?? e}）`));
        return;
      }
      const j = await r.json().catch(() => ({}));
      into.append(el('div', r.ok ? 'note dim' : 'note warn',
        r.ok ? (j.reverted ? `戻しました（+${j.added} -${j.removed}）` : '戻すものはありませんでした') : (j.error ?? '戻せませんでした')));
    };

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
        /*
         * **ファイルの名前を押したら、そのファイルが開く。**
         *
         * ここは名前を字として置いていただけだった。書き換わったものを見て
         * 次に直したいのは、まさにそのファイルなのに、**横の一覧から探し直す**
         * ことになる。押せる所に見えないので、押してみる人もいない。
         * 差分を開く（この card の開閉）とは別の動きなので、親へ伝えない。
         */
        const name = el('button', 'card-title mono as-link', f.path);
        name.title = 'エディタで開く';
        name.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          ctx.revealFile?.(f.path);
        };
        h.append(
          el('span', 'card-icon', f.created ? '＋' : '◈'),
          name,
          el('span', 'card-meta', `+${f.added} -${f.removed}`),
        );
        box.append(h);
        const inner = el('div', 'card-body');
        let drawn = false;
        // 開いたときに初めて描く。閉じたままの差分に手間をかけない。
        box.ontoggle = () => {
          if (box.open && !drawn) {
            const rendered = renderDiff(f.diff, { onRevert: (picks) => revert(f, picks, inner) });
            // 書いてある色の隣に見本を出す。差分を読む場所は全部そうする。
            decorate(rendered);
            inner.append(rendered);
            drawn = true;
          }
        };
        box.append(inner);
        body.append(box);
      }
    };

    draw();
    /*
     * **作り直されたら、自分で取り直す。**記録のパネルと同じ形。
     *
     * ここまで差分は DOM と、このパネルの中の Map にしか無かった。パネルを一枚
     * 出し入れするだけで全部が作り直されて消え、そのうえ
     * 「まだ何も書き換えていません。」と**事実と違うこと**を出していた。
     * 塊ごと・行ごとに戻す道はこのパネルから入るので、直したものに辿り着けなくなる。
     */
    void (async () => {
      try {
        const got = await getJson('/api/changes');
        for (const f of got.files ?? []) if (!files.has(f.path)) files.set(f.path, f);
        if ((got.files ?? []).length > 0) draw();
      } catch { /* 取れなければ、これから来る分だけ */ }
    })();
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

  /**
   * 点検。
   *
   * cmd の窓は入口であって、道具ではない。立ち上げたあとに窓が塞がると、
   * 見たいものが見られなくなる。**回すのも読むのも、ここでやる。**
   */
  checks(body, ctx) {
    const bar = el('div', 'btnbar');
    const out = el('pre', 'mono task-out');
    // 点検ごとの状態行（実行中 → 終わり）を、ここに並べる。
    const statuses = el('div', 'task-statuses');
    const stop = el('button', 'ghost', '止める');
    stop.type = 'button';
    stop.hidden = true;
    // 名前を渡さなければ、全部止める（今までどおり）。
    // 止められなかったときは黙らない。黙ると、止めたつもりで点検が回り続ける
    const stopNote = el('span', 'warn', '');
    stop.onclick = async () => {
      stopNote.textContent = '';
      // 押した時点で本体に始まりが届いていた分だけを見る（返事を待つ間に押し始めた分や、始まりを頼んでいる途中の分は本体の答えに入らない）
      const asked = [...running].filter((id) => !starting.has(id));
      let r;
      try {
        r = await fetch('/api/task', { method: 'DELETE' });
      } catch (e) {
        stopNote.textContent = `止められませんでした（${e?.message ?? e}）`;
        return;
      }
      const got = await r.json().catch(() => ({}));
      if (!r.ok) {
        stopNote.textContent = got.error ?? `止められませんでした（${r.status}）`;
        return;
      }
      // 本体では動いていなかった分（終わりの知らせを取りこぼした）は、実行中のまま残さない
      const stopped = new Set(Array.isArray(got.stopped) ? got.stopped : []);
      // 返事を待つ間に終わりの知らせが来た分は、もう「終わりました」を出しているので触らない
      const gone = asked.filter((id) => running.has(id) && !stopped.has(id));
      for (const id of gone) {
        running.delete(id);
        const b = buttonById.get(id);
        if (b) b.disabled = false;
        clearInterval(ticks.get(id));
        const s = statusEl.get(id);
        if (s) { s.className = 'task-status dim'; s.textContent = `もう動いていませんでした: ${displayOf.get(id) ?? id}`; }
      }
      syncStop();
    };

    // **同じ点検は二重に回さない。別の点検は並べて回せる。**
    // 押した点検のボタンだけを止め、他は押せるままにする。
    const running = new Set();
    // 始まりを頼んでいて、まだ返事の無いもの
    const starting = new Set();
    const buttonById = new Map();
    const displayOf = new Map();
    const syncStop = () => {
      stop.hidden = running.size === 0;
      // 止める口が消えたら、止められなかった知らせも片づける（その後に終わった点検は、それぞれの行が言う）
      if (running.size === 0) stopNote.textContent = '';
    };

    /*
     * 出力は一つの箱に混ぜて出す。**どの点検の行か**を、切り替わりで見出しに出す。
     * 本体は点検の頭で「— 見出し —」を流すので、それが来たときは重ねて出さない。
     */
    let lastShown = '';
    const show = (name, text) => {
      const isHeader = /^— .* —\n$/.test(text);
      if (name !== lastShown && !isHeader) {
        out.append(document.createTextNode(`\n— ${displayOf.get(name) ?? name} —\n`));
      }
      lastShown = name;
      out.append(document.createTextNode(text));
      // 際限なくは溜めない。ただし 400 ではテスト（数千行）の前半が消えて、
      // どこで落ちたか読めなかった（Windows で実際にそうなった）。
      if (out.childNodes.length > 20000) out.removeChild(out.firstChild);
      out.scrollTop = out.scrollHeight;
    };

    /*
     * **動いているか終わったかを、見て分かるようにする。**点検ごとに一行持ち、
     * 押した時点で「実行中: 名前（秒）」を出して秒を進め、終わったら
     * 「終わりました（秒）」に置き換える。二本並べても、それぞれの行が動く。
     */
    const statusEl = new Map();
    const ticks = new Map();
    const began = new Map();
    const lineFor = (name) => {
      let s = statusEl.get(name);
      if (!s) { s = el('div', 'task-status'); statuses.append(s); statusEl.set(name, s); }
      return s;
    };
    const startStatus = (name) => {
      const s = lineFor(name);
      began.set(name, Date.now());
      s.className = 'task-status warn';
      const draw = () => { s.textContent = `⏳ 実行中: ${displayOf.get(name) ?? name}（${Math.floor((Date.now() - (began.get(name) ?? Date.now())) / 1000)} 秒）`; };
      draw();
      clearInterval(ticks.get(name));
      const t = setInterval(draw, 1000);
      // 試験（Node の中で画面を組む）では、このタイマーが走りを生かし続けて
      // 終わらなくなった（pre-push が止まった）。ブラウザでは unref は無い。
      t.unref?.();
      ticks.set(name, t);
    };
    const doneStatus = (name, code) => {
      clearInterval(ticks.get(name));
      const s = statusEl.get(name);
      if (!s) return;
      const sec = Math.floor((Date.now() - (began.get(name) ?? Date.now())) / 1000);
      s.className = `task-status ${code === 0 ? 'good' : 'bad'}`;
      s.textContent = code === 0
        ? `✓ 終わりました: ${displayOf.get(name) ?? name}（${sec} 秒）`
        : `✗ 終了コード ${code}: ${displayOf.get(name) ?? name}（${sec} 秒）`;
    };

    void getJson('/api/tasks').then(({ tasks }) => {
      for (const t of tasks ?? []) {
        displayOf.set(t.id, t.name);
        const b = el('button', '', t.name);
        b.type = 'button';
        b.onclick = async () => {
          if (running.has(t.id)) return; // 二重に押しても、二重には回さない
          b.disabled = true;
          running.add(t.id);
          syncStop();
          startStatus(t.id);
          let r;
          starting.add(t.id);
          try {
            r = await fetch('/api/task', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: t.id }),
            });
          } catch (e) {
            starting.delete(t.id);
            running.delete(t.id); b.disabled = false; syncStop();
            doneStatus(t.id, -1);
            show(t.id, `始められませんでした（${e?.message ?? e}）\n`);
            return;
          }
          starting.delete(t.id);
          if (!r.ok) {
            running.delete(t.id); b.disabled = false; syncStop();
            doneStatus(t.id, -1);
            show(t.id, `${(await r.json().catch(() => ({}))).error ?? '始められませんでした'}\n`);
          }
        };
        buttonById.set(t.id, b);
        bar.append(b);
      }
      bar.append(stop, stopNote);
    }, (e) => {
      // 読めなかったのを黙ると、押す口が一つも無い空のパネルに見える（受けるのは読むところの失敗だけ。組み立ての失敗は受けない）
      bar.append(el('span', 'warn', `作業の一覧を読めませんでした（${e?.message ?? e}）`), stop, stopNote);
    });

    const hint = el('div', 'dim', '困ったときは ⚙ → 情報 の「サポート用レポートを作る」を押して、出来たファイルを一つ送ってください。');
    body.append(bar, hint, statuses, out);

    ctx.on('task', (e) => { show(e.name, e.text); });
    ctx.on('taskDone', (e) => {
      running.delete(e.name);
      const b = buttonById.get(e.name);
      if (b) b.disabled = false;
      syncStop();
      doneStatus(e.name, e.code);
      show(e.name, e.code === 0 ? '— 終わりました —\n' : `— 終了コード ${e.code} —\n`);
    });
  },

  /**
   * 覚え書き。**打てる。**
   *
   * ここまでは渡された字を出すだけで、`表示` の一覧に「メモ」と並んでいるのに
   * **一文字も書けなかった**。開いた人は、書ける所を探して諦めることになる。
   * 打った分は配置と一緒に残す（読み直しても消えない）。
   *
   * 知らない種類の受け皿でもあるので、そのときは説明が最初の中身として入る。
   */
  note(body, ctx, spec) {
    const area = document.createElement('textarea');
    area.className = 'note-area';
    area.spellcheck = false;
    area.placeholder = '覚え書き（ここに書いたものは残ります）';
    area.value = String(spec.options?.text ?? '');
    const state = el('div', 'dim note-state', '');
    body.append(area, state);

    let saving;
    const keep = async () => {
      state.textContent = '書き留めています…';
      const ok = await ctx.saveNote?.(spec.id, area.value);
      state.textContent = ok ? '書き留めました' : '書き留められませんでした';
    };
    area.addEventListener('input', () => {
      state.textContent = '';
      clearTimeout(saving);
      // 打つたびに送らない。手が止まってから送る。
      saving = setTimeout(() => { void keep(); }, 600);
    });
  },

  /**
   * エディタ。
   *
   * ここまでは、ファイルは指示を通してだけ触る作りだった。直したい一行の
   * ために依頼を書かせるのは、Cursor と並べて明らかに劣る。横の一覧から
   * 開いて、直して、Ctrl+S で保存する。保存したものは戻り先に残り、
   * 「変更したファイル」にも載る（本体側がそう扱う）。
   */
  editor(body, ctx) {
    const wrap = el('div', 'editor');
    const head = el('div', 'editor-head');
    const name = el('span', 'mono editor-name', '（横の一覧からファイルを選ぶ）');
    const state = el('span', 'dim editor-state', '');
    const save = el('button', 'primary', '保存');
    save.disabled = true;
    head.append(name, state, save);
    const area = document.createElement('textarea');
    area.className = 'editor-area mono';
    area.spellcheck = false;
    area.disabled = true;
    // Tab 補完の灰色。欄の裏に同じ字組みで置き、カーソルまでを透明に、
    // 続きを灰色に描く。欄そのものは透けさせる。
    const stage = el('div', 'editor-stage');
    /*
     * **行番号。**
     *
     * 無かった。落ちた場所は「a.ts:128」の形で来るし、探した結果も行で来るのに、
     * 画面には行が一つも出ていないので、**数えるしかなかった。**
     * 欄と同じ字組みで左に並べ、欄の巻きに合わせて動かす。
     */
    const gutter = el('pre', 'editor-lines mono');
    const hold = el('div', 'editor-hold');
    const ghost = el('pre', 'editor-ghost mono');
    hold.append(ghost, area);
    stage.append(gutter, hold);

    /*
     * **探す・置き換える・行へ飛ぶ。**
     *
     * どれも無かった。1000 行のファイルを開いても、目で追うしかない。
     * 直すための画面として要る所なので、Ctrl+F と Ctrl+G で出す（普通の作法に合わせる）。
     */
    const bar = el('div', 'editor-find');
    bar.hidden = true;
    const needle = document.createElement('input');
    needle.className = 'find-q';
    needle.placeholder = '探す';
    needle.spellcheck = false;
    const swap = document.createElement('input');
    swap.className = 'find-r';
    swap.placeholder = '置き換える';
    swap.spellcheck = false;
    const lineAt = document.createElement('input');
    lineAt.className = 'find-line';
    lineAt.placeholder = '行';
    const prev = el('button', 'ghost', '前へ');
    const next = el('button', 'ghost', '次へ');
    const one = el('button', 'ghost', '置換');
    const all = el('button', 'ghost', '全部');
    const count = el('span', 'dim find-count', '');
    const shut = el('button', 'ghost icon', '×');
    bar.append(needle, prev, next, swap, one, all, lineAt, count, shut);

    /*
     * **AI が同じファイルを書いたことを、直している最中の人に伝える帯。**
     *
     * ここまで、直している最中（保存していない）に AI がそのファイルを書くと、
     * 画面は**何も言わずに人の版を出し続けていた**。ファイルは AI の版、欄は
     * 人の版、と二つに割れたまま、保存した方が相手を消す。どちらを残すかは
     * 人が決めることなので、起きたことを出して選ばせる。
     */
    const notice = el('div', 'editor-notice');
    notice.hidden = true;
    const noticeText = el('span', 'editor-notice-text', '');
    const noticeActs = el('span', 'editor-notice-acts');
    notice.append(noticeText, noticeActs);

    wrap.append(head, notice, bar, stage);
    body.append(wrap);

    let path = '';
    let loaded = '';
    /*
     * **開いたファイルが、どの作業場のものか。**
     *
     * 作業場を変えても、欄は前の作業場のファイルを持ったままで、保存は名前だけで新しい作業場へ送っていた。
     * 同じ名前・同じ中身のファイルが在れば（同じリポジトリの別の写し）、stamp も同じなので、**前の作業場の直しを
     * 黙って新しい作業場へ書いた。**預かりの鍵も名前だけだったので、別の作業場の同じ名前のファイルを開くと、
     * 前の作業場の直しを「保存していない直しを戻しました」と出した。開いたときに本体から作業場を受け取り、
     * 預かりの鍵に入れ、保存にも添える（違えば本体が断る）。
     */
    let rootAt = '';
    /** 預かり（このパネルの中・覚えておく所）の鍵。作業場ごとに分ける（作業場を言わない相手とは、今までどおり名前だけ）。 */
    const K = (p, root = rootAt) => (root ? `${root}\n${p}` : p);
    /*
     * **行末は、開いたファイルのものに戻して保存する。**
     *
     * ブラウザの欄は、入れた `\r\n` を `\n` に直して持つ（実測）。直したのは
     * 欄の中だけなので、そのまま保存すると**一行も触っていないのに全行が
     * 変わる**。配る先は Windows で、CRLF のファイルは普通に在る。
     * 開いたときの形を覚えて、保存でその形に戻す。
     */
    let eol = '\n';
    /*
     * 行末を見る。欄は `\r\n` も `\r` だけの行末も `\n` に直して持つ（Chromium で実測）。
     * 一種類だけならその形に戻せる。混ざっているものは戻せないので `\n` にそろえ、混ざっていると言う。
     * 前は `\r` だけの行末を見ていなかったので、そういうファイルは開いただけで「直しています」のまま戻らず、保存で全行が変わった。
     */
    const eolOf = (raw) => {
      const rest = raw.replace(/\r\n/g, '');
      const kinds = [raw.length !== rest.length, rest.includes('\n'), rest.includes('\r')];
      const only = kinds.filter(Boolean).length === 1;
      return {
        text: raw.replace(/\r\n?/g, '\n'),
        eol: only && kinds[0] ? '\r\n' : only && kinds[2] ? '\r' : '\n',
        mixed: kinds.filter(Boolean).length > 1,
      };
    };
    /** 開いたときの中身から作られた stamp。保存のときに送って、上書きを止めてもらう。 */
    let stamp = '';
    /** AI の版を読む前に預かった、自分の直し。**消さずに戻せるように持つ。** */
    let mine = null;
    /*
     * 預かった直しを、**ファイルごとに**持つ。
     *
     * `mine` 一つだけで持っていたので、別のファイルを開いた瞬間に消えていた
     * （`mine = same ? mine : null`）。「AI の版を出す」を押すと欄は AI の版と
     * 同じになる＝`dirty()` は false なので、離れるときの預かりも走らない。
     * **どこにも残らないまま、戻す口だけが消える。**開き直したら返せるようにする。
     */
    const held = new Map();
    const dirty = () => area.value !== loaded;

    /**
     * 知らせの帯を出す。押し場所は毎回作り直す（前の押し方が残らないように）。
     *
     * `kind` が `'info'` なら、ただの知らせ（色を落とす）。既定は、放っておくと
     * 書いたものが消える方の知らせ。
     */
    const tell = (text, acts, kind) => {
      /*
       * **ただの知らせで、消えるものが在る知らせを押しのけない。**
       *
       * 「AI が書き換えました」を出している最中に打つと、補完の断りが同じ帯へ
       * 来て、**割れていることの知らせが消えていた**（sweep で見つけた）。
       * 直している最中なので、打つのはむしろ普通のことだった。
       */
      if (kind === 'info' && !notice.hidden && !notice.className.includes('info')) return;
      notice.className = kind === 'info' ? 'editor-notice info' : 'editor-notice';
      noticeText.textContent = text;
      noticeActs.replaceChildren();
      for (const [label, run] of acts) {
        const b = el('button', 'ghost', label);
        b.type = 'button';
        b.onclick = run;
        noticeActs.append(b);
      }
      const close = el('button', 'ghost icon', '×');
      close.type = 'button';
      close.title = '閉じる（直しはそのまま）';
      close.onclick = () => { notice.hidden = true; };
      noticeActs.append(close);
      notice.hidden = false;
    };

    /** 自分の直しを預かって、いま在る中身（AI の版）に取り替える。 */
    const takeOver = (raw, newStamp) => {
      /*
       * **行末をそろえてから取り込む。**
       *
       * 欄は `\r\n` を `\n` に直して持つので、生のまま `loaded` に入れると
       * 欄と食い違い、**一文字も触っていないのに「直しています」**のまま
       * 戻らなくなる（開くときは `open` でそろえているのに、ここだけ素通し
       * だった）。開いたときの行末も、取り込んだ方に合わせる。
       */
      const seen = eolOf(String(raw ?? ''));
      const text = seen.text;
      eol = seen.eol;
      mine = area.value;
      if (path) {
        held.set(K(path), mine);
        /*
         * 自分の直しを、覚えておく所にも預ける（ブラウザを閉じても失わない）。**保存していない直しの預かりとは鍵を分ける。**
         * 同じ鍵に置くと、AI の版を直した分の預かりが上書きし、片づけも止めることになり、移って戻ったときに途中の直しを
         * 黙って戻した（読み直しで見つけた）。
         */
        try {
          localStorage.setItem(HELD_AT(path), JSON.stringify({ text: mine, base: loaded, at: Date.now(), by: DRAFT_ME }));
        } catch { /* 覚えておく所が使えない環境もある */ }
      }
      loaded = text;
      stamp = newStamp ?? '';
      area.value = text;
      refresh();
      tell('AI の版を出しました。自分の直しは預かっています。', [
        ['自分の直しに戻す', () => {
          area.value = mine ?? area.value;
          held.delete(K(path));
          dropHeld(path);
          refresh();
          tell('自分の直しに戻しました。保存すると AI の版を上書きします。', []);
        }],
      ]);
    };
    /*
     * 行番号を、いまの中身に合わせる。
     *
     * **打つたびに全部書き直さない。**ここは一文字ごとに 1 から行数まで
     * 数字を繋ぎ直して、丸ごと入れ直していた。行が増えるほど遅くなり、
     * 実測で 5000 行のファイルは一打 89ms、40000 行では 669ms かかっていた
     * （3 段階で測った。200 行では 4ms）。**書きかけの字が遅れて出る。**
     *
     * 行の数が変わらなければ、番号は変わらない。数えるだけにして、
     * 増えたときは足りない分を継ぎ足す（新しく書くときは、ここが多い）。
     */
    let drawnLines = -1;
    let gutterText = '';
    /** 行の数。`split` と違って、行の配列を作らない（大きいファイルで効く）。 */
    const countLines = (text) => {
      let n = 1;
      for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
      return n;
    };
    const drawLines = () => {
      const n = countLines(area.value);
      if (n !== drawnLines) {
        if (drawnLines > 0 && n > drawnLines) {
          let add = '';
          for (let i = drawnLines + 1; i <= n; i += 1) add += `${i}\n`;
          gutterText += add;
        } else {
          let out = '';
          for (let i = 1; i <= n; i += 1) out += `${i}\n`;
          gutterText = out;
        }
        gutter.textContent = gutterText;
        drawnLines = n;
      }
      gutter.scrollTop = area.scrollTop;
    };
    const refresh = () => {
      save.disabled = !path || !dirty();
      state.textContent = !path ? '' : dirty() ? '直しています（Ctrl+S で保存）' : '保存してあります';
      drawLines();
      // 打つたびに書き込むと重いので、手が止まってから預ける。
      scheduleKeep();
    };
    area.oninput = refresh;

    /*
     * **保存していない直しを、黙って捨てない。**
     *
     * 横の一覧で別のファイルを押すと、ここは読み直した中身をそのまま
     * `area.value` に入れていた。**確認も警告も無く、書いていたものが消える。**
     * よそからの書き換え（`session` の diff）には `!dirty()` の番が在るのに、
     * 人が別のファイルを開く道には無かった。
     *
     * 直す側の受け皿を作る。離れるときに預かって、戻ってきたら返す。
     * 消さないので、押し間違いでも取り返しがつく。
     */
    const drafts = new Map();

    /*
     * **ブラウザを閉じても、書いたものを失わない。**
     *
     * 預かり（`drafts`）はこのパネルの中だけに在るので、**読み直すと消えていた。**
     * 閉じる・押し間違えて再読み込み、で書いたものが消える（保存前なら戻せない）。
     * 覚えておく所へ預ける。使えない環境もあるので、全部 try で囲む。
     *
     * 一緒に**預けたときの中身**（`base`）も置く。開き直したときに中身が変わって
     * いたら、黙って戻さない（AI や別のブラウザが書いたものを、古い直しで上書きする）。
     */
    const DRAFT_AT = (p) => `aas.draft:${K(p)}`;
    /** 「AI の版を出す」で取り替えた自分の直しの預かり。保存していない直しの預かりとは分ける（片づけ・上書きの対象にしない）。 */
    const HELD_AT = (p) => `aas.held:${K(p)}`;
    const dropHeld = (p) => { try { localStorage.removeItem(HELD_AT(p)); } catch { /* 覚えておく所が使えない環境もある */ } };
    /** 取り替えた自分の直しを読む。形が違うもの・古いものは捨てる。 */
    const readHeld = (p) => {
      try {
        const raw = localStorage.getItem(HELD_AT(p));
        if (!raw) return undefined;
        const got = JSON.parse(raw);
        if (typeof got?.text !== 'string' || (typeof got.at === 'number' && Date.now() - got.at > DRAFT_KEEP_MS)) {
          localStorage.removeItem(HELD_AT(p));
          return undefined;
        }
        return got;
      } catch { return undefined; }
    };
    /**
     * このパネルの名札。預かる所はファイルの名前ごとに一つで、パネル（別のタブも）をまたいで同じ。
     * 片づけるときに、誰が預けたものかを見る（見ずに消すと、別のパネルの保存していない直しを消す）。
     */
    const DRAFT_ME = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    /**
     * このパネルが生きていることを、名札ごとに覚えておく所へ時刻で書き続ける（別のタブのパネルにも見える）。
     * 開いたファイルに別のパネルの預かりが在るとき、そのパネルが生きていれば引き取らない。引き取ると、同じ直しを
     * 二つのパネルが持ち、片方の保存がもう一方の片づけの名札を奪っていた。閉じたパネル（切り離された・ページを
     * 離れた）は書くのを止めるので、時刻が古くなれば死んだものとして扱い、今までどおり引き取る。
     */
    const LIVE_AT = (who) => `aas.live:${who}`;
    /*
     * 別のタブのパネルが生きているとみなす長さ。背景のタブはタイマーが間引かれ（長く裏にあると 1 分に 1 回程度）、
     * 5 秒ごとの書き込みが止まって見える。短くすると、裏で直している途中のタブの預かりを引き取る。
     * 閉じたタブはページを離れるときに消すので、長くして困るのは落ちたタブだけ（その分、引き取るのが遅れる）。
     */
    const LIVE_MS = 150_000;
    /*
     * 捨てられたか。並びの世代で見る（タブにまとめた中で隠れている間は DOM から外れるが、生きている）。
     * 世代を渡さない呼び方（試験）では、外れたかで見る。
     */
    const myGen = typeof ctx?.gen === 'function' ? ctx.gen() : undefined;
    const discarded = () => (myGen !== undefined ? ctx.gen() !== myGen : body.isConnected === false);
    const beat = () => { try { localStorage.setItem(LIVE_AT(DRAFT_ME), String(Date.now())); } catch { /* 覚えておく所が使えない環境もある */ } };
    const unbeat = () => { try { localStorage.removeItem(LIVE_AT(DRAFT_ME)); } catch { /* 同上 */ } };
    let beating;
    const pause = () => { clearInterval(beating); beating = undefined; unbeat(); };
    const resume = () => {
      if (beating !== undefined || discarded()) return;
      beat();
      beating = setInterval(() => { if (discarded()) dispose(); else beat(); }, 5_000);
      beating.unref?.(); // 試験（Node の中で画面を組む）で、このタイマーが走りを生かし続けないように
    };
    // ページを離れる（閉じる・裏の保存に入る）ときは止め、戻ってきたら（裏の保存から戻る）書き直す。
    const onHide = () => pause();
    const onShow = () => resume();
    /** 捨てられた。書くのを止め、ページに付けた受け手も外す（外さないと、捨てたエディタが中身ごと残る）。 */
    const dispose = () => {
      pause();
      EDITORS_HERE.delete(DRAFT_ME);
      globalThis.removeEventListener?.('pagehide', onHide);
      globalThis.removeEventListener?.('pageshow', onShow);
    };
    globalThis.addEventListener?.('pagehide', onHide);
    globalThis.addEventListener?.('pageshow', onShow);
    resume();
    EDITORS_HERE.set(DRAFT_ME, discarded);
    const aliveElsewhere = (who) => {
      if (typeof who !== 'string' || who === DRAFT_ME) return false;
      // このページのパネルなら、捨てられていないかで決める。別のタブのものは時刻で決める。
      if (EDITORS_HERE.has(who)) return !EDITORS_HERE.get(who)();
      try {
        const at = Number(localStorage.getItem(LIVE_AT(who)));
        return Number.isFinite(at) && at > 0 && Date.now() - at < LIVE_MS;
      } catch { return false; }
    };
    /**
     * 「後から変わっています」を出した預かり（ファイルの名前 → 預けた時刻）。**片づけでは名札を見ずに消す。**
     * 名札はパネルを作るたびに変わるので、ブラウザを閉じた後の預かりはどれも「他人のもの」になる。見ずに残すと、
     * 開くたびに同じ知らせを出し、保存した版を古い直しで上書きする道を勧め続ける（名札を足した版でそうなった）。
     */
    const toldDraft = new Map();
    /** これより大きいものは預けない（覚えておく所が溢れる）。 */
    const DRAFT_MAX = 512 * 1024;
    /** これより古い預かりは捨てる。 */
    const DRAFT_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
    /*
     * 古い預かりを片づける。預かりは同じ鍵を読んだときにしか消えないので、二度と開かない作業場・ファイルの分（鍵を作業場と
     * 名前の組に変える前の、名前だけの鍵の分も）が溜まり続け、覚えておく所が溢れると、新しい直しを黙って預けられなくなる。
     * パネルを作るたびに、期限を過ぎたものだけを消す（時刻の無いものは読めないので触らない）
     */
    try {
      const old = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (!k || !(k.startsWith('aas.draft:') || k.startsWith('aas.held:'))) continue;
        try {
          const got = JSON.parse(localStorage.getItem(k) ?? '');
          if (typeof got?.at === 'number' && Date.now() - got.at > DRAFT_KEEP_MS) old.push(k);
        } catch { /* 読めない形は触らない */ }
      }
      for (const k of old) localStorage.removeItem(k);
    } catch { /* 覚えておく所が使えない環境もある */ }
    let toldTooBig = '';
    let toldBusy = '';

    const keepDraft = () => {
      if (!path) return;
      try {
        if (!dirty()) { releaseDraft(path); return; }
        if (area.value.length > DRAFT_MAX) {
          // 前に預けた小さい版は残さない（残すと、ブラウザを閉じた後に古い版を黙って「戻しました」と出す）。
          releaseDraft(path);
          if (toldTooBig !== path) {
            toldTooBig = path;
            /*
             * **「ブラウザを閉じると残りません」だけでは足りない。**
             * 預かれないということは、パネルを開き閉じ・並べ替えしただけでも
             * この欄が作り直されて消えるということ。そこまで言う。
             */
            tell('大きいので、保存していない直しを預かれません（パネルを作り直したときも、ブラウザを閉じたときも残りません。保存してください）。', [], 'info');
          }
          return;
        }
        // 生きている別のパネルが同じファイルを預けているなら、上書きしない（そちらの直しを預かりから落とす）。
        const other = readDraft(path);
        if (other && aliveElsewhere(other.by) && other.text !== area.value) {
          if (toldBusy !== path) {
            toldBusy = path;
            tell('別のパネルが同じファイルの直しを預けているので、ここの直しは預かれません（ブラウザを閉じると残りません。保存してください）。', [], 'info');
          }
          return;
        }
        localStorage.setItem(DRAFT_AT(path), JSON.stringify({ text: area.value, base: loaded, at: Date.now(), by: DRAFT_ME }));
      } catch { /* 覚えておく所が使えない環境もある */ }
    };
    /** 預かりを読む。形が違うもの・古いものは、その場で捨てる。 */
    const readDraft = (p) => {
      try {
        const raw = localStorage.getItem(DRAFT_AT(p));
        if (!raw) return undefined;
        const got = JSON.parse(raw);
        if (typeof got?.text !== 'string' || typeof got?.base !== 'string') {
          localStorage.removeItem(DRAFT_AT(p));
          return undefined;
        }
        if (typeof got.at === 'number' && Date.now() - got.at > DRAFT_KEEP_MS) {
          localStorage.removeItem(DRAFT_AT(p));
          return undefined;
        }
        return got;
      } catch { return undefined; }
    };
    /** 預かりを捨てる。**人が「捨てる」を押したときだけ**（誰が預けたものでも捨てる）。 */
    const dropDraft = (p) => { try { localStorage.removeItem(DRAFT_AT(p)); } catch { /* 同上 */ } };
    /**
     * 要らなくなった預かりを片づける（保存した・直しが無くなった）。**自分が預けたものと、中身がいまの欄と同じものだけ。**
     * 別のパネルが預けた、違う中身の直しは残す。名札の無いもの（前の版が預けた）は、今までどおり片づける。
     */
    const releaseDraft = (p) => {
      // まだ選んでいないパネルの中の預かりが在る間は、覚えておく所の写しも残す（ブラウザを閉じても失わない）。
      if (drafts.has(K(p))) return;
      try {
        const raw = localStorage.getItem(DRAFT_AT(p));
        if (!raw) return;
        let got;
        try { got = JSON.parse(raw); } catch { got = undefined; }
        const mine = !got || typeof got !== 'object' || got.by === undefined || got.by === DRAFT_ME;
        const told = toldDraft.has(p) && got?.at === toldDraft.get(p);
        if (mine || told || got.text === area.value) localStorage.removeItem(DRAFT_AT(p));
      } catch { /* 同上 */ }
    };
    /** 覚えておく所から戻した直しを、このパネルのものとして預け直す（戻した側が保存したら片づけられるように）。 */
    const adoptDraft = (p, saved) => {
      try { localStorage.setItem(DRAFT_AT(p), JSON.stringify({ ...saved, by: DRAFT_ME })); } catch { /* 同上 */ }
    };

    let keeping;
    const scheduleKeep = () => {
      clearTimeout(keeping);
      keeping = setTimeout(keepDraft, 400);
    };
    // 作り直される手前で、預けを待っている分をその場で預けて止める。補完も止める（`render` の知らせ）
    ctx.onDiscard?.(() => {
      if (keeping !== undefined) { clearTimeout(keeping); keeping = undefined; keepDraft(); }
      clearTimeout(pending);
      asking?.abort();
    });

    /**
     * 欄のここからここまでを選ぶ。
     *
     * `setSelectionRange` が在ればそれで動かし、**selectionStart/End も
     * 必ず合わせる。**片方だけに頼ると、持っていない所で黙って動かなくなる。
     */
    const select = (from, to) => {
      area.setSelectionRange?.(from, to);
      area.selectionStart = from;
      area.selectionEnd = to;
    };

    /** その行が、上から何番目の字から始まるか。 */
    const lineStart = (text, line) => {
      const rows = text.split('\n');
      const n = Math.max(1, Math.min(line, rows.length));
      let at = 0;
      for (let i = 0; i < n - 1; i += 1) at += rows[i].length + 1;
      return { at, end: at + (rows[n - 1]?.length ?? 0), n, rows: rows.length };
    };

    /** その行が見える所まで巻く。高さが取れない所（試験の作り物）では何もしない。 */
    const scrollToLine = (line, rows) => {
      const h = area.scrollHeight / Math.max(1, rows);
      if (!Number.isFinite(h) || h <= 0) return;
      area.scrollTop = Math.max(0, (line - 1) * h - (area.clientHeight || 0) / 2);
      gutter.scrollTop = area.scrollTop;
    };

    /**
     * その行を選んで、見える所まで寄せる。
     *
     * **開いただけでは、どこに在るか分からない。**探した結果から開くとき、
     * 1000 行のファイルの頭が出ても、探している行は画面の外に在る。
     */
    const goTo = (line) => {
      if (!line || line < 1) return;
      const { at, end, n, rows } = lineStart(area.value, line);
      area.focus();
      select(at, end);
      scrollToLine(n, rows);
      state.textContent = `${n} 行目`;
    };

    /**
     * 欄の一部を、**Ctrl+Z で戻せる形で**書き換える。
     *
     * `setRangeText` を「戻せる形」と書いていたが、**戻せない**。Chromium で
     * 実測したところ、`setRangeText`・丸ごと代入のどちらも戻し履歴に乗らず、
     * 置き換えたあと Ctrl+Z を押しても戻らなかった。人が打ったのと同じ扱いで
     * 入る `execCommand('insertText')` だけが乗る（一度の呼びで一段。空文字を
     * 渡せば、選んだ所を消すのも乗る。これも実測）。古い名前だが、履歴へ入れる
     * 口はこれしかない。効かない所では `setRangeText` に落とす（戻せないが、
     * 書き換えはできる）。
     *
     * カーソルは入れた字の後ろに置く。選び直したい所は、呼んだ側で置き直す。
     */
    const writeRange = (from, to, text) => {
      try {
        if (typeof document.execCommand === 'function') {
          area.focus();
          area.setSelectionRange(from, to);
          if (document.execCommand('insertText', false, text) === true) return;
        }
      } catch { /* 効かない所は下に落とす */ }
      if (typeof area.setRangeText === 'function') area.setRangeText(text, from, to, 'end');
      else {
        area.value = area.value.slice(0, from) + text + area.value.slice(to);
        area.selectionStart = from + text.length;
        area.selectionEnd = from + text.length;
      }
    };
    /** 当たった所を入れ替える。入れたあとは、次の当たりを探せる位置に居る。 */
    const put = (from, to, text) => writeRange(from, to, text);

    /** いま探している文字が何件在るか。0 件なら、そう出す。 */
    const tally = () => {
      const q = needle.value;
      if (!q) { count.textContent = ''; return 0; }
      const n = area.value.split(q).length - 1;
      count.textContent = n === 0 ? '見つかりません' : `${n} 件`;
      return n;
    };

    /**
     * 次（前）の当たりへ動く。
     *
     * **端まで行ったら、反対の端から続ける。**一度当たらなくなっただけで
     * 止まると、途中から探し始めた人には「無い」と見える。
     */
    const step = (back) => {
      const q = needle.value;
      if (!q || area.disabled) return;
      const text = area.value;
      let at;
      if (back) {
        at = text.lastIndexOf(q, Math.max(0, area.selectionStart - 1));
        if (at < 0) at = text.lastIndexOf(q);
      } else {
        at = text.indexOf(q, area.selectionEnd);
        if (at < 0) at = text.indexOf(q);
      }
      if (at < 0) { tally(); return; }
      area.focus();
      select(at, at + q.length);
      // 当たった所の行まで巻く。
      const line = text.slice(0, at).split('\n').length;
      scrollToLine(line, text.split('\n').length);
      tally();
      state.textContent = `${line} 行目`;
    };

    /**
     * 当たりを一つ置き換えて、次の当たりへ動く。
     *
     * **押しても何も起きない回を作らない。**ここは「選んでいる所が当たりのときだけ」
     * 置き換えていた。探す文字を打っただけでは何も選んでいないので、置換を押すと
     * 次の当たりへ動くだけで、**一度目は何も置き換わらない**（押して実測）。
     * 選んでいなければ、まず次の当たりへ動いてから置き換える。
     * 置き換えるのは当たりだけ、は変えない。
     */
    const swapOne = () => {
      const q = needle.value;
      if (!q || area.disabled) return;
      if (area.value.slice(area.selectionStart, area.selectionEnd) !== q) step(false);
      if (area.value.slice(area.selectionStart, area.selectionEnd) !== q) { tally(); return; }
      put(area.selectionStart, area.selectionEnd, swap.value);
      refresh();
      step(false);
    };

    const swapAll = () => {
      const q = needle.value;
      if (!q || area.disabled) return;
      const n = tally();
      if (n === 0) return;
      /*
       * **Ctrl+Z で戻せる形で入れ替える。**
       *
       * 丸ごと代入していたので、ブラウザの戻し履歴が消えて、押した人は
       * 置換の前に戻せなかった（欄の巻きとカーソルも頭へ飛ぶ）。一つずつの
       * 置換（`put`）は `setRangeText` を使っているのに、ここだけ素通しだった。
       */
      const next = area.value.split(q).join(swap.value);
      const caret = Math.min(area.selectionStart, next.length);
      const top = area.scrollTop;
      writeRange(0, area.value.length, next);
      area.selectionStart = caret; area.selectionEnd = caret;
      area.scrollTop = top;
      refresh();
      count.textContent = `${n} 件を置き換えました`;
    };

    /** 探す所を出す。出ていれば、打つ所へ手を戻す。 */
    const showFind = (which) => {
      // 手が欄から離れるので、灰色は残さない（見えている所とカーソルがずれる）。
      clearGhost();
      bar.hidden = false;
      tally();
      (which === 'line' ? lineAt : needle).focus?.();
    };
    const hideFind = () => { bar.hidden = true; area.focus(); };

    next.onclick = () => step(false);
    prev.onclick = () => step(true);
    one.onclick = swapOne;
    all.onclick = swapAll;
    shut.onclick = hideFind;
    needle.oninput = () => { tally(); };
    // **変換中の Enter で動かさない。**日本語で探すと、確定のたびに次へ飛ぶ。
    needle.onkeydown = (e) => {
      if (isPlainEnter(e)) { e.preventDefault(); step(e.shiftKey === true); }
      if (e.key === 'Escape') { e.preventDefault(); hideFind(); }
    };
    swap.onkeydown = (e) => { if (isPlainEnter(e)) { e.preventDefault(); swapOne(); } };
    lineAt.onkeydown = (e) => {
      if (!isPlainEnter(e)) return;
      e.preventDefault();
      const n = Number(lineAt.value);
      // **押して何も起きない回を作らない。**数字でなければ、そう言う。
      if (Number.isFinite(n) && n >= 1) goTo(Math.floor(n));
      else state.textContent = '行番号は数字で入れてください';
    };

    /*
     * **後から押した方を、先に頼んだ読み直しで上書きしない。**
     *
     * 応答は頼んだ順に返るとは限らない（大きいファイルの読み直しは、小さいファイルより遅く返る）。
     * AI の書き換えで A を静かに読み直している間に B を押すと、B が出たあとに A の応答が来て、
     * **黙って A に戻していた。**B に打ち始めた字は、そのまま A の欄に入る。
     * 人が押した開き方より前に頼んだもの、いま開いていないファイルの静かな読み直し、
     * 同じファイルの古い読み直しは、返ってきても捨てる。
     */
    let opens = 0;
    let userOpen = 0;
    const open = async (p, line, quiet) => {
      const my = ++opens;
      if (!quiet) userOpen = my;
      // 捨てられたパネルも、返ってきた中身を受け取らない（受け取ると預かりの名札を、死んだパネルのものに書き換える）。
      const stale = () => discarded() || my < userOpen || (quiet === true && (my !== opens || p !== path));
      /*
       * 離れる前に、保存していない分を預かる。預けたときの中身（base）も持つ（戻ったときに変わっていたら、黙って戻さない）。
       * **預けるのは、本当に離れるときだけ。**繋がらずに離れなかったのに預けると、その後の直しと保存の後で古い預かりが残り、
       * 戻ったときに「後から変わっています」と古い版を出させようとした。
       */
      // 作業場が変わっていたら、同じ名前でも別のファイル（`moved`）。
      let moved = false;
      const leave = () => { if (path && (p !== path || moved) && dirty()) drafts.set(K(path), { text: area.value, base: loaded }); };
      let r;
      try {
        r = await fetch(`/api/file?path=${encodeURIComponent(p)}`, { signal: AbortSignal.timeout(20000) });
      } catch (e) {
        if (stale()) return;
        name.textContent = p;
        state.textContent = `開けませんでした（${e.message ?? e}）`;
        return;
      }
      const j = await r.json().catch(() => ({}));
      if (stale()) return;
      if (!r.ok) {
        name.textContent = p;
        state.textContent = j.error ?? '開けませんでした';
        /*
         * **開き直せなかったときに、直している欄を空にしない。**
         *
         * 開いているファイルが消えた・名前が変わった（404）、大きすぎる（413）、
         * 字でないものが入っている（415）状態で同じ名前を押すと、ここで欄を
         * 空にしていた。**開けないので預かりも出せない**＝保存していない直しが
         * どこにも残らない。開けなかっただけなら、欄はそのままにして言う。
         */
        if (p === path && dirty()) {
          keepDraft();
          tell(`開き直せませんでした（${j.error ?? r.status}）。保存していない直しは、欄に残してあります。`, []);
          return;
        }
        leave();
        notice.hidden = true; // 前のファイルの知らせを、空の欄の上に残さない（押すと、空の欄に前の直しが入った）
        area.value = ''; area.disabled = true; path = ''; loaded = '';
        save.disabled = true;
        return;
      }
      moved = typeof j.root === 'string' && j.root !== rootAt && rootAt !== '';
      const raw = String(j.content ?? '');
      const seen = eolOf(raw);
      const text = seen.text;
      /*
       * 全部 CRLF のファイルだけ、CRLF に戻す。混ざっているものは触らない
       * （直していない行まで書き換えることになる）。
       */
      const nextEol = seen.eol;
      /*
       * **行末が混ざっているなら、そう言う。**
       *
       * 欄は `\r\n` を `\n` に直して持つので、混ざったファイルは**開いて保存する
       * だけで LF にそろう**（触っていない行も変わる）。全部 CRLF のものは元の形へ
       * 戻せるが、混ざったものは戻せない。黙って変えない。
       */
      const mixedEol = seen.mixed;
      /*
       * **同じ中身を読み直しただけなら、欄にも、出ている言葉にも触らない。**
       *
       * 手で保存すると、本体はその差分を全員へ配る（`diff`）。配られたものが
       * 自分の書き込みの写しなので、下の `ctx.on('session')` がここを呼び直す。
       * ここで `refresh()` を通っていたので、**「保存しました（+2 -1）」が
       * 「保存してあります」に化けていた。**書けたのか、何行変わったのかが
       * 消えるので、保存できたかどうかを画面から確かめられない。
       *
       * **直している最中も、ここで返す。**ここは直していないときだけ通して
       * いたので、同じファイルを開き直すと**保存していない直しが消えていた**。
       * AI に `show_file` で開かせてから `replace_selection` で書き換えると、
       * 後から返ってくる読み直しが、当てた直しを消す（押して実測）。
       * ファイルの側が変わっていないなら、読み直す意味は無い。
       */
      if (p === path && !moved && text === loaded) {
        name.textContent = p;
        goTo(line);
        return;
      }
      /*
       * **直している最中に、ファイルの側が変わっていた。**黙って捨てない。
       *
       * 自分の直しは預かって、「自分の直しに戻す」から戻せるようにする
       * （AI が書き換えたときと同じ扱い）。ここを素通りさせると、開き直した
       * 瞬間に書いていたものが消える。
       */
      if (p === path && !moved && dirty()) {
        /*
         * **行末をそろえる前のものを渡す。**
         *
         * ここは `eol` を入れてから正規化済みの `text` を渡していた。渡した
         * 先（`takeOver`）は渡されたものから行末を見直すので、`\r\n` の無い
         * `text` では `\n` に戻る。**直している最中に開き直すだけで、次の保存が
         * 全行を書き換えていた**（一覧を押す・探した結果から飛ぶ、で起きる）。
         */
        name.textContent = p;
        takeOver(raw, j.stamp);
        goTo(line);
        return;
      }
      /*
       * **預かった直しを、読み直しで捨てない。**
       *
       * 「AI の版を出す」を押すと、自分の直しは `mine` にだけ残る（預かりは
       * 保存済み扱いで消えている）。そこへもう一度書き換えが来ると、ここで
       * `mine` を捨てていたので、**戻す先が無くなっていた。**同じファイルの
       * 読み直しなら、預かったままにする。
       */
      leave();
      const same = p === path && !moved;
      if (typeof j.root === 'string') rootAt = j.root;
      const key = K(p);
      eol = nextEol;
      path = p; loaded = text; stamp = j.stamp ?? ''; mine = same ? mine : (held.get(key) ?? null);
      notice.hidden = true;
      name.textContent = p;
      // 預けた分が在れば、それを返す（消さずに戻す）。
      // このパネルの中に無ければ、覚えておく所を見る（ブラウザを閉じたあとでも戻せる）。
      let kept;
      let busyElsewhere = false;
      const inPanel = drafts.get(key);
      /*
       * このパネルの中で預けた分。**離れている間にファイルが変わっていたら、黙って戻さない。**
       * 黙って戻すと、開き直しで新しい stamp を取るので、次の保存が AI や別のパネルの書き換えを確かめずに消していた。
       */
      if (inPanel !== undefined && inPanel.base === loaded) { kept = inPanel.text; drafts.delete(key); }
      else {
        const stored = readDraft(p);
        /*
         * 覚えておく所の預かりを、このパネルのものとして扱ってよいか（名札が自分・中身が同じ）。別のパネルの違う直しを、
         * こちらの知らせで片づけたり捨てたりしない。
         */
        const ours = !!stored && (inPanel === undefined || stored.by === DRAFT_ME || stored.text === inPanel.text);
        const saved = inPanel !== undefined ? { text: inPanel.text, base: inPanel.base } : stored;
        if (inPanel === undefined && stored && stored.base === loaded && aliveElsewhere(stored.by)) {
          // 生きている別のパネルの直し。引き取らず、そちらで保存してもらう（ここでは保存した版を出す）。
          tell('このファイルは、別のパネル（または別のタブ）で保存していない直しの途中です。ここでは保存した版を出しています。直しはそちらで保存してください。', [], 'info');
          busyElsewhere = true;
        } else if (inPanel === undefined && stored && stored.base === loaded) { kept = stored.text; adoptDraft(p, stored); }
        else if (saved) {
          if (ours) toldDraft.set(p, stored.at);
          /*
           * パネルの中の預かりは、人が「出す」か「捨てる」を選ぶまで残す（× で閉じても、押さずに離れても、
           * 次に戻ったときにまた出す）。先に消すと、直しがこの知らせのボタンの中にしか無くなり、失っていた。
           */
          let before = '';
          /*
           * **中身が変わっていたら、黙って戻さない。**
           *
           * 預けたときと違うということは、AI か別のブラウザが書いたということ。
           * 古い直しで上書きすると、その書き換えが消える。出すかどうかは人が決める。
           */
          tell('前に保存していない直しが残っていますが、このファイルは後から変わっています。', [
            ['その直しを出す', () => {
              // 戻す先は、この知らせの中だけで持つ（保存を断られたあとの自分の版 `mine` を上書きしない）。
              before = area.value;
              area.value = saved.text;
              drafts.delete(key);
              refresh();
              tell('預かっていた直しを出しました。保存すると、いまのファイルを上書きします。', [
                ['やめる', () => {
                  area.value = before;
                  // やめても、直しは捨てない。預け直して、次に開いたときにまた選べるようにする。
                  drafts.set(key, { text: saved.text, base: saved.base });
                  refresh();
                  tell('戻しました。預かっていた直しは、このファイルを開き直すともう一度出せます。', [], 'info');
                }],
              ]);
            }],
            ['捨てる', () => {
              drafts.delete(key);
              if (ours) dropDraft(p);
              tell('預かっていた直しを捨てました。', [], 'info');
            }],
          ]);
        }
      }
      area.value = kept ?? loaded;
      area.disabled = false;
      refresh();
      // 後の知らせ（行末が混ざっている等）で上の知らせが置き換わっても、なぜ直しが戻らないかを見出しに残す
      if (busyElsewhere) state.textContent = '別のパネルで直している途中';
      if (kept !== undefined && kept !== loaded) state.textContent = '保存していない直しを戻しました（Ctrl+S で保存）';
      if (mixedEol) tell('行末が混ざっています（CRLF と LF）。保存すると LF にそろいます。', [], 'info');
      // 預かったままの直しが在るなら、戻せることを出す（黙って持っていても届かない）。
      if (mine !== null && mine !== area.value) {
        tell('前に預かった直しが残っています。', [
          ['自分の直しに戻す', () => {
            area.value = mine ?? area.value;
            held.delete(key);
            dropHeld(p);
            refresh();
            tell('自分の直しに戻しました。保存すると、いまのファイルを上書きします。', []);
          }],
        ], 'info');
      } else if (mine === null) {
        /*
         * この画面の中には無いが、覚えておく所に「AI の版に取り替える前の自分の直し」が在る（ブラウザを閉じて開き直した）。
         * 黙って戻さず、選ばせる。ほかの知らせ（後から変わっています等）が出ているなら、今回はそちらを先に出す（次に開いたときに出す）。
         */
        const parked = readHeld(p);
        if (parked && parked.text === area.value) dropHeld(p);
        else if (parked && notice.hidden) {
          tell('AI の版に取り替える前の、自分の直しが残っています。', [
            ['その直しを出す', () => {
              area.value = parked.text;
              dropHeld(p);
              refresh();
              tell('自分の直しを出しました。保存すると、いまのファイルを上書きします。', []);
            }],
            ['捨てる', () => { dropHeld(p); tell('取り替える前の直しを捨てました。', [], 'info'); }],
          ]);
        }
      }
      /*
       * **打っている手を、AI の書き込みで奪わない。**
       *
       * ここは開いたら必ず欄へ手を移していた。チャットの欄に打っている途中で
       * AI がそのファイルを書くと、読み直しがここを通って、**続きがファイルの
       * 欄に入る**。人が押して開いたときだけ手を移す。
       */
      if (!quiet) area.focus();
      goTo(line);
    };

    /*
     * いま保存している中身。**自分の保存で流れてくる差分を、自分で受け止める。**
     *
     * 本体は書けた時点で差分を全員へ配る。その写しが**返事より先に戻ってくる**ので、
     * まだ `loaded` を入れ替える前の欄は「直している最中」のままになり、
     * 「AI がこのファイルを書き換えました」と出ていた（押して実測。自分で保存した
     * だけなのに、身に覚えのない書き換えを知らされる）。
     */
    let savingNow = null;
    /** 保存の返事を待つ間に、もう一度保存を頼まれた。 */
    /** 保存の返事を待つ間に頼まれた保存（作業場と名前の組）。頼まれていなければ false。 */
    let storeAgain = false;
    /*
     * 前のファイルの返事を待つ間に、移った先で保存を頼まれていたら、いま続けて保存する。待つ間に頼まれた分は覚えるだけで
     * 返していたので、返事が別のファイルのものだと誰も保存せず、「直しています」のまま黙っていた。`store` は
     * いま開いているファイルの直しと stamp で送るので、移った先へ正しく書く
     */
    const againHere = () => {
      if (!storeAgain) return;
      const asked = storeAgain;
      storeAgain = false;
      // 頼まれたのがいま開いているファイル（同じ作業場）のときだけ。前のファイルで二度押した分を、移った先で保存しない
      if (asked === K(path)) void store();
    };

    /*
     * 次の保存で「無いはずだ」と添えるファイル（作業場と名前の組。消されたあとで作り直すとき）。
     * 一つの真偽で持っていたので、作り直しが断られたあとも残り、別のファイルの保存にまで「無いはずだ」と添えていた
     */
    let absentFor = '';
    /** 守っているファイルだと確かめたファイル（作業場と名前の組。そのファイルの保存では確かめ直さない）。 */
    let protectedOk = '';
    const store = async () => {
      if (!path || !dirty()) return;
      /*
       * **保存の返事を待っている間に、もう一度送らない。**
       *
       * 押し場所は灰色にしていたが、Ctrl+S は素通しだった。続けて二度押すと、二度目は開いたときの古い stamp の
       * まま届き、一度目が書いた中身を「別の所で変わりました（AI の書き換えなど）」と断られる。自分の保存を
       * 身に覚えのない書き換えとして知らされる。返事のあとに、まだ直しが在れば続けて保存する。
       */
      // どのファイル（作業場と名前の組）で頼まれたかを覚える
      if (savingNow !== null) { storeAgain = K(path); return; }
      storeAgain = false;
      save.disabled = true;
      state.textContent = '保存しています…';
      let r;
      savingNow = path;
      /*
       * **保存している間に、別のファイルへ移ることがある。**
       *
       * 返事を読んだところで `path` を見ていたので、移った先へ前のファイルの
       * 結果を当てていた（`loaded` を移った先の中身にして「保存してあります」と
       * 出し、預かりを捨て、stamp も前のファイルのものにする）。移った先の
       * 書きかけが、次の読み直しで消える。**どのファイルの保存かを、覚えておく。**
       */
      const at = path;
      const atRoot = rootAt;
      /*
       * **送った中身を覚えておく。**
       *
       * 返事のあと `loaded` を**いまの** `area.value` にしていた。返事を待つ間
       * （最大 20 秒。モデルが動いていればもっと）に打った字は送っていないのに、
       * `dirty()` が false になり、保存の押し場所は灰色、預かりも消える。
       * **画面とディスクが違うまま、読み直しで打った分を失う。**
       */
      const sent = area.value;
      try {
        r = await fetch('/api/file', {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          // 開いたときの stamp を添える。開いたあとで誰かが書いていたら、本体が断る。
          // 行末は、開いたときの形に戻してから渡す。
          body: JSON.stringify({
            path,
            content: eol === '\n' ? sent : sent.replace(/\n/g, eol),
            ...(stamp ? { stamp } : {}),
            // どの作業場で開いたものか。変わっていたら本体が断る（前の作業場の直しを、新しい作業場へ書かない）。
            ...(rootAt ? { root: rootAt } : {}),
            // 消されたあとで作り直すときは「無いはずだ」と添える（その間に別の所で作られていたら本体が断る）
            ...(absentFor === K(path) ? { absent: true } : {}),
            // 守っているファイルを、確かめたうえで書く
            ...(protectedOk === K(path) ? { confirmProtected: true } : {}),
          }),
          signal: AbortSignal.timeout(20000),
        });
      } catch (e) {
        savingNow = null;
        if (path !== at || rootAt !== atRoot) {
          // **移った先の画面は書き換えないが、保存できなかったことは言う。**
          refresh();
          tell(`${at} を保存できませんでした（${e.message ?? e}）。開き直すと、保存していない直しを戻せます。`, []);
          againHere();
          return;
        }
        // 繋がらなかったときに黙ると、書いたものが消えたように見える。欄は残す。
        state.textContent = `保存できませんでした（${e.message ?? e}）`;
        save.disabled = false;
        return;
      }
      const j = await r.json().catch(() => ({}));
      savingNow = null;
      /*
       * 移った先の画面を、前のファイルの結果で書き換えない。
       *
       * **ただし、書けていないなら言う。**ここは 409（`いま作業中です` は
       * モデルが動いていれば普通に出る）や 500 を丸ごと捨てていた。Ctrl+S の
       * 直後に別のファイルを押すと、**保存できていないことに気づけない。**
       */
      if (path !== at || rootAt !== atRoot) {
        refresh();
        if (!r.ok) {
          tell(`${at} を保存できませんでした（${j.error ?? r.status}）。開き直すと、保存していない直しを戻せます。`, []);
        } else {
          /*
           * 返事の前に離れたので、預かりの base は保存する前の中身のまま。自分の保存を「後から変わっています」と
           * 言わないよう、保存した中身に合わせる（預けた分が保存した分と同じなら、預かりは要らない）。
           */
          const d = drafts.get(K(at, atRoot));
          if (d && d.text === sent) drafts.delete(K(at, atRoot));
          else if (d) d.base = sent;
        }
        againHere();
        return;
      }
      /*
       * **断られたら、選ばせる。**黙って上書きもしないし、黙って捨てもしない。
       * 上書きを選んでも、前の中身は戻り先に残る（本体が控える）。
       */
      // 消えていた・文字でなくなっていたときは、出せる「AI の版」が無い。そう言って、上書きだけ選ばせる。
      if (r.status === 409 && j.conflict && (j.gone || j.binary)) {
        state.textContent = '保存していません（別の所で変わっています）';
        save.disabled = false;
        // 文字でない中身・utf8 でない中身には、本体が書かない（415）。押しても必ず断られる押し場所は出さない。
        tell(j.gone
          ? '保存していません。開いたあとで、このファイルは別の所で消されました。'
          : '保存していません。開いたあとで、このファイルは文字でない中身に書き換えられました（画面からは書けません）。直しは欄と預かりに残してあります。',
        j.gone ? [['自分の版で作り直す', () => { stamp = ''; absentFor = K(at, atRoot); notice.hidden = true; void store(); }]] : []);
        return;
      }
      // 守っているファイル（.env など）。確かめてから書く（.git の中は本体が断る）
      if (r.status === 409 && j.confirm && j.protected) {
        state.textContent = '保存していません（守っているファイル）';
        save.disabled = false;
        if (confirm(j.error)) { protectedOk = K(at, atRoot); void store(); }
        return;
      }
      if (r.status === 409 && j.conflict) {
        // 作り直そうとした間に別の所で作られていた。「無いはずだ」はもう当てはまらない（上書きを選べば、その stamp で送る）
        absentFor = '';
        state.textContent = '保存していません（別の所で変わっています）';
        save.disabled = false;
        tell('保存していません。開いたあとで、このファイルは別の所で変わりました（AI の書き換えなど）。', [
          ['AI の版を出す', () => takeOver(j.content ?? loaded, j.stamp)],
          ['自分の版で上書きする', () => { stamp = j.stamp ?? ''; notice.hidden = true; void store(); }],
        ]);
        return;
      }
      if (!r.ok) { state.textContent = j.error ?? '保存できませんでした'; save.disabled = false; return; }
      absentFor = '';
      loaded = sent;
      stamp = j.stamp ?? stamp;
      // 保存の間に打った分が在れば、それは保存していない。預かりは残す。
      const over = dirty();
      if (over) keepDraft();
      // 保存できたら、預かりは要らない（残すと、次に開いたとき古い方を戻す）。
      else releaseDraft(path);
      /*
       * **保存したことを、補完の返事で消さない。**
       *
       * 打った少しあとに続きを訊きに行く作りなので、打ってすぐ保存すると、
       * 保存が終わったあとに補完が走る。出す先が同じ一行なので
       * 「保存しました（+1 -1）」が「補完を考えています…」から「補完なし」へ
       * 化けていた（押して実測）。**書けたのかどうかが画面から消える。**
       *
       * 保存したということは、続きを待っていないということ。頼んだ分は捨てる。
       */
      clearTimeout(pending);
      asking?.abort();
      refresh();
      state.textContent = over
        ? `保存しました（+${j.added ?? 0} -${j.removed ?? 0}）。保存の間に打った分は、まだ保存していません`
        : `保存しました（+${j.added ?? 0} -${j.removed ?? 0}）`;
      if (storeAgain && over) void store();
      storeAgain = false;
    };
    save.onclick = () => { void store(); };
    // Ctrl+S はこの欄に手があるときだけ。ブラウザの「ページを保存」を出さない。
    area.onkeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); void store(); return; }
      // 普通の作法に合わせる。Ctrl+F で探す、Ctrl+G で行へ飛ぶ。
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); showFind('find'); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'g') { e.preventDefault(); showFind('line'); return; }
      if (e.key === 'Escape' && !bar.hidden && !suggestion) { e.preventDefault(); hideFind(); return; }
      // Ctrl+Space で、待たずに補完を頼む。
      if ((e.ctrlKey || e.metaKey) && e.key === ' ') { e.preventDefault(); void askCompletion(); return; }
      if (e.key === 'Escape' && suggestion) { e.preventDefault(); clearGhost(); refresh(); return; }
      /*
       * **カーソルが動いたら、灰色を消す。**
       *
       * 消していたのは打ったとき・押したとき・Esc のときだけだった。カーソルキーで
       * 動かすと灰色は出たままなので、そこで Tab を押すと**見えていない所へ
       * 補完が入る**（字下げのつもりで押した人が、知らない字を入れてしまう）。
       */
      if (suggestion && MOVES.has(e.key)) { clearGhost(); refresh(); return; }
      /*
       * **Enter で、字下げを引き継ぐ。**
       *
       * 引き継いでいなかったので、深い所を書くたびに次の行が頭（0 列）から
       * 始まり、人が空白を打ち直していた。前の行の頭にある空白を、そのまま置く。
       *
       * 変換中（日本語の確定）の Enter は奪わない。奪うと確定のたびに
       * 余分な改行が入る（会話の欄で一度やった形）。
       */
      if (isPlainEnter(e) && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const at = area.selectionStart;
        const from = area.value.lastIndexOf('\n', at - 1) + 1;
        const indent = /^[ \t]*/.exec(area.value.slice(from, at))?.[0] ?? '';
        if (indent === '') return; // 引き継ぐものが無い。既定の改行に任せる。
        e.preventDefault();
        clearGhost();
        writeRange(at, area.selectionEnd, `\n${indent}`);
        refresh();
        return;
      }

      /*
       * Tab で欄から抜けない。灰色が出ていればそれを入れ、無ければ字下げ。
       *
       * **選んだ範囲を消していた。**数行選んで押すと、選んだ行が丸ごと空白二つに
       * なった（字下げのつもりで押して、書いたものを失う）。行にまたがる選択は
       * 行ごとに字下げして、選んだ範囲を選んだまま返す。Shift+Tab で戻す。
       * 一行の中の選択とカーソルだけのときは、これまでどおり空白二つを入れる。
       */
      if (e.key === 'Tab') {
        e.preventDefault();
        if (!e.shiftKey && acceptGhost()) return;
        const { selectionStart: a, selectionEnd: b } = area;
        const spansLines = area.value.slice(a, b).includes('\n');
        if (!e.shiftKey && !spansLines) {
          writeRange(a, b, '  ');
          refresh();
          return;
        }
        // 選んでいる行の、頭から終わりまでを取り直す（行の途中で切らない）。
        const from = area.value.lastIndexOf('\n', a - 1) + 1;
        // 行を丸ごと選ぶと、終わりは次の行の頭に来る。その行は選んでいないので、字下げしない
        const endAt = b > a && area.value[b - 1] === '\n' ? b - 1 : b;
        const tail = area.value.indexOf('\n', endAt);
        const to = tail < 0 ? area.value.length : tail;
        let head = 0;
        let moved = 0;
        const lines = area.value.slice(from, to).split('\n').map((line, i) => {
          if (e.shiftKey) {
            const cut = /^ {1,2}/.exec(line)?.[0].length ?? 0;
            if (i === 0) head = -cut;
            moved -= cut;
            return line.slice(cut);
          }
          // 空の行に空白を足さない（見えない字を残さない）。
          if (line === '') return line;
          if (i === 0) head = 2;
          moved += 2;
          return `  ${line}`;
        });
        writeRange(from, to, lines.join('\n'));
        // 行にまたがる選択は、行の頭から選び直す（続けて押せる形にする）。
        // カーソルだけのときは、動いたぶんだけずらす。
        const start = spansLines ? from : Math.max(from, a + head);
        area.setSelectionRange(start, Math.max(start, b + moved));
        refresh();
      }
    };

    /* ---- Tab 補完 ----
     * 手が止まって少し経ったら、前後を渡して続きをもらう。灰色で見せて、
     * Tab で入れる。Esc か、何か打てば消える。行の途中（右に字がある所）
     * では出さない。灰色と実物が重なって読めなくなる。
     */
    /** カーソルを動かす打ち方。ここでは灰色を消す。 */
    const MOVES = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
    let suggestion = '';
    /*
     * 灰色を描いたときのカーソルの位置。**見えていた所と違う所へ入れない。**
     *
     * 灰色が出たままカーソルキーで動かして Tab を押すと、`acceptGhost` は**いまの**
     * カーソルへ差し込んでいた。見えていた場所と違う所に入り、字下げのつもりの
     * Tab が字下げにならない（選んだ範囲も字下げされない）。
     */
    let ghostAt = -1;
    let pending = 0;
    let asking = null;
    const clearGhost = () => { suggestion = ''; ghostAt = -1; ghost.textContent = ''; };
    const drawGhost = () => {
      if (!suggestion) return clearGhost();
      const at = area.selectionStart;
      ghostAt = at;
      ghost.replaceChildren(
        Object.assign(document.createElement('span'), { className: 'ghost-before', textContent: area.value.slice(0, at) }),
        Object.assign(document.createElement('span'), { className: 'ghost-text', textContent: suggestion }),
      );
      ghost.scrollTop = area.scrollTop; ghost.scrollLeft = area.scrollLeft;
    };
    const askCompletion = async () => {
      // 捨てたパネルは訊かない（補完のモデルを無駄に叩く）
      if (!path || area.disabled || discarded()) return;
      const at = area.selectionStart;
      if (at !== area.selectionEnd) return;
      const rest = area.value.slice(at, area.value.indexOf('\n', at) < 0 ? undefined : area.value.indexOf('\n', at));
      if (rest.trim() !== '') return; // 行の途中では出さない
      if (asking) asking.abort();
      const ac = new AbortController();
      asking = ac;
      const prefix = area.value.slice(0, at);
      const suffix = area.value.slice(at);
      state.textContent = '補完を考えています…';
      let r;
      try {
        r = await fetch('/api/complete', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path, prefix, suffix }),
          signal: AbortSignal.any([ac.signal, AbortSignal.timeout(15000)]),
        });
      } catch (e) {
        if (!ac.signal.aborted) state.textContent = `補完できませんでした（${e.message ?? e}）`;
        return;
      }
      if (ac.signal.aborted) return;
      const j = await r.json().catch(() => ({}));
      // 断られた（400・500）ときは why が無いので、見ないと黙る
      if (!r.ok) { state.textContent = `補完できませんでした（${j.error ?? r.status}）`; return; }
      // 訊いている間に打っていたら、古い答えは捨てる。
      if (area.selectionStart !== at || area.value.slice(0, at) !== prefix) return;
      /*
       * **長い断りを、見出しへ流し込まない。**
       *
       * 「補完なし（…に GGUF がありません。設定 → モデル に…）」をそのまま
       * 見出しに入れていたので、見出しが 3 行に折れ、**ファイル名が 47px まで
       * 潰れて**「head-pro…」になり、保存の押し場所まで二段になっていた（実測）。
       * 見出しは一行のものだけにして、長い話は帯で読ませる。
       */
      if (!j.text) {
        refresh();
        if (j.why) { state.textContent = '補完なし'; tell(`補完しませんでした。${j.why}`, [], 'info'); }
        return;
      }
      suggestion = j.text;
      drawGhost();
      state.textContent = 'Tab で入れる・Esc で消す';
    };
    const scheduleCompletion = () => {
      clearTimeout(pending);
      pending = setTimeout(() => { void askCompletion(); }, 700);
    };
    const acceptGhost = () => {
      if (!suggestion) return false;
      const at = area.selectionStart;
      // 描いた所から動いていたら、入れない（Tab は字下げに戻す）。
      if (at !== ghostAt || at !== area.selectionEnd) { clearGhost(); refresh(); return false; }
      writeRange(at, at, suggestion);
      clearGhost();
      refresh();
      return true;
    };
    area.addEventListener('input', () => { clearGhost(); scheduleCompletion(); });
    area.addEventListener('scroll', () => {
      ghost.scrollTop = area.scrollTop; ghost.scrollLeft = area.scrollLeft;
      gutter.scrollTop = area.scrollTop;
    });
    area.addEventListener('click', clearGhost);
    ctx.acceptGhost = acceptGhost;

    /*
     * **同じファイルを、同じ名前で持つ。**
     *
     * AI から来る道（`show_file`・書き換えの差分・`replace_selection`）は、モデルが書いたままの形で届く
     * （`./src/a.ts`・`src\\a.ts`）。横の一覧は `src/a.ts`。比べる所（`v.path !== path`）で別のファイルと
     * 見て、**直している最中のファイルを AI が書き換えても、読み直しも知らせも出なかった**。預かりの鍵も
     * 二つに割れる。開く所と比べる所で、同じ形にそろえる。
     */
    const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    ctx.openFile = (p, line) => { void open(norm(p), line); };
    /*
     * **AI が、選んでいた所を書き換えた（`replace_selection`）。**
     *
     * 入れ替えるのは欄の中だけで、**保存はしない**（人が見て、良ければ保存する）。
     * 選んだ所は人が動かせるので、**渡された字がまだそこに在るときだけ**入れ替える。
     * 入れ替える前の中身は預かって、「元に戻す」で戻せるようにする。
     */
    ctx.applyPatch = (at) => {
      if (!path || norm(at.path) !== path) return false;
      const head = lineStart(area.value, at.from);
      const tail = lineStart(area.value, at.to);
      const now = area.value.slice(head.at, tail.end);
      if (now !== at.text) {
        /*
         * **知らせの帯だけに頼らない。**
         *
         * ここは `info` なので、消えるものが在る知らせ（割れている等）が出て
         * いると押しのけない＝**完全に無音**になる。一行の所にも出す。
         */
        state.textContent = 'AI の直しは入れられませんでした（選んでいた所が動いています）';
        tell('AI の直しを入れられませんでした（選んでいた所が動いています）。', [], 'info');
        return false;
      }
      mine = area.value;
      held.set(K(path), mine);
      // 丸ごと代入すると Ctrl+Z の履歴が消える。置き換える所だけを入れ替える。
      if (typeof area.setRangeText === 'function') area.setRangeText(at.replacement, head.at, tail.end, 'end');
      else area.value = `${area.value.slice(0, head.at)}${at.replacement}${area.value.slice(tail.end)}`;
      select(head.at, head.at + at.replacement.length);
      refresh();
      tell('AI が、選んでいた所を書き換えました（まだ保存していません）。', [
        ['元に戻す', () => {
          area.value = mine ?? area.value;
          held.delete(K(path));
          refresh();
          tell('元に戻しました。', [], 'info');
        }],
      ]);
      return true;
    };
    /*
     * **いま開いている所を、AI に渡せるようにする。**
     *
     * ここまで、AI は開いているファイルも選んでいる所も知らなかった。
     * 「この関数を直して」と打っても、どこの話か分からない（人は画面を見ながら
     * 打つので、指せていると思っている）。
     *
     * 渡すのは、名前・カーソルの行・選んでいる字だけ。**中身は丸ごと渡さない**
     * （毎回コンテキストウィンドウを食う。読みたければ AI が `read_file` を呼ぶ）。
     * 上限は送る側（`src/ui/server.ts`）で決める。
     */
    ctx.editorNow = () => {
      if (!path) return null;
      const before = area.value.slice(0, area.selectionStart);
      const line = before.split('\n').length;
      const picked = area.value.slice(area.selectionStart, area.selectionEnd);
      return {
        path,
        line,
        ...(picked ? { selection: picked, selectionFrom: line, selectionTo: before.split('\n').length + picked.split('\n').length - 1 } : {}),
        ...(dirty() ? { dirty: true } : {}),
      };
    };
    /*
     * モデルが書き換えたら、開いているものは読み直す（直している最中は上書きしない）。
     *
     * **直している最中でも、黙らない。**上書きしないのは正しいが、何も言わないと
     * ファイルと欄が割れていることに気づけず、保存した方が相手を消す。
     */
    /*
     * 書き換えは、会話の流れ（`session`）だけでなく、段取りで進める流れ（`planEvent`）からも、見ていない会話
     * （`elsewhereDiff`。画面は見ている会話の出来事しか流さないので、差分だけを別に渡してもらう）からも来る。
     * 会話の流れしか見ていなかったので、`/plan` や裏の会話が開いているファイルを書いても、欄は古いまま
     * 「保存してあります」と出し、直している最中でも何も言わなかった。
     */
    const onDiff = ({ event: v }) => {
      if (v?.type !== 'diff' || norm(v.path) !== path) return;
      // 自分がいま保存した分の写し。返事を読んだところで入れ替えるので、ここでは何もしない。
      if (savingNow === v.path) return;
      if (!dirty()) { void open(path, undefined, true); return; }
      tell('AI がこのファイルを書き換えました。あなたの直しは保存していません。', [
        ['AI の版を出す', () => {
          void (async () => {
            // 読みに行っている間に別のファイルへ移ったら、移った先へ前のファイルの中身を入れない。
            const at = path;
            const atRoot = rootAt;
            const r = await fetch(`/api/file?path=${encodeURIComponent(at)}`, { signal: AbortSignal.timeout(20000) })
              .catch(() => null);
            const said = r ? await r.json().catch(() => null) : null;
            if (path !== at || rootAt !== atRoot || discarded()) return;
            // 断られたら、その理由を出す（utf8 でない形に書き換えられた等）。
            if (!r || !r.ok || !said) { state.textContent = said?.error ?? '読み直せませんでした'; return; }
            // 作業場が変わっていたら、別の作業場の同じ名前のファイルを AI の版として出さない
            if (typeof said.root === 'string' && atRoot && said.root !== atRoot) {
              state.textContent = '作業場が変わったので、この直しの AI の版は出せません';
              return;
            }
            const got = said;
            takeOver(got.content, got.stamp);
          })();
        }],
      ]);
    };
    ctx.on('session', onDiff);
    ctx.on('planEvent', onDiff);
    ctx.on('elsewhereDiff', onDiff);
  },
};

/*
 * 画面に出す名前。
 *
 * **こちらで作った言葉を置かない。**「人員」「土台」「作業場」「流れ」は
 * このプロジェクトの中でだけ通じる言い方で、初めて見た人には何の画面か
 * 分からない。
 *
 * 普通のアプリで使われている言葉にする。迷ったら、説明が要らない方を選ぶ。
 */
export const TITLES = {
  conversation: 'チャット',
  plan: '実行中のタスク',
  roster: 'ロール',
  memory: 'メモリ',
  proposals: '提案',
  duties: '定期実行',
  models: 'モデル',
  changes: '変更したファイル',
  search: '探す',
  log: 'ログ',
  note: 'メモ',
  checks: '診断',
  preview: 'プレビュー',
  editor: 'エディタ',
};
