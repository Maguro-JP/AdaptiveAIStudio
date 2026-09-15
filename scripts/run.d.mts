/** run.mjs の形。素の JS で書いてあるので、型はここで宣言する。 */
export function lookup(name: string, srcRoot?: string): Promise<string | undefined>;
export function toCommand(script: unknown): string[] | undefined;
/** 止める合図を子へ渡す。入口だけが死んで本体が残らないように。 */
export function forwardSignals(
  child: { kill: (signal: string) => unknown },
  proc: { on: (event: string, fn: () => void) => unknown },
): void;
