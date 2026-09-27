/**
 * 本体から読む。**断られた（400・404・500）ら投げる。**
 *
 * `fetch(p).then((r) => r.json())` は、断られたときも `{ error }` を中身として返す。受け取った側はそれを一覧や状態として
 * 使うので、状態が 500 を返しただけで `{ error }` を全部のパネルへ配り、パネルが順に止まっていた。断られたのを、繋がらな
 * かったのと同じ失敗として投げれば、呼ぶ側の今の `catch` がそのまま効く。
 *
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<any>}
 */
export async function getJson(path, init) {
  const r = await fetch(path, init);
  const body = await r.json().catch(() => undefined);
  if (!r.ok) throw new Error(body?.error ?? `${path}（${r.status}）`);
  if (body === undefined) throw new Error(`${path} の返事を読めませんでした`);
  return body;
}
