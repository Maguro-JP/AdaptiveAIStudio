/** run.mjs の形。素の JS で書いてあるので、型はここで宣言する。 */
export function lookup(name: string, srcRoot?: string): Promise<string | undefined>;
export function toCommand(script: unknown): string[] | undefined;
