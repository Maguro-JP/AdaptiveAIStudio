/**
 * 差分の見せ方。
 *
 * 「+12 -3」とだけ言われても、何が起きたのかは分からない。
 * 変わった行そのものを、赤と緑で、行番号を添えて出す。
 * これが読めるかどうかで、任せられるかどうかが決まる。
 *
 * 変わっていないところは畳む。全部見せると、変わったところが埋もれる。
 */

/** 前後に残す、変わっていない行の数。 */
const CONTEXT = 3;

/**
 * unified diff を、行の並びに解く。
 * 読めない形でも投げない。読めたところまでを返す。
 */
export function parseDiff(text) {
  const files = [];
  let file = null;
  let oldNo = 0;
  let newNo = 0;
  // 何番目の塊の、何行目か。戻すときに本体へ言うため。
  let hunk = -1;
  let at = 0;

  for (const raw of String(text ?? '').split('\n')) {
    if (raw.startsWith('--- ')) {
      continue;
    }
    if (raw.startsWith('+++ ')) {
      file = { path: raw.slice(4).replace(/^b\//, '').trim(), lines: [], added: 0, removed: 0 };
      files.push(file);
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = m ? Number(m[1]) : 1;
      newNo = m ? Number(m[2]) : 1;
      hunk += 1; at = 0;
      if (file && file.lines.length > 0) file.lines.push({ kind: 'gap' });
      if (file) file.lines.push({ kind: 'hunk', hunk });
      continue;
    }
    if (!file) continue;

    if (raw.startsWith('+')) {
      file.lines.push({ kind: 'add', newNo: newNo++, text: raw.slice(1), hunk, at: at++ });
      file.added += 1;
    } else if (raw.startsWith('-')) {
      file.lines.push({ kind: 'del', oldNo: oldNo++, text: raw.slice(1), hunk, at: at++ });
      file.removed += 1;
    } else if (raw.startsWith('\\')) {
      // 「改行が無い」の注記。行としては数えない。
    } else {
      file.lines.push({ kind: 'same', oldNo: oldNo++, newNo: newNo++, text: raw.replace(/^ /, ''), hunk, at: at++ });
    }
  }
  return files;
}

/**
 * 変わっていない行が続くところを畳む。
 * 前後 CONTEXT 行は残す。何の周りの変更なのかが分からなくなるため。
 */
export function collapse(lines, context = CONTEXT) {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === 'add' || l.kind === 'del' || l.kind === 'gap' || l.kind === 'hunk') {
      for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j += 1) {
        keep[j] = true;
      }
    }
  });

  const out = [];
  let hidden = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (hidden > 0) { out.push({ kind: 'folded', count: hidden }); hidden = 0; }
      out.push(l);
    } else {
      hidden += 1;
    }
  });
  if (hidden > 0) out.push({ kind: 'folded', count: hidden });
  return out;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/**
 * 差分を描く。
 * mode は 'unified'（1本）か 'split'（左右）。
 */
export function renderDiff(text, opts = {}) {
  const box = el('div', 'diffview');
  const files = parseDiff(text);
  if (files.length === 0) {
    box.append(el('div', 'empty', '差分がありません。'));
    return box;
  }

  for (const file of files) {
    const card = el('div', 'diff-file');

    const head = el('div', 'diff-head');
    head.append(el('span', 'diff-path mono', file.path));
    const stat = el('span', 'diff-stat');
    stat.append(el('span', 'good', `+${file.added}`), el('span', 'bad', `-${file.removed}`));
    head.append(stat);

    const body = el('div', 'diff-body');
    let mode = opts.mode ?? 'unified';

    const toggle = el('button', 'ghost tiny', mode === 'unified' ? '左右で見る' : '1本で見る');
    const copy = el('button', 'ghost tiny', 'コピー');
    copy.onclick = () => {
      navigator.clipboard?.writeText(text).then(
        () => { copy.textContent = 'コピーしました'; setTimeout(() => { copy.textContent = 'コピー'; }, 1200); },
        () => { copy.textContent = 'コピーできません'; },
      );
    };
    toggle.onclick = () => {
      mode = mode === 'unified' ? 'split' : 'unified';
      toggle.textContent = mode === 'unified' ? '左右で見る' : '1本で見る';
      body.replaceChildren(mode === 'unified' ? unified(file, opts) : split(file));
    };
    head.append(toggle, copy);

    body.append(mode === 'unified' ? unified(file, opts) : split(file));
    card.append(head, body);
    box.append(card);
  }
  return box;
}

