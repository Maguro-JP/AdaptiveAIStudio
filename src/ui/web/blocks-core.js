/**
 * ブロックでつくる画面の中身（画面を持たない部分）。
 *
 * ブロックの種類、つなげるかの判定、組んだ形から JavaScript を作る、保存の形を読む・書く、元に戻す。
 * 画面（blocks.js）と試験（test/blocks-core.test.ts）の両方から読む。外の部品は使わない。
 * 設計は docs/BLOCKS.md。
 */

/** つなぎ口の型。色は画面の CSS 変数の名前（--port-num など）で塗る。 */
export const TYPES = {
  num: { label: '数' },
  text: { label: '文字' },
  bool: { label: '真偽' },
  list: { label: '一覧' },
  any: { label: 'なんでも' },
};

const CALC_OPS = { '+': '+', '−': '-', '×': '*', '÷': '/', '余り': '%' };
const COMPARE_OPS = { '=': '===', '≠': '!==', '<': '<', '≦': '<=', '>': '>', '≧': '>=' };
const DAYS = { '今日': 0, '明日': 1, 'あさって': 2 };

/**
 * ブロックの種類。inputs の default は、つないでいないときにブロックの中で書く値。
 * fields は選ぶもの（計算の記号など）。
 */
export const BLOCKS = {
  number: { title: '数', group: '値', inputs: [], outputs: [{ name: 'out', label: '数', type: 'num' }], fields: [{ name: 'value', label: '数', kind: 'num', default: 0 }] },
  text: { title: '文字', group: '値', inputs: [], outputs: [{ name: 'out', label: '文字', type: 'text' }], fields: [{ name: 'value', label: '文字', kind: 'text', default: 'こんにちは' }] },
  show: { title: '表示', group: '出す', inputs: [{ name: 'value', label: '出すもの', type: 'any', default: '' }], outputs: [], fields: [] },
  calc: { title: '計算', group: '数', inputs: [{ name: 'a', label: 'A', type: 'num', default: 0 }, { name: 'b', label: 'B', type: 'num', default: 0 }], outputs: [{ name: 'out', label: '答え', type: 'num' }], fields: [{ name: 'op', label: '計算', kind: 'choice', choices: Object.keys(CALC_OPS), default: '+' }] },
  compare: { title: '比べる', group: '数', inputs: [{ name: 'a', label: 'A', type: 'num', default: 0 }, { name: 'b', label: 'B', type: 'num', default: 0 }], outputs: [{ name: 'out', label: '合っているか', type: 'bool' }], fields: [{ name: 'op', label: '比べ方', kind: 'choice', choices: Object.keys(COMPARE_OPS), default: '=' }] },
  if: { title: 'もし', group: '流れ', inputs: [{ name: 'cond', label: 'もし', type: 'bool', default: false }, { name: 'yes', label: 'そうなら', type: 'any', default: '' }, { name: 'no', label: 'ちがえば', type: 'any', default: '' }], outputs: [{ name: 'out', label: '結果', type: 'any' }], fields: [] },
  repeat: { title: 'くり返す', group: '流れ', inputs: [{ name: 'from', label: 'から', type: 'num', default: 1 }, { name: 'to', label: 'まで', type: 'num', default: 10 }], outputs: [{ name: 'each', label: '今の数', type: 'num' }], fields: [] },
  join: { title: '文字をつなぐ', group: '文字', inputs: [{ name: 'a', label: '前', type: 'any', default: '' }, { name: 'b', label: '後', type: 'any', default: '' }], outputs: [{ name: 'out', label: '文字', type: 'text' }], fields: [] },
  list: { title: '一覧', group: '文字', inputs: [{ name: 'a', label: '1', type: 'any', default: '' }, { name: 'b', label: '2', type: 'any', default: '' }, { name: 'c', label: '3', type: 'any', default: '' }], outputs: [{ name: 'out', label: '一覧', type: 'list' }], fields: [] },
  writeFile: { title: 'ファイルに書く', group: 'ファイル', inputs: [{ name: 'name', label: 'ファイル名', type: 'text', default: 'memo.txt' }, { name: 'content', label: '中身', type: 'any', default: '' }], outputs: [], fields: [] },
  readFile: { title: 'ファイルを読む', group: 'ファイル', inputs: [{ name: 'name', label: 'ファイル名', type: 'text', default: 'memo.txt' }], outputs: [{ name: 'out', label: '中身', type: 'text' }], fields: [] },
  weather: { title: '天気を取る', group: '外から', inputs: [{ name: 'place', label: '場所', type: 'text', default: '東京' }], outputs: [{ name: 'text', label: '天気', type: 'text' }, { name: 'rain', label: '雨か', type: 'bool' }], fields: [{ name: 'day', label: '日', kind: 'choice', choices: Object.keys(DAYS), default: '明日' }] },
  ask: { title: 'AI に頼む', group: '外から', inputs: [{ name: 'prompt', label: '頼み', type: 'text', default: '' }], outputs: [{ name: 'out', label: '答え', type: 'text' }], fields: [] },
};

