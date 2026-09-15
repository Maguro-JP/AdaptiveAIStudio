/**
 * 自分で作った世界で子を走らせるときの env。
 *
 * `AAS_CONFIG` や `AAS_HOME` は、**外から立っているだけで子の世界を乗っ取る**。
 * 仮のフォルダを作って壊れた設定を置いても、`AAS_CONFIG` が外から立っていれば
 * 子はそちらを読むので、壊れていない設定で動いて**テストだけが落ちる**。
 * 入れた機械（インストーラの入口が `AAS_HOME` を立てる）や、
 * 自分の機械で `AAS_CONFIG` を立てて selftest を回したときに、実際にそうなった。
 *
 * **壊れていないのに NG と言うテストは、あるほうが悪い**（直しに行く先が無い）。
 * だから、子へ渡す env はここで作る。根を決めるものは全部消してから、
 * そのテストが欲しいものだけを立てる。
 *
 * 守っているかどうかは `test/installed-env.test.ts` が見る（外から立てた env で
 * 子を走らせて、それでも通ること）。
 */

/** 根と保存先を決める env。ここに無いものは、子の世界を乗っ取らない。 */
export const AAS_ENV_KEYS = [
  'AAS_HOME', 'AAS_CONFIG', 'AAS_STATE_DIR', 'AAS_BIN_DIR', 'AAS_MODELS_DIR',
  'AAS_REPORT_DIR', 'AAS_UI_PORT',
] as const;

/** いま立っているものを消した env に、欲しいものだけを立てて返す。 */
export function cleanAasEnv(want: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of AAS_ENV_KEYS) delete env[key];
  return { ...env, ...want };
}

/**
 * 呼んだところから戻すまでの間だけ、根を決める env を外す
 * （**同じプロセスで呼ぶ側**のため）。
 *
 * `loadConfig(dir)` のように、こちらでフォルダを渡す呼び出しでも、
 * `AAS_CONFIG` が立っていればそちらが勝つ（そういう設計。上書きのための env）。
 * だから env を外すのはテストの側の仕事。戻す手を返す。
 */
export function hideAasEnv(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of AAS_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  return () => {
    for (const [key, was] of saved) {
      if (was === undefined) delete process.env[key];
      else process.env[key] = was;
    }
  };
}