function gutter(value) {
  return el('span', 'diff-no', value === undefined ? '' : String(value));
}

/**
 * 1 本で描く。`opts.onRevert(picks)` が渡されていれば、当てた変更を
 * **塊ごと・行ごとに戻す**押しボタンを添える（Cursor の Reject に当たる）。
 */
function unified(file, opts = {}) {
  const table = el('div', 'diff-lines');
  const revert = typeof opts.onRevert === 'function' ? opts.onRevert : null;
  for (const l of collapse(file.lines)) {
    if (l.kind === 'folded') {
      table.append(el('div', 'diff-row folded', `⋯ ${l.count} 行`));
      continue;
    }
    if (l.kind === 'gap') continue;
    if (l.kind === 'hunk') {
      if (!revert) continue;
      const row = el('div', 'diff-row hunk');
      const b = el('button', 'ghost tiny revert-hunk', 'この塊を戻す');
      b.onclick = () => revert([{ hunk: l.hunk }]);
      row.append(b);
      table.append(row);
      continue;
    }
    const row = el('div', `diff-row ${l.kind}`);
    row.append(gutter(l.oldNo), gutter(l.newNo));
    row.append(el('span', 'diff-sign', l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '));
    row.append(el('span', 'diff-text', l.text));
    if (revert && l.kind !== 'same') {
      const b = el('button', 'ghost tiny revert-line', '戻す');
      b.title = 'この行だけ戻す';
      b.onclick = () => revert([{ hunk: l.hunk, lines: [l.at] }]);
      row.append(b);
    }
    table.append(row);
  }
  return table;
}

/**
 * 左右に並べる。
 * 消えた行と足された行を向かい合わせにすると、書き換えが読み取りやすい。
 */
function split(file) {
  const wrap = el('div', 'diff-split');
  const left = el('div', 'diff-lines');
  const right = el('div', 'diff-lines');

  const rows = collapse(file.lines);
  let i = 0;
  const pushBlank = (side) => side.append(el('div', 'diff-row blank'));
  const pushRow = (side, l, kind) => {
    const row = el('div', `diff-row ${kind}`);
    row.append(gutter(kind === 'del' ? l.oldNo : kind === 'add' ? l.newNo : l.oldNo ?? l.newNo));
    row.append(el('span', 'diff-text', l.text));
    side.append(row);
  };

  while (i < rows.length) {
    const l = rows[i];
    if (l.kind === 'folded') {
      for (const side of [left, right]) side.append(el('div', 'diff-row folded', `⋯ ${l.count} 行`));
      i += 1;
      continue;
    }
    if (l.kind === 'gap' || l.kind === 'hunk') { i += 1; continue; }
    if (l.kind === 'same') {
      pushRow(left, l, 'same');
      pushRow(right, l, 'same');
      i += 1;
      continue;
    }
    // 消えた行と足された行を、順に向かい合わせる
    const dels = [];
    const adds = [];
    while (i < rows.length && rows[i].kind === 'del') dels.push(rows[i++]);
    while (i < rows.length && rows[i].kind === 'add') adds.push(rows[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k += 1) {
      if (dels[k]) pushRow(left, dels[k], 'del'); else pushBlank(left);
      if (adds[k]) pushRow(right, adds[k], 'add'); else pushBlank(right);
    }
  }

  wrap.append(left, right);
  return wrap;
}

/**
 * 差分を、塊ごとの差分へ割る。
 *
 * **全部通すか全部戻すか、にしないため。**3か所直したうちの1か所だけが
 * 違うときに、直っている2か所ごと捨てさせない。
 * 割ったものは、それぞれ単体の差分として `renderDiff` に渡せる。
 */
export function splitHunkTexts(text) {
  const lines = String(text ?? '').split('\n');
  const head = lines.filter((l) => l.startsWith('--- ') || l.startsWith('+++ '));
  const out = [];
  let now = null;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (now) out.push(now);
      now = { header: line, lines: [line] };
      continue;
    }
    if (!now) continue;
    now.lines.push(line);
  }
  if (now) out.push(now);
  return out.map((h) => ({ header: h.header, text: [...head, ...h.lines].join('\n') }));
}
