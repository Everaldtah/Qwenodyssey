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


NVIDIA_URL = os.environ.get("NVIDIA_URL", "https://integrate.api.nvidia.com")


def _ollama_chat(messages, model, timeout):
    body = json.dumps({
        "model": model, "messages": messages, "stream": False,
        "options": {"temperature": 0.1, "num_ctx": 8192, "num_predict": 2048},
    }).encode()
    req = urllib.request.Request(OLLAMA + "/api/chat", body,
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())["message"]["content"]


def _nvidia_chat(messages, model, timeout):
    key = os.environ.get("NVIDIA_API_KEY", "")
    if not key:
        raise RuntimeError("NVIDIA_API_KEY not set (export it to use --escalate)")
    body = json.dumps({
        "model": model, "messages": messages, "temperature": 0.1,
        "max_tokens": 4096, "stream": False,
        # Thinking models on NIM (kimi-k2.6) otherwise leak chain-of-thought into
        # the answer, which breaks code extraction; ask for a clean reply.
        "chat_template_kwargs": {"thinking": False},
    }).encode()
    req = urllib.request.Request(
        NVIDIA_URL + "/v1/chat/completions", body,
        {"Content-Type": "application/json", "Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"]


def chat(messages, model=None, timeout=180):
    """Route to the right backend: 'nvidia:<id>' = NVIDIA NIM cloud, else Ollama."""
    model = model or MODEL
    if model.startswith("nvidia:"):
        return _nvidia_chat(messages, model.split(":", 1)[1], timeout)
    return _ollama_chat(messages, model, timeout)


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


def run_test(t, attempts, model=None):
    msgs = [{"role": "system", "content": SYSTEM},
            {"role": "user", "content": t["prompt"]}]
    last = ""
    for i in range(attempts):
        try:
            out = chat(msgs, model)
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


def extract_constraints(prompt, model=None):
    """Decompose: turn a big/complex prompt into an explicit requirement
    checklist so the model can't silently drop one (the classic small-model
    failure on multi-constraint / long tasks)."""
    try:
        out = chat([
            {"role": "system", "content":
                "List EVERY explicit requirement, rule, and edge case in this "
                "coding task as a terse numbered checklist. No code, no prose "
                "beyond the list."},
            {"role": "user", "content": prompt}], model)
        return out.strip()
    except Exception:  # noqa: BLE001
        return ""


def solve_agent(t, attempts, model=None):
    """Decompose -> solve -> self-verify-by-execution -> grade -> repair.

    The model attaches its own `CHECK:` assertions; the harness EXECUTES them and
    feeds back real results, so the model grounds itself on actual behaviour
    before the hidden check is ever spent. Long prompts get a requirement
    checklist injected so constraints aren't dropped."""
    cl = extract_constraints(t["prompt"], model)
    sys_p = SYSTEM
    if cl:
        sys_p += "\n\nThe task's own requirement checklist — satisfy EVERY item:\n" + cl
    sys_p += (
        "\n\nVerify before finishing: after the code block, add a line 'CHECK:' "
        "then a python block of asserts that exercise the tricky cases and edge "
        "cases. They will be executed and the real result returned to you; keep "
        "fixing until they pass.")
    msgs = [{"role": "system", "content": sys_p},
            {"role": "user", "content": t["prompt"]}]
    last = ""
    for i in range(attempts):
        try:
            out = chat(msgs, model)
        except Exception as e:  # noqa: BLE001
            return False, i + 1, f"model error: {e}"
        src = extract(out)

        # Pull the model's self-written checks (the grounding tool input).
        mcheck = ""
        mm = re.search(r"CHECK:\s*(.*)$", out, re.S | re.I)
        if mm:
            blk = re.search(r"```(?:python)?\s*\n(.*?)```", mm.group(1), re.S)
            mcheck = (blk.group(1) if blk else mm.group(1)).strip()

        # Always grade against the hidden check so a flaky self-check can never
        # black-hole an attempt (that made agent mode worse than direct).
        ok, err = grade(src, t["check"])
        if ok:
            return True, i + 1, ""
        last = err

        # Real execution of the model's OWN checks is extra grounding feedback —
        # it shows the model where its mental model diverges from real behaviour.
        feedback = f"A hidden test failed: {err}"
        if mcheck:
            sok, serr = grade(src, mcheck)
            if not sok:
                feedback += f"\nYour own CHECK also failed when executed: {serr}"
        feedback += ("\nRe-read the requirement checklist, find which item you "
                     "violated, fix it, and resend the code block then CHECK:.")
        msgs += [{"role": "assistant", "content": out},
                 {"role": "user", "content": feedback}]
    return False, attempts, last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="substring filter on test id")
    ap.add_argument("--attempts", type=int, default=3)
    ap.add_argument("--mode", choices=["direct", "agent"], default="direct",
                    help="direct=single-shot+repair; agent=decompose+self-test")
    ap.add_argument("--escalate", default="",
                    help="on local failure, retry with this model "
                         "(e.g. nvidia:moonshotai/kimi-k2.6). Uses API credit.")
    a = ap.parse_args()
    solver = solve_agent if a.mode == "agent" else run_test

    suite = json.load(open(os.path.join(ROOT, "suite.json")))
    tests = [t for t in suite["tests"] if a.only in t["id"]]
    print(f"model={MODEL}  tests={len(tests)}  attempts={a.attempts}  "
          f"mode={a.mode}  escalate={a.escalate or 'off'}\n")

    results, npass, nesc = [], 0, 0
    for t in tests:
        ok, tries, err = solver(t, a.attempts)          # local 7B first
        via = MODEL
        if not ok and a.escalate:                       # tier 2: stronger model
            ok2, tries2, err2 = solver(t, a.attempts, model=a.escalate)
            if ok2:
                ok, tries, via = True, tries2, a.escalate
                nesc += 1
            else:
                err = f"7b: {err[:80]} | {a.escalate}: {err2[:80]}"
        npass += ok
        tag = "PASS" if ok else "FAIL"
        line = f"{t['id']:34} {tag}  (d{t['difficulty']}, tries {tries}"
        line += f", via {via.split('/')[-1]})" if ok and via != MODEL else ")"
        if not ok:
            line += "  " + err[:140].replace("\n", " ")
        print(line, flush=True)
        results.append({"id": t["id"], "pass": ok, "tries": tries,
                        "via": via if ok else None, "error": err})

    extra = f" ({nesc} via {a.escalate.split('/')[-1]})" if nesc else ""
    print(f"\n{npass}/{len(tests)} passed{extra}")
    json.dump(results, open(os.path.join(ROOT, "results.json"), "w"), indent=2)
    sys.exit(0 if npass == len(tests) else 1)


if __name__ == "__main__":
    main()
