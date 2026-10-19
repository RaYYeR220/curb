import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** JSON files under backtest/.cache. Chain history does not change, so nothing here expires. */
export class Cache {
  constructor(private readonly dir: string) {}

  read<T>(name: string): T | undefined {
    const path = join(this.dir, name);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }

  write(name: string, value: unknown): void {
    const path = join(this.dir, name);
    mkdirSync(dirname(path), { recursive: true });
    // Written beside and renamed, so an interrupted run never leaves a half file behind.
    writeFileSync(`${path}.tmp`, JSON.stringify(value));
    renameSync(`${path}.tmp`, path);
  }
}