/** つないでよいか。理由は画面にそのまま出す。 */
export function canConnect(fromType, toType) {
  if (fromType === toType || toType === 'any' || fromType === 'any') return { ok: true };
  if (toType === 'text' && (fromType === 'num' || fromType === 'bool')) return { ok: true };
  return { ok: false, why: `${TYPES[fromType]?.label ?? fromType}は${TYPES[toType]?.label ?? toType}の口にはつなげません` };
}

export function portOf(kind, side, name) {
  const def = BLOCKS[kind];
  return (side === 'out' ? def?.outputs : def?.inputs)?.find((p) => p.name === name);
}

/** 新しいブロック。値は種類の既定から。 */
export function makeNode(kind, id, x = 0, y = 0) {
  const def = BLOCKS[kind];
  if (!def) throw new Error(`知らないブロックです: ${kind}`);
  const values = {};
  for (const f of def.fields) values[f.name] = f.default;
  for (const p of def.inputs) values[p.name] = p.default;
  return { id, kind, x, y, values };
}

export function emptyGraph() {
  return { version: 1, nodes: [], links: [] };
}

export function nextId(graph) {
  let n = 1;
  const used = new Set(graph.nodes.map((x) => x.id));
  while (used.has(`n${n}`)) n += 1;
  return `n${n}`;
}

/**
 * つなぐ。入る口は一本だけなので、前の線は外す。つなげないときは理由を返し、何も変えない。
 */
export function connect(graph, from, to) {
  const a = graph.nodes.find((n) => n.id === from.node);
  const b = graph.nodes.find((n) => n.id === to.node);
  if (!a || !b) return { ok: false, why: 'ブロックが見つかりません' };
  if (a.id === b.id) return { ok: false, why: '同じブロックの中ではつなげません' };
  const out = portOf(a.kind, 'out', from.port);
  const inp = portOf(b.kind, 'in', to.port);
  if (!out || !inp) return { ok: false, why: 'つなぎ口が見つかりません' };
  const check = canConnect(out.type, inp.type);
  if (!check.ok) return check;
  if (reaches(graph, b.id, a.id)) return { ok: false, why: 'つなぐと輪になります（後のブロックから前へは戻せません）' };
  graph.links = graph.links.filter((l) => !(l.to.node === to.node && l.to.port === to.port));
  graph.links.push({ from: { node: from.node, port: from.port }, to: { node: to.node, port: to.port } });
  return { ok: true };
}

function reaches(graph, start, goal) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop();
    if (id === goal) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const l of graph.links) if (l.from.node === id) stack.push(l.to.node);
  }
  return false;
}

export function removeNodes(graph, ids) {
  const gone = new Set(ids);
  graph.nodes = graph.nodes.filter((n) => !gone.has(n.id));
  graph.links = graph.links.filter((l) => !gone.has(l.from.node) && !gone.has(l.to.node));
}

/** 写す。中のつなぎも一緒に写し、外とのつなぎは入る側だけ残す。 */
export function duplicateNodes(graph, ids, dx = 30, dy = 30) {
  const map = {};
  const made = [];
  for (const id of ids) {
    const src = graph.nodes.find((n) => n.id === id);
    if (!src) continue;
    const copy = { ...structuredClone(src), id: nextId(graph), x: src.x + dx, y: src.y + dy };
    graph.nodes.push(copy);
    map[id] = copy.id;
    made.push(copy.id);
  }
  for (const l of [...graph.links]) {
    const to = map[l.to.node];
    if (!to) continue;
    graph.links.push({ from: { node: map[l.from.node] ?? l.from.node, port: l.from.port }, to: { node: to, port: l.to.port } });
  }
  return made;
}

