# push の手前で止める

`pre-push` が `node scripts/check.mjs`（型検査 → 検査 → 画面を押して回る）を回す。
落ちたら push できない。

新しく clone したときは、一度だけ:

    git config core.hooksPath .githooks
