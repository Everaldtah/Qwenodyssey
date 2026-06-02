import chalk from "chalk";
import {
  configPath,
  getByPath,
  loadConfig,
  saveConfig,
  setByPath,
} from "../../core/config";
import type { GlobalOpts } from "../session";
import * as path from "path";

export async function configCommand(
  action: string | undefined,
  key: string | undefined,
  value: string | undefined,
  opts: GlobalOpts
): Promise<void> {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const config = loadConfig(cwd);

  switch (action) {
    case "get": {
      if (!key) return fail("Usage: qwenodyssey config get <key>");
      console.log(JSON.stringify(getByPath(config, key)));
      return;
    }
    case "set": {
      if (!key || value === undefined) return fail("Usage: qwenodyssey config set <key> <value>");
      try {
        const next = setByPath(config, key, value);
        saveConfig(cwd, next);
        console.log(chalk.green(`✓ ${key} = ${value}`));
      } catch (e) {
        fail((e as Error).message);
      }
      return;
    }
    case "path": {
      console.log(configPath(cwd));
      return;
    }
    case "list":
    case undefined: {
      console.log(chalk.bold(`Config (${configPath(cwd)}):`));
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    default:
      fail(`Unknown config action: ${action}. Use get|set|list|path.`);
  }
}

function fail(msg: string): void {
  console.log(chalk.red(msg));
  process.exitCode = 1;
}
