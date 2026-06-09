/**
 * Interactive prompt with a live slash-command palette.
 *
 * In a real terminal (TTY) this reads keypresses in raw mode and renders a
 * filtering menu beneath the input line: type `/` to see every command, then
 * keep typing to filter (e.g. `/s` → /settings), ↑/↓ to highlight, Tab/Enter
 * to accept. When stdin is not a TTY (piped input, tests) it falls back to a
 * plain line reader with no menu.
 */
import * as readline from "readline";
import chalk from "chalk";

export interface SlashCommand {
  name: string;
  aliases?: string[];
  args?: string;
  desc: string;
}

export interface Prompt {
  ask(): Promise<string>;
  close(): void;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const visibleLen = (s: string) => s.replace(ANSI, "").length;

/** Max menu rows drawn at once (keeps us clear of bottom-of-screen scroll). */
const MAX_MENU = 8;

export function createPrompt(promptLabel: string, commands: SlashCommand[]): Prompt {
  const stdin = process.stdin;

  // ── Non-TTY fallback (pipes / tests): simple line reader, no menu. ──
  if (!stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin, output: process.stdout });
    let closed = false;
    rl.on("close", () => (closed = true));
    return {
      ask: () =>
        new Promise<string>((resolve) => {
          if (closed) return resolve("/exit");
          rl.question(promptLabel, resolve);
        }),
      close: () => rl.close(),
    };
  }

  // ── TTY: raw keypress reader with live palette. ──
  readline.emitKeypressEvents(stdin);
  const promptCols = visibleLen(promptLabel);

  const label = (c: SlashCommand) => c.name + (c.args ? " " + c.args : "");

  function filter(buf: string): SlashCommand[] {
    if (!buf.startsWith("/")) return [];
    const q = buf.toLowerCase();
    return commands
      .filter((c) => [c.name, ...(c.aliases ?? [])].some((n) => n.toLowerCase().startsWith(q)))
      .slice(0, MAX_MENU);
  }

  function ask(): Promise<string> {
    return new Promise<string>((resolve) => {
      let buf = "";
      let sel = 0;
      let drawn = 0; // menu rows currently on screen
      let lastKeyAt = 0; // for paste detection (rapid keypress bursts)

      stdin.setRawMode(true);
      stdin.resume();

      const render = () => {
        const items = filter(buf);
        if (sel >= items.length) sel = Math.max(0, items.length - 1);

        // Return to input-line column 0 and clear everything below.
        let out = "\r\x1b[0J" + promptLabel + buf;

        if (items.length) {
          const pad = Math.max(...items.map((c) => label(c).length)) + 2;
          items.forEach((c, i) => {
            const head = label(c).padEnd(pad);
            const row =
              i === sel
                ? chalk.cyan("▸ " + chalk.bold(head)) + chalk.gray(c.desc)
                : chalk.gray("  ") + chalk.cyan(head) + chalk.dim(c.desc);
            out += "\n  " + row;
          });
          // Move cursor back up to the input line, just past the buffer.
          out += `\x1b[${items.length}A\r\x1b[${promptCols + buf.length}C`;
        }
        drawn = items.length;
        process.stdout.write(out);
      };

      const finish = (value: string) => {
        process.stdout.write("\r\x1b[0J" + promptLabel + buf + "\n");
        stdin.setRawMode(false);
        stdin.removeListener("keypress", onKey);
        stdin.pause();
        resolve(value);
      };

      const onKey = (str: string | undefined, key: readline.Key) => {
        // Detect pasted input: in raw mode a multi-line paste arrives as many
        // keypress events microseconds apart, so its embedded newlines look like
        // Enter. Treat a newline from such a burst as a literal line break in the
        // buffer (building one multi-line message) rather than submitting — only
        // an isolated, human-paced Enter sends.
        const now = Date.now();
        const burst = now - lastKeyAt < 12;
        lastKeyAt = now;

        if (key.ctrl && key.name === "c") return finish("/exit");
        if (key.ctrl && key.name === "d" && buf === "") return finish("/exit");

        if (key.name === "escape") {
          // Dismiss the palette by clearing the (slash) buffer.
          buf = "";
          sel = 0;
          return render();
        }

        if (key.name === "return" || key.name === "enter" || str === "\r" || str === "\n") {
          if (burst) {
            // Paste-internal newline: keep editing as a multi-line message.
            buf += "\n";
            sel = 0;
            return render();
          }
          const items = filter(buf);
          if (drawn > 0 && items.length) {
            const c = items[sel];
            if (c.args) {
              // Command takes arguments — complete it and keep editing.
              buf = c.name + " ";
              return render();
            }
            buf = c.name;
          }
          return finish(buf.trim());
        }

        if (key.name === "tab") {
          const items = filter(buf);
          if (items.length) {
            const c = items[sel];
            buf = c.name + (c.args ? " " : "");
            sel = 0;
          }
          return render();
        }

        if (key.name === "backspace") {
          buf = buf.slice(0, -1);
          return render();
        }
        if (key.name === "up") {
          if (drawn > 0) sel = (sel - 1 + drawn) % drawn;
          return render();
        }
        if (key.name === "down") {
          if (drawn > 0) sel = (sel + 1) % drawn;
          return render();
        }

        // Printable input (single char or pasted run, no control chars).
        if (str && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str)) {
          buf += str;
          sel = 0;
          return render();
        }
      };

      stdin.on("keypress", onKey);
      render();
    });
  }

  return {
    ask,
    close: () => {
      try {
        stdin.setRawMode(false);
      } catch {
        /* not a TTY anymore */
      }
      stdin.pause();
    },
  };
}

