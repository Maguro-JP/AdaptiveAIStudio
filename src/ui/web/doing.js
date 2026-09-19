/**
 * いま何を触っているか。
 *
 * 動いている間、画面には「作業中」と経過だけが出ていた。**何をしているかは
 * 出ない。**3 分黙っているとき、読んでいるのか、走らせているのか、外へ
 * 出ているのかが分からない。分からないと、止めていいのかも決められない。
 *
 * ツールの名前をそのまま出しても読めないので、日本語にする。
 * **知らない名前は、そのまま出す。**訳が無いことを理由に隠すと、
 * 足したばかりのツールのときだけ何も出なくなる。
 */
const TOOL_VERB = {
  read_file: '読んでいます',
  show_file: '画面で開いています',
  list_files: '見ています',
  search_text: '探しています',
  find_code: '探しています',
  find_symbol: '名前を引いています',
  write_file: '書いています',
  edit_file: '直しています',
  run_command: '走らせています',
  fetch_url: '取ってきています',
  deliberate: '相談しています',
  list_services: '外の相手を見ています',
  connect_service: '外の相手に繋いでいます',
  disconnect_service: '外の相手を切っています',
};

function doingText(name, summary) {
  const verb = TOOL_VERB[name];
  // 外の MCP は `相手__ツール名` の形。相手の名前だけ出せば足りる。
  const outside = !verb && name.includes('__') ? name.split('__')[0] : '';
  const what = summary ? ` ${summary}` : '';
  if (verb) return `${verb}${what}`;
  if (outside) return `${outside} を呼んでいます${what}`;
  return `${name}${what}`;
}

export { TOOL_VERB, doingText };
