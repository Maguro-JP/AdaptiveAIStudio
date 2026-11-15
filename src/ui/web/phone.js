/**
 * スマホの画面（docs/PHONE.md）。パスフレーズで繋ぎ、頼みを送り、答えを流して見せる。
 *
 * 繋がっているかは、トークン（Cookie）が効くかで見る。効かなければパスフレーズの画面を出す。
 * QR から開いたときは URL の # の後ろにパスフレーズが入っているので、押さずに繋ぐ（# の後ろは本体へ送られない）。
 */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

let conversationId = null;
let current = null;
let source = null;

function show(view) {
  $('pairView').hidden = view !== 'pair';
  $('chatView').hidden = view !== 'chat';
  if (view === 'pair') $('pass').focus();
}

function add(kind, text) {
  $('empty')?.remove();
  const p = document.createElement('div');
  p.className = `msg ${kind}`;
  p.textContent = text;
  $('log').append(p);
  p.scrollIntoView({ block: 'end' });
  return p;
}

function setState(text, down = false) {
  $('state').textContent = text;
  $('state').classList.toggle('down', down);
}

async function paired() {
  const r = await fetch('/api/events/seq', { cache: 'no-store' }).catch(() => undefined);
  if (!r) return { ok: false, why: 'PC の本体に届きません。PC が起きていて、同じ Wi-Fi に繋がっているか見てください' };
  if (r.status === 401) return { ok: false };
  if (!r.ok) return { ok: false, why: ((await r.json().catch(() => ({}))).error) ?? `繋がりません（${r.status}）` };
  return { ok: true, seq: (await r.json()).seq };
}

async function pair(passphrase) {
  const note = $('pairNote');
  note.className = 'note';
  note.textContent = '繋いでいます…';
  $('pairGo').setAttribute('disabled', '');
  try {
    const r = await fetch('/api/phone/pair', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { note.className = 'note bad'; note.textContent = body.error ?? `繋げませんでした（${r.status}）`; return false; }
    note.textContent = '繋がりました';
    return true;
  } catch {
    note.className = 'note bad';
    note.textContent = 'PC の本体に届きません。同じ Wi-Fi に繋がっているか見てください';
    return false;
  } finally {
    $('pairGo').removeAttribute('disabled');
  }
}

function listen(since) {
  source?.close();
  source = new EventSource(Number.isInteger(since) ? `/api/events?since=${since}` : '/api/events');
  source.onopen = () => setState('つながっています');
  source.onerror = () => setState('PC の本体と切れています（繋ぎ直しています）', true);
  source.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'approval') return approval(e.id, e.request);
    if (e.type === 'approvalDone') return document.querySelector(`[data-approval="${CSS.escape(e.id)}"]`)?.remove();
    if (!conversationId || e.conversationId !== conversationId) return;
    if (e.type === 'busy') {
      setState(e.busy ? '作業中' : '待機中');
      if (!e.busy && current) { current.classList.remove('working'); if (!current.textContent) current.textContent = '（答えはありませんでした）'; current = null; }
      return;
    }
    if (e.type !== 'session') return;
    const v = e.event;
    if (v.type === 'text') {
      if (!current) current = add('ai working', '');
      // 頭の改行は捨てる（考えた部分を外した後に改行だけが残り、答えの上が空いて見えた）
      const piece = current.textContent ? (v.delta ?? '') : String(v.delta ?? '').trimStart();
      current.textContent += piece;
      current.scrollIntoView({ block: 'end' });
    } else if (v.type === 'toolStart') {
      add('tool', `▸ ${v.summary ?? v.name}`);
      if (current) { current.classList.remove('working'); current = null; }
    } else if (v.type === 'log' && v.level === 'error') {
      add('bad', v.text);
    }
  };
}

function approval(id, request) {
  const box = document.createElement('div');
  box.className = 'approval';
  box.dataset.approval = id;
  const what = request.kind === 'write' ? `${request.path} を書き換えます`
    : request.kind === 'command' ? 'コマンドを動かします'
    : request.kind === 'network' ? '外へ取りに行きます' : '確かめてください';
  const h = document.createElement('strong');
  h.textContent = what;
  const pre = document.createElement('pre');
  pre.textContent = request.command ?? request.url ?? request.diff ?? request.summary ?? '';
  const row = document.createElement('div');
  row.className = 'row';
  for (const [label, approved] of [['許可', true], ['拒否', false]]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (approved) b.className = 'big';
    b.onclick = async () => {
      b.disabled = true;
      const r = await fetch('/api/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, approved }) }).catch(() => undefined);
      // 届かなかったら残して、もう一度押せるようにする（消えると押したつもりで終わる）
      if (!r?.ok && r?.status !== 404) { b.disabled = false; add('bad', '承認を届けられませんでした。もう一度押してください'); return; }
      box.remove();
    };
    row.append(b);
  }
  box.append(h, pre, row);
  $('approvals').append(box);
}

async function openChat(seq) {
  show('chat');
  listen(seq);
  try {
    const r = await fetch('/api/approvals');
    if (r.ok) for (const a of (await r.json()).approvals ?? []) approval(a.id, a.request);
  } catch { /* これから来る分だけ */ }
  $('ask').focus();
}

$('pairForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (await pair(/** @type {HTMLInputElement} */ ($('pass')).value)) {
    const s = await paired();
    if (s.ok) await openChat(s.seq);
  }
});

$('sendForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const box = /** @type {HTMLTextAreaElement} */ ($('ask'));
  const text = box.value.trim();
  if (!text) return;
  add('me', text);
  box.value = '';
  $('sendGo').setAttribute('disabled', '');
  try {
    const r = await fetch('/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, conversationId }) });
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) { show('pair'); return; }
    if (!r.ok) { add('bad', body.error ?? `送れませんでした（${r.status}）`); return; }
    if (body.conversationId) conversationId = body.conversationId;
    setState(body.queued ? `順番待ち（${body.queued} 番目）` : '作業中');
  } catch {
    add('bad', 'PC の本体に届きませんでした。書いたものは上に残っています');
  } finally {
    $('sendGo').removeAttribute('disabled');
  }
});

// Enter で改行、送るのは「送る」を押す（スマホの入力で誤って送らない）。PC のキーボードなら Ctrl+Enter でも送る
$('ask').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); $('sendForm').requestSubmit(); }
});

$('newChat').onclick = () => {
  conversationId = null;
  current = null;
  $('log').replaceChildren();
  add('tool', '新しい会話です');
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => undefined);

const fromQr = new URLSearchParams(location.hash.slice(1)).get('p');
if (fromQr) history.replaceState(null, '', location.pathname);
const first = await paired();
if (first.ok) await openChat(first.seq);
else {
  show('pair');
  if (first.why) { $('pairNote').className = 'note bad'; $('pairNote').textContent = first.why; }
  if (fromQr) {
    /** @type {HTMLInputElement} */ ($('pass')).value = fromQr;
    if (await pair(fromQr)) { const s = await paired(); if (s.ok) await openChat(s.seq); }
  }
}
