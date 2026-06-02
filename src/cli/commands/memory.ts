import chalk from "chalk";
import { createSession, GlobalOpts } from "../session";
import type { MemoryCategory } from "../../agents/memory";

export async function memoryCommand(
  action: string | undefined,
  text: string | undefined,
  opts: GlobalOpts & { category?: string }
): Promise<void> {
  const s = createSession(opts);
  const category = (opts.category as MemoryCategory) || "project";

  switch (action) {
    case "add": {
      if (!text) return fail('Usage: qwenodyssey memory add "fact"');
      s.memory.add(text, category);
      console.log(chalk.green(`✓ Remembered in [${category}].`));
      return;
    }
    case "search": {
      if (!text) return fail('Usage: qwenodyssey memory search "query"');
      const hits = s.memory.search(text);
      console.log(hits.length ? hits.join("\n") : chalk.gray("(no matches)"));
      return;
    }
    case "list":
    case undefined: {
      const all = s.memory.list();
      if (!all.length) {
        console.log(chalk.gray("(memory is empty)"));
        return;
      }
      for (const { category: c, content } of all) {
        console.log(chalk.bold(`\n## ${c}`));
        console.log(content);
      }
      return;
    }
    case "clear": {
      s.memory.clear();
      console.log(chalk.green("✓ Memory cleared."));
      return;
    }
    default:
      fail(`Unknown memory action: ${action}. Use add|search|list|clear.`);
  }
}

function fail(msg: string): void {
  console.log(chalk.red(msg));
  process.exitCode = 1;
}
