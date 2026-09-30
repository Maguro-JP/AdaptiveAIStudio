/**
 * 答えを、読める形で出す。
 *
 * 答えはそのまま textContent に流していた。モデルが書く ``` の囲いも
 * 見出しも、記号のまま並ぶ。**書いたコードが、コードとして読めない。**
 * Cursor も Claude も、囲いは枠にして、写せるようにしている。
 *
 * innerHTML は使わない。答えは外から来たものなので、文字列を HTML として
 * 読ませない。ここで木を組む。流れている途中（囲いが閉じていない）でも、
 * そこまでをコードとして出す。
 */

/** 文を塊に切る。純粋関数。試験はここを見る。 */
function parseBlocks(text) {
  // CRLF の \r を残すと、見出しや箇条書きの `(.*)$` が行末まで届かず、どの塊にも当たらない
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 言語名の後ろに何か書いてある囲い（```python main.py）も囲い。段落の側は ``` で始まる行を切れ目とみなすので、揃える
    const fence = /^\s*````*\s*([^`\s]*)[^`]*$/.exec(line);
    if (fence) {
      const body = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (/^\s*````*\s*$/.test(lines[i])) { closed = true; i++; break; }
        body.push(lines[i]); i++;
      }
      blocks.push({ type: 'code', lang: fence[1] ?? '', text: body.join('\n'), closed });
      continue;
    }
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) { blocks.push({ type: 'heading', level: head[1].length, text: head[2] }); i++; continue; }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const items = [];
      const ordered = /^\s*\d/.test(line);
      while (i < lines.length) {
        const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        // 番号付きと点の箇条書きは、別の塊にする。
        if (!m || /^\s*\d/.test(lines[i]) !== ordered) break;
        items.push(m[1]); i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^\s*```/.test(lines[i])
      && !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    // どの塊にも当たらず段落も切れ目で止まった行（```a```b のような形）。一行の段落にして必ず進める（進まないと画面が固まる）
    if (para.length === 0) { para.push(lines[i]); i++; }
    blocks.push({ type: 'para', text: para.join('\n') });
  }
  return blocks;
}

/** 行の中の `code` と **bold** を切る。純粋関数。 */
function parseInline(text) {
  const out = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ type: 'text', text: text.slice(last, at) });
    const t = m[0];
    if (t.startsWith('`')) out.push({ type: 'code', text: t.slice(1, -1) });
    else out.push({ type: 'bold', text: t.slice(2, -2) });
    last = at + t.length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

/** 塊を DOM にする。`doc` は document。 */
function renderMarkdown(text, doc, opts = {}) {
  const frag = doc.createDocumentFragment();
  const inline = (parent, s) => {
    for (const p of parseInline(s)) {
      if (p.type === 'text') parent.append(doc.createTextNode(p.text));
      else if (p.type === 'code') { const c = doc.createElement('code'); c.textContent = p.text; parent.append(c); }
      else { const b = doc.createElement('strong'); b.textContent = p.text; parent.append(b); }
    }
  };
  for (const b of parseBlocks(text)) {
    if (b.type === 'code') {
      const box = doc.createElement('div');
      box.className = 'code-block';
      const head = doc.createElement('div');
      head.className = 'code-head';
      const lang = doc.createElement('span');
      lang.className = 'code-lang';
      lang.textContent = b.lang || 'text';
      head.append(lang);
      const copy = doc.createElement('button');
      copy.type = 'button';
      copy.className = 'code-copy';
      copy.textContent = '写す';
      copy.onclick = () => {
        const write = opts.copy ?? ((s) => globalThis.navigator?.clipboard?.writeText(s));
        Promise.resolve(write(b.text)).then(
          () => { copy.textContent = '写しました'; setTimeout(() => { copy.textContent = '写す'; }, 1500); },
          () => { copy.textContent = '写せません'; },
        );
      };
      head.append(copy);
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = b.text;
      pre.append(code);
      box.append(head, pre);
      frag.append(box);
    } else if (b.type === 'heading') {
      const h = doc.createElement(`h${Math.min(6, b.level + 2)}`);
      inline(h, b.text);
      frag.append(h);
    } else if (b.type === 'list') {
      const ul = doc.createElement(b.ordered ? 'ol' : 'ul');
      for (const it of b.items) { const li = doc.createElement('li'); inline(li, it); ul.append(li); }
      frag.append(ul);
    } else {
      const p = doc.createElement('p');
      inline(p, b.text);
      frag.append(p);
    }
  }
  return frag;
}

export { parseBlocks, parseInline, renderMarkdown };
