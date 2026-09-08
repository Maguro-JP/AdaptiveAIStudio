/**
 * Enter で送るか。
 *
 * 日本語入力の途中では、Enter は**変換を確定する**ためのもの。
 * それを送信と読んでいたので、「こんにちは」と打って確定した瞬間に
 * 途中の文が送られる。日本語で書く人には、毎回起きる。
 *
 * 変換中の Enter は、`isComposing` が立つ（keyCode は 229）。
 * それを見て、送らない。Shift+Enter は改行で、これも送らない。
 */
function isSendKey(e) {
  if (e.key !== 'Enter') return false;
  if (e.shiftKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  return true;
}

/** 変換中でない Enter か。一覧から選ぶ所などで使う。 */
function isPlainEnter(e) {
  return e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;
}

export { isSendKey, isPlainEnter };
