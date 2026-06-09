#!/usr/bin/env python3
"""Batch runner + self-repair harness for the qwen-coder limits suite.

Talks to a local Ollama model, extracts the code block, grades it against each
test's hidden `check` (exec'd with the model's namespace + SOURCE), and on
failure feeds the exact error back to the model and retries (the "repair loop"
that lifts a small model past its first-attempt mistakes). Runs entirely
locally — no API credits.

Usage:
  python stress/run.py                      # full suite, 3 attempts each
  python stress/run.py --only T05 --attempts 4
  MODEL=qwen2.5-coder:7b python stress/run.py
"""
import argparse, json, multiprocessing as mp, os, re, sys, urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434")
MODEL = os.environ.get("MODEL", "qwen2.5-coder:7b")

SYSTEM = (
    "You are a precise Python coding engine. Respond with EXACTLY one ```python "
    "code block and nothing else — no prose, no explanation, no <tool_response> "
    "tags. Define the requested name(s) at module top level so they are importable. "
    "Before finishing, re-read EVERY constraint and handle edge cases explicitly: "
    "empty input, zero capacity, whitespace runs, wrap-around, and the exact "
    "priority/ordering rules stated in the task."
)


def chat(messages, timeout=180):
    body = json.dumps({
        "model": MODEL, "messages": messages, "stream": False,
        "options": {"temperature": 0.1, "num_ctx": 8192, "num_predict": 2048},
    }).encode()
    req = urllib.request.Request(OLLAMA + "/api/chat", body,
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())["message"]["content"]


def extract(text):
    """Tolerant: fenced python block, else any fence, else strip tool tags."""
    text = re.sub(r"</?tool_(?:response|call)[^>]*>", "", text)
    m = re.search(r"```(?:python)?\s*\n(.*?)```", text, re.S | re.I)
    return (m.group(1) if m else text).strip()


def _grade_worker(source, check, q):
    import traceback
    # Silence stderr in the child: a buggy model solution (e.g. a queue that
    # misuses Condition) spawns threads whose tracebacks would otherwise spam the
    # run log. The grade result still comes from the check's assertions.
    try:
        sys.stderr = open(os.devnull, "w")
    except Exception:  # noqa: BLE001
        pass
    try:
        ns = {}
        exec(source, ns)
        g = dict(ns)
        g["SOURCE"] = source
        exec(check, g)
        q.put(("ok", ""))
    except Exception as e:  # noqa: BLE001
        # Point at the exact failing line in the CHECK so the repair loop gets a
        # concrete signal (a bare "AssertionError" teaches the model nothing).
        line = ""
        tb = e.__traceback__
        while tb:
            if tb.tb_frame.f_code.co_filename == "<string>" and tb.tb_frame.f_globals.get("SOURCE") is not None:
                lines = check.splitlines()
                if 0 < tb.tb_lineno <= len(lines):
                    line = lines[tb.tb_lineno - 1].strip()
            tb = tb.tb_next
        msg = f"{type(e).__name__}: {e}".rstrip(": ")
        if line:
            msg += f"  [failed: {line}]"
        q.put(("err", msg))


def grade(source, check, timeout=20):
    """Run grading in a child process so a model-induced infinite loop / deadlock
    can't hang the whole suite (T10/T11/T15 are loop-prone)."""
    q = mp.Queue()
    p = mp.Process(target=_grade_worker, args=(source, check, q))
    p.start()
    p.join(timeout)
    if p.is_alive():
        p.terminate(); p.join()
        return False, f"timeout >{timeout}s (likely infinite loop / deadlock)"
    if q.empty():
        return False, "no result (crash)"
    status, msg = q.get()
    return status == "ok", msg


def run_test(t, attempts):
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": t["prompt"]}]
    last = ""
    for i in range(attempts):
        try:
            out = chat(msgs)
        except Exception as e:  # noqa: BLE001
            return False, i + 1, f"model error: {e}"
        src = extract(out)
        ok, err = grade(src, t["check"])
        if ok:
            return True, i + 1, ""
        last = err
        msgs.append({"role": "assistant", "content": "```python\n" + src + "\n```"})
        msgs.append({"role": "user", "content":
            f"That failed a hidden test with:\n{err}\n"
            "Fix the bug and return the COMPLETE corrected code as one python block. "
            "Re-read every constraint in the task. Output only the code block."})
    return False, attempts, last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="substring filter on test id")
    ap.add_argument("--attempts", type=int, default=3)
    a = ap.parse_args()

    suite = json.load(open(os.path.join(ROOT, "suite.json")))
    tests = [t for t in suite["tests"] if a.only in t["id"]]
    print(f"model={MODEL}  tests={len(tests)}  attempts={a.attempts}\n")

    results, npass = [], 0
    for t in tests:
        ok, tries, err = run_test(t, a.attempts)
        npass += ok
        tag = "PASS" if ok else "FAIL"
        line = f"{t['id']:34} {tag}  (d{t['difficulty']}, tries {tries})"
        if not ok:
            line += "  " + err[:140].replace("\n", " ")
        print(line, flush=True)
        results.append({"id": t["id"], "pass": ok, "tries": tries, "error": err})

    print(f"\n{npass}/{len(tests)} passed")
    json.dump(results, open(os.path.join(ROOT, "results.json"), "w"), indent=2)
    sys.exit(0 if npass == len(tests) else 1)


if __name__ == "__main__":
    main()