export interface Interjector {
  /** Temporarily release stdin (e.g. while a y/N confirm prompt runs). */
  suspend(): void;
  /** Re-attach after suspend(). */
  resume(): void;
  /** Detach for good and restore the terminal. */
  stop(): void;
}

/**
 * Capture "on the side" interjections the user types WHILE the assistant is
 * working (the `/btw` side-channel). Runs in raw mode for the duration of a turn;
 * each completed line is handed to onSubmit so the caller can queue it. While the
 * user is mid-line, onStartTyping/onStopTyping let the caller pause/resume the
 * spinner so typed text isn't clobbered. TTY-only — returns null otherwise (you
 * can't type concurrently into a pipe anyway).
 */
export function captureInterjections(opts: {
  label: string;
  onSubmit: (text: string) => void;
  onStartTyping?: () => void;
  onStopTyping?: () => void;
}): Interjector | null {
  const stdin = process.stdin;
  if (!stdin.isTTY) return null;
  readline.emitKeypressEvents(stdin);

  let buf = "";
  let typing = false;
  let attached = false;
  // Lines accumulated from the current input burst. A multi-line PASTE arrives as
  // many rapid keypress events (each embedded newline looks like Enter); without
  // coalescing, every pasted line would submit its own aside and flood the screen.
  // We gather lines and flush them as ONE aside a few ms after input goes idle.
  let lines: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const redraw = (): void => {
    process.stdout.write("\r\x1b[2K" + opts.label + buf);
  };

  const beginTyping = () => {
    if (typing) return;
    typing = true;
    opts.onStartTyping?.();
    process.stdout.write("\n");
  };
  const endTyping = () => {
    typing = false;
    buf = "";
    lines = [];
    opts.onStopTyping?.();
  };

  const flush = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!typing) return;
    const text = [...lines, buf].join("\n").trim();
    process.stdout.write("\r\x1b[2K"); // clear the input line
    endTyping();
    if (text) opts.onSubmit(text);
  };

  const onKey = (str: string | undefined, key: readline.Key): void => {
    if (key && key.ctrl && key.name === "c") {
      detach();
      process.exit(130); // preserve Ctrl-C = interrupt during a turn
    }
    if (key && (key.name === "return" || key.name === "enter")) {
      if (!typing) return;
      // Push the completed line and debounce the flush. A real (human) Enter has
      // a gap, so the timer fires and submits one aside. A paste's internal
      // newlines arrive back-to-back, repeatedly resetting the timer, so the
      // whole blob is submitted as a single aside once the paste finishes.
      lines.push(buf);
      buf = "";
      redraw();
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, 16);
      return;
    }
    if (key && key.name === "backspace") {
      if (!typing) return;
      buf = buf.slice(0, -1);
      redraw();
      return;
    }
    // Printable text (single char or pasted run). Tabs/newlines inside a pasted
    // run are control chars; keep newlines as line breaks, drop other controls.
    if (str && !(key && (key.ctrl || key.meta))) {
      const cleaned = str.replace(/\r\n?/g, "\n");
      if (!/[^\x00-\x08\x0b-\x1f\x7f]/.test(cleaned) && !cleaned.includes("\n")) return;
      beginTyping();
      for (const ch of cleaned) {
        if (ch === "\n") {
          lines.push(buf);
          buf = "";
        } else if (ch >= " " && ch !== "\x7f") {
          buf += ch;
        }
      }
      redraw();
      if (cleaned.includes("\n")) {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, 16);
      }
    }
  };

  const attach = () => {
    if (attached) return;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKey);
    attached = true;
  };
  const detach = () => {
    if (!attached) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    stdin.removeListener("keypress", onKey);
    try {
      stdin.setRawMode(false);
    } catch {
      /* not a TTY anymore */
    }
    stdin.pause();
    attached = false;
  };

  attach();
  return {
    suspend: detach,
    resume: () => {
      attach();
      if (typing) redraw();
    },
    stop: () => {
      if (typing) process.stdout.write("\r\x1b[2K");
      detach();
    },
  };
}