/** 保存の形。並びを揃えて、同じ組み方なら同じ文字になるようにする。 */
export function serialize(graph) {
  const nodes = graph.nodes.map((n) => ({ id: n.id, kind: n.kind, x: Math.round(n.x), y: Math.round(n.y), values: n.values }));
  return `${JSON.stringify({ version: 1, nodes, links: graph.links }, null, 2)}\n`;
}

/** 保存の形を読む。知らないブロック・つなげない線は外し、何を外したかを返す。 */
export function parseGraph(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { graph: emptyGraph(), problems: [`読めませんでした（JSON の形ではありません: ${e.message}）`] }; }
  const problems = [];
  const graph = emptyGraph();
  if (!raw || !Array.isArray(raw.nodes)) return { graph, problems: ['nodes の並びがありません'] };
  for (const n of raw.nodes) {
    if (!n || typeof n.id !== 'string' || !BLOCKS[n.kind]) { problems.push(`知らないブロックを外しました: ${n?.kind}`); continue; }
    if (graph.nodes.some((m) => m.id === n.id)) { problems.push(`同じ名前のブロックを外しました: ${n.id}`); continue; }
    const node = makeNode(n.kind, n.id, Number(n.x) || 0, Number(n.y) || 0);
    for (const k of Object.keys(node.values)) if (n.values && k in n.values) node.values[k] = n.values[k];
    graph.nodes.push(node);
  }
  for (const l of Array.isArray(raw.links) ? raw.links : []) {
    const got = l?.from && l?.to ? connect(graph, l.from, l.to) : { ok: false, why: '線の形が違います' };
    if (!got.ok) problems.push(`線を外しました: ${got.why}`);
  }
  return { graph, problems };
}

