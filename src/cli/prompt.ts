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

// Bracketed paste: when enabled, the terminal wraps pasted text between these two
// markers, so we can capture a paste as one unit (newlines and all) instead of
// seeing it as a flood of individual keystrokes / Enters.
const BRACKET_ON = "\x1b[?2004h";
const BRACKET_OFF = "\x1b[?2004l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Collapse a multi-line paste to a one-line chip: first line + "[+N lines]". */
export function pasteChip(text: string): string {
  const nl = text.split("\n");
  const more = nl.length - 1;
  const head = nl[0].slice(0, 48);
  const ell = nl[0].length > 48 ? "…" : "";
  return (
    chalk.cyan(head + ell) +
    chalk.gray(` [+${more} line${more === 1 ? "" : "s"}]`)
  );
}

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
      // `buf` is the logical input. Multi-line pastes are stored out-of-line in
      // `pastes` and represented in `buf` by a sentinel (\x01<id>\x02) rendered
      // as a one-line chip; they expand back to the real text on submit.
      let buf = "";
      let sel = 0;
      let drawn = 0; // menu rows currently on screen
      let lastKeyAt = 0; // paste detection fallback (rapid keypress bursts)
      let pasting = false; // inside a bracketed-paste span
      let pasteBuf = ""; // raw bytes accumulated during a paste
      const pastes = new Map<number, string>();
      let pasteSeq = 0;

      stdin.setRawMode(true);
      stdin.resume();
      process.stdout.write(BRACKET_ON); // ask the terminal to bracket pastes

      // Sentinel <-> text helpers.
      const display = (s: string) =>
        s.replace(/\x01(\d+)\x02/g, (_m, d) => pasteChip(pastes.get(Number(d)) ?? ""));
      const expand = (s: string) =>
        s.replace(/\x01(\d+)\x02/g, (_m, d) => pastes.get(Number(d)) ?? "");

      const render = () => {
        const items = filter(buf);
        if (sel >= items.length) sel = Math.max(0, items.length - 1);

        // Return to input-line column 0 and clear everything below.
        let out = "\r\x1b[0J" + promptLabel + display(buf);

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
          // Move cursor back up to the input line, just past the buffer. (Only
          // shown for slash commands, whose buffer has no chips, so buf.length
          // is the true on-screen width.)
          out += `\x1b[${items.length}A\r\x1b[${promptCols + buf.length}C`;
        }
        drawn = items.length;
        process.stdout.write(out);
      };

      const finish = (value: string) => {
        process.stdout.write("\r\x1b[0J" + promptLabel + display(buf) + "\n");
        process.stdout.write(BRACKET_OFF);
        stdin.setRawMode(false);
        stdin.removeListener("keypress", onKey);
        stdin.pause();
        resolve(value);
      };

      // Fold a finished paste into the buffer: short single-line pastes go in
      // literally; anything multi-line becomes a collapsed chip.
      const commitPaste = (raw: string) => {
        const text = raw.replace(/\r\n?/g, "\n");
        if (!text) return;
        if (text.includes("\n")) {
          const id = pasteSeq++;
          pastes.set(id, text);
          buf += `\x01${id}\x02`;
        } else {
          buf += text;
        }
        sel = 0;
        render();
      };

      const onKey = (str: string | undefined, key: readline.Key) => {
        const seq = key?.sequence ?? "";

        // ── Bracketed paste: capture everything between the markers verbatim. ──
        if (key?.name === "paste-start" || seq === PASTE_START || (!pasting && seq.startsWith(PASTE_START))) {
          pasting = true;
          pasteBuf = "";
          return;
        }
        if (pasting) {
          const end = seq.indexOf(PASTE_END);
          if (key?.name === "paste-end" || seq === PASTE_END || end !== -1) {
            if (end > 0) pasteBuf += seq.slice(0, end);
            pasting = false;
            commitPaste(pasteBuf);
            pasteBuf = "";
            return;
          }
          pasteBuf += seq || str || "";
          return;
        }

        // Detect a paste on terminals WITHOUT bracketed-paste support: events
        // arrive microseconds apart, so a newline from such a burst is a literal
        // line break, not a submit.
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
          return finish(expand(buf).trim());
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
          // Backspacing onto a chip removes the whole paste, not one sentinel byte.
          const m = buf.match(/\x01(\d+)\x02$/);
          if (m) {
            pastes.delete(Number(m[1]));
            buf = buf.slice(0, m.index);
          } else {
            buf = buf.slice(0, -1);
          }
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

        // Printable input (single char, no control chars).
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
        process.stdout.write(BRACKET_OFF);
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
  let pasting = false;
  let pasteBuf = "";

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

  const commitPaste = (raw: string): void => {
    const text = raw.replace(/\r\n?/g, "\n");
    if (!text) return;
    beginTyping();
    const parts = text.split("\n");
    for (let i = 0; i < parts.length - 1; i++) lines.push(buf + parts[i]), (buf = "");
    buf += parts[parts.length - 1];
    redraw();
    if (text.includes("\n")) {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, 16);
    }
  };

  const onKey = (str: string | undefined, key: readline.Key): void => {
    const seq = key?.sequence ?? "";

    // ── Bracketed paste: gather the whole paste, then queue it as one aside. ──
    if (key?.name === "paste-start" || seq === PASTE_START || (!pasting && seq.startsWith(PASTE_START))) {
      pasting = true;
      pasteBuf = "";
      return;
    }
    if (pasting) {
      const end = seq.indexOf(PASTE_END);
      if (key?.name === "paste-end" || seq === PASTE_END || end !== -1) {
        if (end > 0) pasteBuf += seq.slice(0, end);
        pasting = false;
        commitPaste(pasteBuf);
        pasteBuf = "";
        return;
      }
      pasteBuf += seq || str || "";
      return;
    }

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
    process.stdout.write(BRACKET_ON);
    stdin.on("keypress", onKey);
    attached = true;
  };
  const detach = () => {
    if (!attached) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    process.stdout.write(BRACKET_OFF);
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