export interface SelectItem {
  label: string;
  hint?: string;
  current?: boolean;
}

/**
 * Interactive arrow-key list picker (Claude-Code style): ↑/↓ to move, Enter to
 * choose, Esc/Ctrl-C to cancel. Redraws in place. Returns the chosen index, or
 * -1 if cancelled / not a TTY. Runs only between prompt turns, so it has stdin
 * to itself (no clash with the main input reader).
 */
export function selectFromList(title: string, items: SelectItem[], initialIndex = 0): Promise<number> {
  const stdin = process.stdin;
  if (!stdin.isTTY || items.length === 0) return Promise.resolve(-1);
  readline.emitKeypressEvents(stdin);

  return new Promise<number>((resolve) => {
    let sel = Math.max(0, Math.min(initialIndex, items.length - 1));
    let drawn = 0;

    stdin.setRawMode(true);
    stdin.resume();

    const render = () => {
      const lines: string[] = [chalk.bold(title)];
      items.forEach((it, i) => {
        const dot = it.current ? chalk.green("●") : chalk.gray("○");
        const text = it.label + (it.hint ? chalk.gray("  " + it.hint) : "");
        lines.push(
          i === sel ? `${chalk.cyan("❯")} ${dot} ${chalk.bold(text)}` : `  ${dot} ${text}`
        );
      });
      lines.push(chalk.gray("  ↑/↓ move · Enter switch · Esc cancel"));
      const up = drawn > 0 ? `\x1b[${drawn - 1}A` : "";
      process.stdout.write(up + "\r\x1b[0J" + lines.join("\n"));
      drawn = lines.length;
    };

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.removeListener("keypress", onKey);
      stdin.pause();
      process.stdout.write("\n");
    };

    const onKey = (_str: string | undefined, key: readline.Key) => {
      if (!key) return;
      if (key.name === "up" || (key.ctrl && key.name === "p")) {
        sel = (sel - 1 + items.length) % items.length;
        return render();
      }
      if (key.name === "down" || (key.ctrl && key.name === "n")) {
        sel = (sel + 1) % items.length;
        return render();
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        return resolve(sel);
      }
      if (key.name === "escape" || (key.ctrl && key.name === "c") || key.name === "q") {
        cleanup();
        return resolve(-1);
      }
    };

    stdin.on("keypress", onKey);
    render();
  });
}