function literal(type, v) {
  if (type === 'num') { const n = Number(v); return Number.isFinite(n) ? String(n) : '0'; }
  if (type === 'bool') return v === true || v === 'true' ? 'true' : 'false';
  if (type === 'any' && typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return String(Number(v));
  if (type === 'any' && typeof v === 'number') return String(v);
  return JSON.stringify(String(v ?? ''));
}

/** 一つのブロックの文。くり返すと条件は呼ぶ側が書く。 */
function stepLines(n, ins, say) {
  const def = BLOCKS[n.kind];
  const out = (port = 'out') => varName(n.id, port);
  switch (n.kind) {
    case 'number': say(`const ${out()} = ${literal('num', n.values.value)};`); break;
    case 'text': say(`const ${out()} = ${literal('text', n.values.value)};`); break;
    case 'show': say(`rt.show(${ins.value}, ${JSON.stringify(n.id)});`); break;
    case 'calc': {
      const op = CALC_OPS[n.values.op] ?? '+';
      if ((op === '/' || op === '%') && (ins.b === '0' || !/^-?[\d.]+$/.test(ins.b))) say(`if (${ins.b} === 0) throw new Error('0 では割れません');`);
      say(`const ${out()} = ${ins.a} ${op} ${ins.b};`);
      break;
    }
    case 'compare': say(`const ${out()} = ${ins.a} ${COMPARE_OPS[n.values.op] ?? '==='} ${ins.b};`); break;
    case 'if': say(`const ${out()} = ${ins.cond} ? ${ins.yes} : ${ins.no};`); break;
    case 'join': say(`const ${out()} = String(${ins.a}) + String(${ins.b});`); break;
    case 'list': {
      const parts = def.inputs.filter((p) => incoming.has(`${n.id}:${p.name}`) || String(n.values[p.name] ?? '') !== '').map((p) => ins[p.name]);
      say(`const ${out()} = [${parts.join(', ')}];`);
      break;
    }
    case 'writeFile': say(`await rt.writeFile(${ins.name}, String(${ins.content}));`); break;
    case 'readFile': say(`const ${out()} = await rt.readFile(${ins.name});`); break;
    case 'weather': {
      const w = varName(n.id, 'w');
      say(`const ${w} = await rt.weather(${ins.place}, ${DAYS[n.values.day] ?? 1});`);
      say(`const ${out('text')} = ${w}.text;`);
      say(`const ${out('rain')} = ${w}.rain;`);
      break;
    }
    case 'ask': say(`const ${out()} = await rt.ask(${ins.prompt});`); break;
    default: break;
  }
}

const varName = (id, port) => `v_${String(id).replace(/[^A-Za-z0-9_]/g, '_')}_${port}`;

/**
 * 組んだ形から JavaScript を作る。
 *
 * くり返すの「今の数」から辿れるブロックは、くり返しの中に入る。順は、つなぎの順、同じなら名前の順（置いた場所では決めない）。
 * trace を付けると、各ブロックの前に rt.at("id") を置き、落ちたブロックを画面が指せるようにする。
 * 返す errors は { node, message }。errors があるときも code は作る（見せるため）。
 */
export function compile(graph, opts = {}) {
  const trace = opts.trace === true;
  const errors = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const incoming = new Map();
  for (const l of graph.links) incoming.set(`${l.to.node}:${l.to.port}`, l);

  // 順番（つなぎの順。輪は connect が断るが、手で書いた JSON にも備える）
  // 置いた場所では決めない（向きを変えて並べ直しても、作る文が変わらないように）。名前の順（n2 は n10 より前）
  const sorted = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  const order = [];
  const state = new Map();
  const visit = (n) => {
    if (state.get(n.id) === 2) return;
    if (state.get(n.id) === 1) { errors.push({ node: n.id, message: 'つなぎが輪になっています' }); return; }
    state.set(n.id, 1);
    for (const p of BLOCKS[n.kind].inputs) {
      const l = incoming.get(`${n.id}:${p.name}`);
      const src = l && byId.get(l.from.node);
      if (src) visit(src);
    }
    state.set(n.id, 2);
    order.push(n);
  };
  for (const n of sorted) visit(n);

  // どのくり返しの中か
  const loops = new Map();
  for (const n of order) {
    const set = new Set();
    for (const p of BLOCKS[n.kind].inputs) {
      const l = incoming.get(`${n.id}:${p.name}`);
      if (!l) continue;
      for (const x of loops.get(l.from.node) ?? []) set.add(x);
      if (byId.get(l.from.node)?.kind === 'repeat' && l.from.port === 'each') set.add(l.from.node);
    }
    loops.set(n.id, set);
  }
  const parent = new Map();
  for (const n of order) {
    const mine = [...loops.get(n.id)];
    // 内側のくり返しほど、外側を多く抱えている
    mine.sort((a, b) => loops.get(b).size - loops.get(a).size);
    const inner = mine[0];
    const ok = mine.every((x) => x === inner || loops.get(inner).has(x));
    if (!ok) errors.push({ node: n.id, message: '別々のくり返しの中身が混ざっています（一つのくり返しの中でつないでください）' });
    parent.set(n.id, inner ?? null);
  }

  const lines = [];
  const input = (n, p) => {
    const l = incoming.get(`${n.id}:${p.name}`);
    if (l) return varName(l.from.node, l.from.port);
    return literal(p.type, n.values[p.name]);
  };
  const emit = (n, pad) => {
    const def = BLOCKS[n.kind];
    const ins = Object.fromEntries(def.inputs.map((p) => [p.name, input(n, p)]));
    const out = (port = 'out') => varName(n.id, port);
    const say = (s) => lines.push(pad + s);
    if (trace) say(`rt.at(${JSON.stringify(n.id)});`);
    if (n.kind === 'repeat') {
      const v = out('each');
      say(`for (let ${v} = ${ins.from}; ${v} <= ${ins.to}; ${v} += 1) {`);
      for (const m of order) if (parent.get(m.id) === n.id) emit(m, `${pad}  `);
      say('}');
      return;
    }
    stepLines(n, ins, say);
  };
  for (const n of order) if (parent.get(n.id) === null) emit(n, '');
  return { code: lines.join('\n'), errors, order, parent };
}

/**
 * 写して持っていく形。Node でそのまま動くよう、rt を頭に足す（天気と AI はアプリの中でだけ動く）。
 */
export function exportScript(graph) {
  return wrapForNode(compile(graph).code);
}

/** 作った文を、Node でそのまま動く一つのファイルの形に包む。 */
export function wrapForNode(code) {
  const body = code.split('\n').map((l) => `  ${l}`).join('\n');
  return [
    '// AdaptiveAIStudio のブロックから作った JavaScript。node このファイル.mjs で動きます。',
    "import { readFile, writeFile } from 'node:fs/promises';",
    'const rt = {',
    '  show: (v) => console.log(v),',
    "  readFile: (name) => readFile(name, 'utf8'),",
    "  writeFile: (name, text) => writeFile(name, text, 'utf8'),",
    "  weather: async () => { throw new Error('天気を取るブロックは、アプリの中でだけ動きます'); },",
    "  ask: async () => { throw new Error('AI に頼むブロックは、アプリの中でだけ動きます'); },",
    '};',
    'async function main() {',
    body,
    '}',
    'main().catch((e) => { console.error(e.message); process.exitCode = 1; });',
    '',
  ].join('\n');
}

/**
 * 動かす。rt は画面か試験が渡す（show / at / readFile / writeFile / weather / ask）。
 * 落ちたら、最後に通ったブロック（rt.at）を node として返す。
 */
export async function run(graph, rt, opts = {}) {
  const { code, errors } = compile(graph, { trace: true });
  if (errors.length) return { ok: false, node: errors[0].node, message: errors[0].message };
  return runCode(code, rt, opts);
}

/** 元に戻す・やり直す。形をまるごと文字で持つ（小さいので十分）。 */
export function makeHistory(limit = 200) {
  const past = [];
  const future = [];
  return {
    push(text) { if (past[past.length - 1] === text) return; past.push(text); if (past.length > limit) past.shift(); future.length = 0; },
    undo(now) { const prev = past.pop(); if (prev === undefined) return undefined; future.push(now); return prev; },
    redo(now) { const next = future.pop(); if (next === undefined) return undefined; past.push(now); return next; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
  };
}

/** 検索。名前とまとまりの名前に入っていれば出す。 */
export function searchBlocks(q) {
  const s = String(q ?? '').trim();
  return Object.entries(BLOCKS).filter(([, d]) => !s || d.title.includes(s) || d.group.includes(s)).map(([kind, d]) => ({ kind, title: d.title, group: d.group }));
}

/** AI に組ませるときに渡す説明。返ってきた JSON は parseGraph で読む。 */
export function graphFormatGuide() {
  const kinds = Object.entries(BLOCKS).map(([k, d]) => `- ${k}（${d.title}）入る口: ${d.inputs.map((p) => `${p.name}:${p.type}`).join(', ') || 'なし'} ／ 出る口: ${d.outputs.map((p) => `${p.name}:${p.type}`).join(', ') || 'なし'} ／ 選ぶもの: ${d.fields.map((f) => `${f.name}${f.choices ? `(${f.choices.join('|')})` : ''}`).join(', ') || 'なし'}`);
  return [
    'ブロックの組み方を JSON だけで返してください。説明の文は書かないでください。',
    '形: {"version":1,"nodes":[{"id":"n1","kind":"…","x":0,"y":0,"values":{…}}],"links":[{"from":{"node":"n1","port":"out"},"to":{"node":"n2","port":"value"}}]}',
    'values には、つながない入る口の値と、選ぶものの値を入れます。',
    'くり返す（repeat）の each から辿れるブロックは、くり返しの中で動きます。',
    'ブロックの種類:',
    ...kinds,
  ].join('\n');
}

/* ---------- 手順の形（上から下へ並べる形） ---------- */

/** きっかけ。手で・毎日（日本時間）・フォルダにファイルが増えたら。 */
export const TRIGGERS = {
  manual: { title: '手で動かす' },
  daily: { title: '毎日決まった時刻に（日本時間）' },
  newFile: { title: 'フォルダにファイルが増えたら' },
};

export function emptyWorkflow() {
  return { version: 1, trigger: { kind: 'manual', time: '08:00', folder: '.' }, steps: [] };
}

const isRef = (v) => !!v && typeof v === 'object' && typeof v.ref === 'string' && typeof v.port === 'string';

/** 手順を一つ作る。cond は「条件」、repeat は中身を持つ。 */
export function makeStep(kind, id) {
  if (kind === 'cond') return { id, kind: 'cond', values: { cond: false }, yes: [], no: [] };
  const n = makeNode(kind, id);
  const step = { id, kind, values: n.values };
  if (kind === 'repeat') step.body = [];
  return step;
}

/** 手順を全部、上から順に（中身も）辿る。 */
export function walkSteps(steps, fn, parents = []) {
  for (const s of steps) {
    fn(s, parents);
    for (const key of ['body', 'yes', 'no']) if (Array.isArray(s[key])) walkSteps(s[key], fn, [...parents, s]);
  }
}

export function nextStepId(wf) {
  const used = new Set();
  walkSteps(wf.steps, (s) => used.add(s.id));
  let n = 1;
  while (used.has(`s${n}`)) n += 1;
  return `s${n}`;
}

function outputsOf(step) {
  if (step.kind === 'cond') return [];
  return (BLOCKS[step.kind]?.outputs ?? []).map((p) => ({ node: step.id, port: p.name, label: `${BLOCKS[step.kind].title}の${p.label}`, type: p.type }));
}

/**
 * その手順の欄で選べる、前の手順の出力（動く中身）。同じ並びで前にあるもの、外側の並びで前にあるもの、
 * 囲んでいるくり返しの「今の数」。
 */
export function availableOutputs(wf, stepId) {
  const found = [];
  const look = (steps, outer) => {
    for (const s of steps) {
      if (s.id === stepId) { found.push(...outer); return true; }
      for (const key of ['body', 'yes', 'no']) {
        if (!Array.isArray(s[key])) continue;
        const extra = s.kind === 'repeat' ? outputsOf(s) : [];
        if (look(s[key], [...outer, ...extra])) return true;
      }
      if (s.kind !== 'repeat') outer = [...outer, ...outputsOf(s)];
    }
    return false;
  };
  look(wf.steps, []);
  return found;
}

function findStep(wf, id) {
  let hit;
  walkSteps(wf.steps, (s) => { if (s.id === id) hit = s; });
  return hit;
}

/** 手順の形から JavaScript を作る。errors は { node, message }。 */
export function compileWorkflow(wf, opts = {}) {
  const trace = opts.trace === true;
  const errors = [];
  const lines = [];
  const value = (s, p) => {
    const v = s.values?.[p.name];
    if (!isRef(v)) return literal(p.type, v);
    const ok = availableOutputs(wf, s.id).find((o) => o.node === v.ref && o.port === v.port);
    if (!ok) { errors.push({ node: s.id, message: `「${p.label}」の欄が、使えない出力を指しています（前の手順のものだけ使えます）` }); return literal(p.type, ''); }
    const c = canConnect(ok.type, p.type);
    if (!c.ok) errors.push({ node: s.id, message: `「${p.label}」の欄: ${c.why}` });
    return varName(v.ref, v.port);
  };
  const emit = (steps, pad) => {
    for (const s of steps) {
      const say = (t) => lines.push(pad + t);
      if (trace) say(`rt.at(${JSON.stringify(s.id)});`);
      if (s.kind === 'cond') {
        say(`if (${value(s, { name: 'cond', label: '条件', type: 'bool' })}) {`);
        emit(s.yes ?? [], `${pad}  `);
        say('} else {');
        emit(s.no ?? [], `${pad}  `);
        say('}');
        continue;
      }
      const def = BLOCKS[s.kind];
      if (!def) { errors.push({ node: s.id, message: `知らない手順です: ${s.kind}` }); continue; }
      const ins = Object.fromEntries(def.inputs.map((p) => [p.name, value(s, p)]));
      if (s.kind === 'repeat') {
        const v = varName(s.id, 'each');
        say(`for (let ${v} = ${ins.from}; ${v} <= ${ins.to}; ${v} += 1) {`);
        emit(s.body ?? [], `${pad}  `);
        say('}');
        continue;
      }
      stepLines(s, ins, say);
    }
  };
  emit(wf.steps, '');
  return { code: lines.join('\n'), errors };
}

/** 手順の形を動かす。run と同じ rt を渡す。 */
export async function runWorkflow(wf, rt, opts = {}) {
  const { code, errors } = compileWorkflow(wf, { trace: true });
  if (errors.length) return { ok: false, node: errors[0].node, message: errors[0].message };
  return runCode(code, rt, opts);
}

async function runCode(code, rt, opts) {
  const limit = opts.limit ?? 100_000;
  let at;
  let steps = 0;
  const wrapped = {
    ...rt,
    at: (id) => {
      at = id;
      steps += 1;
      if (steps > limit) throw new Error(`${limit} 回を超えたので止めました（くり返しの数を見直してください）`);
      rt.at?.(id);
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
  try {
    await new AsyncFunction('rt', code)(wrapped);
    return { ok: true };
  } catch (e) {
    return { ok: false, node: at, message: e?.message ?? String(e) };
  }
}

/**
 * つなぐ形を手順の形にする。表せないときは why を返す。
 * くり返すの中身は、くり返すの下に字下げして入る。もし（ブロック）は値を選ぶ手順のまま残る。
 */
export function graphToWorkflow(graph, trigger) {
  const { errors, order, parent } = compile(graph);
  if (errors.length) return { why: `手順の形にできません: ${errors[0].message}` };
  const incoming = new Map(graph.links.map((l) => [`${l.to.node}:${l.to.port}`, l]));
  const toStep = (n) => {
    const values = { ...structuredClone(n.values) };
    for (const p of BLOCKS[n.kind].inputs) {
      const l = incoming.get(`${n.id}:${p.name}`);
      if (l) values[p.name] = { ref: l.from.node, port: l.from.port };
    }
    const step = { id: n.id, kind: n.kind, values };
    if (n.kind === 'repeat') step.body = order.filter((m) => parent.get(m.id) === n.id).map(toStep);
    return step;
  };
  const wf = emptyWorkflow();
  if (trigger) wf.trigger = structuredClone(trigger);
  wf.steps = order.filter((n) => parent.get(n.id) === null).map(toStep);
  // 前の手順を指していない欄があれば（つなぐ形では後ろのブロックを指せる）、表せない
  const bad = compileWorkflow(wf).errors[0];
  if (bad) return { why: `手順の形にできません: ${bad.message}` };
  return { workflow: wf };
}

/** 手順の形をつなぐ形にする。条件の手順（はい/いいえ）は、つなぐ形では表せないので why を返す。 */
export function workflowToGraph(wf) {
  let cond;
  walkSteps(wf.steps, (s) => { if (s.kind === 'cond' && !cond) cond = s; });
  if (cond) return { why: '条件の手順（はい・いいえに分かれる所）は、つなぐ形では表せません。もしブロック（値を選ぶ）に置き換えるか、手順の形のまま使ってください', node: cond.id };
  const graph = emptyGraph();
  let row = 0;
  const lay = (steps, depth) => {
    for (const s of steps) {
      const node = makeNode(s.kind, s.id, 40 + depth * 260, 40 + row * 130);
      row += 1;
      for (const [k, v] of Object.entries(s.values ?? {})) if (!isRef(v)) node.values[k] = v;
      graph.nodes.push(node);
      if (Array.isArray(s.body)) lay(s.body, depth + 1);
    }
  };
  lay(wf.steps, 0);
  const problems = [];
  walkSteps(wf.steps, (s) => {
    for (const [k, v] of Object.entries(s.values ?? {})) {
      if (!isRef(v)) continue;
      const got = connect(graph, { node: v.ref, port: v.port }, { node: s.id, port: k });
      if (!got.ok) problems.push(got.why);
    }
  });
  if (problems.length) return { why: `つなぐ形にできません: ${problems[0]}` };
  return { graph };
}

/** 毎日のきっかけ: 今の日本時間が HH:MM か。 */
export function dailyDue(time, now = new Date()) {
  const hm = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return hm === String(time ?? '').trim();
}

/** 保存の形（両方の形を一つのファイルに）。 */
export function serializeFile(graph, workflow, view) {
  const g = JSON.parse(serialize(graph));
  return `${JSON.stringify({ ...g, view: view === 'flow' ? 'flow' : 'graph', ...(workflow ? { workflow } : {}) }, null, 2)}\n`;
}

/** ファイルを読む。手順の形は、在ればその形のまま（中の手順の種類だけ確かめる）。 */
export function parseFile(text) {
  const { graph, problems } = parseGraph(text);
  let raw = {};
  try { raw = JSON.parse(text); } catch { /* parseGraph が言った */ }
  let workflow;
  if (raw?.workflow && Array.isArray(raw.workflow.steps)) {
    workflow = { ...emptyWorkflow(), ...structuredClone(raw.workflow) };
    if (!TRIGGERS[workflow.trigger?.kind]) workflow.trigger = emptyWorkflow().trigger;
    const drop = (steps) => steps.filter((s) => {
      const known = s && typeof s.id === 'string' && (s.kind === 'cond' || BLOCKS[s.kind]);
      if (!known) { problems.push(`知らない手順を外しました: ${s?.kind}`); return false; }
      for (const key of ['body', 'yes', 'no']) if (Array.isArray(s[key])) s[key] = drop(s[key]);
      return true;
    });
    workflow.steps = drop(workflow.steps);
  }
  return { graph, workflow, view: raw?.view === 'flow' ? 'flow' : 'graph', problems };
}

export { findStep };

/* ---------- 表示の向き（組んだ中身は変えない） ---------- */

/** 向き。出る口がどちら側に付くかと、整えるときに並べる向き。 */
export const DIRECTIONS = {
  ltr: { title: '左から右', out: 'right', in: 'left' },
  ttb: { title: '上から下', out: 'bottom', in: 'top' },
  diag: { title: '左上から右下', out: 'bottom-right', in: 'top-left' },
};

export function isDirection(d) {
  return Object.prototype.hasOwnProperty.call(DIRECTIONS, d);
}

/**
 * 整える。つなぎの深さ（いちばん長い道）で段を決め、向きに沿って並べる。位置だけを変える（中身は変えない）。
 * 線は必ず、左から右なら x が、上から下なら y が、左上から右下なら両方が増える向きに走る。
 */
export function autoLayout(graph, dir = 'ltr') {
  const depth = new Map();
  const ins = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const l of graph.links) ins.get(l.to.node)?.push(l.from.node);
  const deep = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const d = Math.max(-1, ...(ins.get(id) ?? []).map((x) => deep(x, seen))) + 1;
    depth.set(id, d);
    return d;
  };
  const sorted = [...graph.nodes].sort((a, b) => (dir === 'ttb' ? a.x - b.x : a.y - b.y) || (a.id < b.id ? -1 : 1));
  const rows = new Map();
  for (const n of sorted) {
    const d = deep(n.id);
    if (!rows.has(d)) rows.set(d, []);
    rows.get(d).push(n);
  }
  const widest = Math.max(1, ...[...rows.values()].map((r) => r.length));
  for (const [d, row] of rows) {
    row.forEach((n, i) => {
      // 間合いはブロックの大きさ（幅 約 200、高さ 約 240）から。重ならないように取る
      if (dir === 'ttb') { n.x = 40 + i * 260; n.y = 40 + d * 300; }
      else if (dir === 'diag') { n.x = 40 + d * (240 + 40 * widest) + i * 40; n.y = 40 + d * (40 + 270 * widest) + i * 270; }
      else { n.x = 40 + d * 280; n.y = 40 + i * 260; }
    });
  }
  return graph;
}

/* ---------- 見本 ---------- */

function build(spec) {
  const g = emptyGraph();
  for (const [id, kind, values = {}] of spec.nodes) { const n = makeNode(kind, id); Object.assign(n.values, values); g.nodes.push(n); }
  for (const [a, ap, b, bp] of spec.links) connect(g, { node: a, port: ap }, { node: b, port: bp });
  return autoLayout(g, 'ltr');
}

/** 1〜15 を数え、3 の倍数なら Fizz、5 の倍数なら Buzz、両方なら FizzBuzz を表示する。 */
export function sampleFizzBuzz() {
  return build({
    nodes: [
      ['n1', 'repeat', { from: 1, to: 15 }],
      ['n2', 'calc', { op: '余り', b: 15 }], ['n3', 'compare', { op: '=', b: 0 }],
      ['n4', 'calc', { op: '余り', b: 3 }], ['n5', 'compare', { op: '=', b: 0 }],
      ['n6', 'calc', { op: '余り', b: 5 }], ['n7', 'compare', { op: '=', b: 0 }],
      ['n8', 'if', { yes: 'Buzz' }], ['n9', 'if', { yes: 'Fizz' }], ['n10', 'if', { yes: 'FizzBuzz' }],
      ['n11', 'show'],
    ],
    links: [
      ['n1', 'each', 'n2', 'a'], ['n1', 'each', 'n4', 'a'], ['n1', 'each', 'n6', 'a'],
      ['n2', 'out', 'n3', 'a'], ['n4', 'out', 'n5', 'a'], ['n6', 'out', 'n7', 'a'],
      ['n7', 'out', 'n8', 'cond'], ['n1', 'each', 'n8', 'no'],
      ['n5', 'out', 'n9', 'cond'], ['n8', 'out', 'n9', 'no'],
      ['n3', 'out', 'n10', 'cond'], ['n9', 'out', 'n10', 'no'],
      ['n10', 'out', 'n11', 'value'],
    ],
  });
}

export function sampleHello() {
  return build({ nodes: [['n1', 'text', { value: 'こんにちは' }], ['n2', 'join', { b: '、ブロック' }], ['n3', 'show']], links: [['n1', 'out', 'n2', 'a'], ['n2', 'out', 'n3', 'value']] });
}

/** 明日の天気を取って、雨なら「傘を持って」、そうでなければ「傘はいらない」（手順の形）。 */
export function sampleUmbrella() {
  const wf = emptyWorkflow();
  const w = makeStep('weather', 's1');
  const c = makeStep('cond', 's2');
  c.values.cond = { ref: 's1', port: 'rain' };
  const yes = makeStep('show', 's3'); yes.values.value = '傘を持って';
  const no = makeStep('show', 's4'); no.values.value = '傘はいらない';
  c.yes.push(yes); c.no.push(no);
  wf.steps.push(w, c);
  return wf;
}
