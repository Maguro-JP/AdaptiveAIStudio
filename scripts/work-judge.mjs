/**
 * 働くかの確かめ（check-work.mjs）の判定。言い回しではなく、答えの中身で見る。
 * 純粋な判定（`judgeAnswer`）と、正解を外から取る部分（`liveTruth`）を分ける（試験は前だけを、偽の正解で見る）。
 */

/** 試さずに分からないと言った答え。 */
export const GIVE_UP = /わかりません|分かりません|お答えできません|答えられません|知りません|情報がありません|I don'?t know/i;

/** WMO の天気の番号 → 晴/曇/雨/雪 の組。 */
export function weatherGroup(code) {
  if (code <= 2) return '晴';
  if (code <= 48) return '曇';
  if (code <= 67 || (code >= 80 && code <= 82) || code >= 95) return '雨';
  return '雪';
}

const GROUP_WORDS = { 晴: /晴|快晴|sunny|clear/i, 曇: /曇|くもり|霧|cloud/i, 雨: /雨|rain|雷/i, 雪: /雪|snow/i };

/** 日本時間の曜日（日〜土）。 */
export function weekdayJst(now = new Date()) {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', weekday: 'short' }).format(now);
}

/** 答えの中の数（カンマ・全角を外す）。 */
function numbersIn(text) {
  return [...String(text).normalize('NFKC').replace(/(\d),(?=\d{3})/g, '$1').matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

/**
 * 答えを判定する。`truth` は外から取った正解（天気・LTS・曜日）。返すのは { ok, why }。
 * どの判定でも、試さずに分からないと言った答えは落とす。
 */
export function judgeAnswer(judge, answer, truth = {}) {
  const a = String(answer ?? '');
  const t = a.normalize('NFKC');
  if (!a.trim()) return { ok: false, why: '答えが空です' };
  if (GIVE_UP.test(a) && judge.type !== 'not-contains') return { ok: false, why: '「分かりません」の類で終えています' };
  switch (judge.type) {
    case 'contains-all': {
      const miss = (judge.values ?? []).filter((v) => !t.includes(v));
      if (miss.length) return { ok: false, why: `入っていない: ${miss.join(', ')}` };
      if (judge.any && !judge.any.some((v) => t.includes(v))) return { ok: false, why: `どれも入っていない: ${judge.any.join(', ')}` };
      return { ok: true, why: '要る語が入っています' };
    }
    case 'contains-any':
      return (judge.values ?? []).some((v) => t.includes(v)) ? { ok: true, why: '語が入っています' } : { ok: false, why: `どれも入っていない: ${judge.values.join(', ')}` };
    case 'regex':
      return new RegExp(judge.pattern, judge.flags ?? '').test(t) ? { ok: true, why: `/${judge.pattern}/ に合います` } : { ok: false, why: `/${judge.pattern}/ に合いません` };
    case 'not-contains': {
      const hit = (judge.values ?? []).find((v) => t.includes(v));
      return hit ? { ok: false, why: `入っていてはいけない語: ${hit}` } : { ok: true, why: '入っていてはいけない語はありません' };
    }
    case 'number-equals':
      return numbersIn(t).includes(Number(judge.value)) ? { ok: true, why: `${judge.value} が入っています` } : { ok: false, why: `${judge.value} が入っていません` };
    case 'weekday-jst': {
      const w = truth.weekday ?? weekdayJst();
      // 曜日の名前は Intl から作る（2026-11-01 は日曜。そこから 7 日）
      const others = Array.from({ length: 7 }, (_, i) => weekdayJst(new Date(Date.UTC(2026, 10, 1, 3) + i * 86_400_000))).filter((d) => d !== w);
      if (!new RegExp(`${w}曜`).test(t)) return { ok: false, why: `${w}曜日 と言っていません` };
      if (others.some((d) => new RegExp(`${d}曜`).test(t))) return { ok: false, why: 'ほかの曜日も言っています' };
      return { ok: true, why: `${w}曜日 と言っています` };
    }
    case 'weather-matches-open-meteo': {
      const w = truth.weather;
      if (!w) return { ok: false, why: `正解（Open-Meteo）を取れませんでした${truth.weatherError ? `（${truth.weatherError}）` : ''}` };
      const said = Object.entries(GROUP_WORDS).filter(([, re]) => re.test(t)).map(([g]) => g);
      const temp = /(-?\d+(?:\.\d+)?)\s*(℃|度|°C)/.exec(t);
      if (said.length === 0) return { ok: false, why: '晴/曇/雨/雪 のどれも言っていません' };
      if (!temp) return { ok: false, why: '気温（℃ か 度）を言っていません' };
      const groupOk = said.includes(weatherGroup(w.code));
      const temps = [...t.matchAll(/(-?\d+(?:\.\d+)?)\s*(?:℃|度|°C)/g)].map((m) => Number(m[1]));
      const tempOk = temps.some((x) => Math.abs(x - w.max) <= 3 || Math.abs(x - w.min) <= 3);
      return groupOk || tempOk
        ? { ok: true, why: `Open-Meteo（${weatherGroup(w.code)}、最高 ${w.max}℃）と合います` }
        : { ok: false, why: `Open-Meteo（${weatherGroup(w.code)}、最高 ${w.max}℃・最低 ${w.min}℃）と合いません` };
    }
    case 'node-lts-matches': {
      const v = truth.lts;
      if (!v) return { ok: false, why: '正解（nodejs.org）を取れませんでした' };
      return t.includes(v.replace(/^v/, '')) ? { ok: true, why: `${v} が入っています` } : { ok: false, why: `${v} が入っていません` };
    }
    default:
      return { ok: false, why: `知らない判定: ${judge.type}` };
  }
}

/**
 * 正解を外から取る（天気は Open-Meteo、LTS は nodejs.org）。取れなければその欄を空にし、理由を `weatherError` に残す。
 * 天気は本体と同じ `WeatherSource.forecast` で取る（場所の引き方を二か所に書かない）。一度の失敗で落とさず、間を空けて取り直す
 * （Windows のランナーで、本体は Open-Meteo を取れたのに、確かめだけが一度の失敗で「正解を取れませんでした」になった）。
 * 投げられた失敗（`fetch failed`、ECONNRESET、ETIMEDOUT）も HTTP の失敗も同じく取り直す。間は 2・4・8・16 秒と倍に延ばす。
 * Windows のランナーでは最初の接続が IPv6 で詰まることがあるので、確かめの側では IPv4 を先に引き、`autoSelectFamily` を入れる。
 * `opts.fetchImpl`・`opts.waitMs`・`opts.tries`・`opts.sleep` は試験のため。
 */
export async function liveTruth(judge, defaultPlace, opts = {}) {
  await preferIpv4();
  const out = { weekday: weekdayJst() };
  const tries = opts.tries ?? 5;
  const waitMs = opts.waitMs ?? 2000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pause = (i) => (i + 1 < tries ? sleep(waitMs * 2 ** i) : undefined);
  if (judge.type === 'weather-matches-open-meteo') {
    const place = judge.place === '@default' ? defaultPlace : judge.place;
    const { WeatherSource } = await import('../src/core/knowledge-source.ts');
    const source = new WeatherSource({ ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), timeoutMs: 30_000 });
    for (let i = 0; i < tries; i += 1) {
      try {
        const f = await source.forecast(place, 1, AbortSignal.timeout(90_000));
        if (f) { out.weather = { code: f.code, max: f.max, min: f.min }; delete out.weatherError; break; }
        out.weatherError = '予報に明日の欄がありません';
      } catch (e) {
        out.weatherError = errorText(e);
      }
      await pause(i);
    }
  }
  if (judge.type === 'node-lts-matches') {
    for (let i = 0; i < tries && !out.lts; i += 1) {
      const list = await (opts.fetchImpl ?? fetch)('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(30_000) }).then((r) => r.json()).catch(() => []);
      out.lts = list.find?.((r) => typeof r.lts === 'string')?.version;
      if (!out.lts) await pause(i);
    }
  }
  return out;
}

/** `fetch failed` だけでは分からないので、下の原因（ECONNRESET など）を添える。 */
function errorText(e) {
  if (!(e instanceof Error)) return String(e);
  const cause = /** @type {{ code?: string, message?: string } | undefined} */ (e.cause);
  const why = cause?.code ?? cause?.message;
  return why && !e.message.includes(why) ? `${e.message}: ${why}` : e.message;
}

let ipv4Set = false;
/** 確かめの処理の中だけで、名前を IPv4 から引き、IPv4 と IPv6 を並べて試す。 */
function preferIpv4() {
  if (ipv4Set) return;
  ipv4Set = true;
  return Promise.all([import('node:dns'), import('node:net')]).then(([dns, net]) => {
    dns.setDefaultResultOrder('ipv4first');
    net.setDefaultAutoSelectFamily?.(true);
  }).catch(() => undefined);
}

/** --ask / --expect、--task / --file / --stdout から、その回だけの確かめを作る（既定の一覧に足す）。 */
export function adHocChecks(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const next = (flag) => (argv[i + 1] === flag ? argv[i + 2] : undefined);
    if (argv[i] === '--ask') {
      out.push({ id: `ask-${out.length + 1}`, kind: 'answer', ask: argv[i + 1], judge: { type: 'regex', pattern: next('--expect') ?? '.' } });
    } else if (argv[i] === '--task') {
      const file = argv[i + 2] === '--file' ? argv[i + 3] : undefined;
      const stdout = argv[i + 4] === '--stdout' ? argv[i + 5] : undefined;
      if (!file || stdout === undefined) throw new Error('--task には --file <名前> --stdout <出力> を続けてください');
      out.push({ id: `task-${out.length + 1}`, kind: 'task', ask: argv[i + 1], judge: { type: 'file-runs', file, stdout } });
    }
  }
  return out;
}
