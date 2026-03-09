# pi-repl

Minimal [pi](https://github.com/badlogic/pi-mono) extension for collaborative REPL sessions using tmux.

`pi-repl` starts a shared Python or IPython REPL in tmux that you can attach to from another terminal window. You can work in the REPL directly, or ask pi to send and execute code there.

## Current scope

This release supports **Python** and **IPython** only. Other languages coming soon.

With `pi-repl` you can:

- start a shared Python or IPython REPL from pi
- attach to that REPL from another terminal window
- work in the REPL yourself as normal
- ask pi to run code in that same REPL with `repl_send`
- check which Python interpreter and environment the REPL is using
- stop the shared REPL when you are done

Use `/lab` as a short alias for `/repl`.

## Install

From npm:

```bash
pi install npm:pi-repl
```

From GitHub:

```bash
pi install https://github.com/omaclaren/pi-repl
```

During development:

```bash
pi install /absolute/path/to/pi-repl
```

Restart pi after installing.

## Commands

| Command | Description |
|---------|-------------|
| `/repl` | Show usage |
| `/lab` | Alias for `/repl` |
| `/repl python` | Start the shared session with `python` |
| `/repl ipython` | Start the shared session with `ipython` |
| `/lab python` | Same as `/repl python` |
| `/lab ipython` | Same as `/repl ipython` |
| `/repl status` | Show whether the shared REPL is running |
| `/repl env` | Show which interpreter and environment the shared REPL is using |
| `/repl attach` | Show how to attach from a new terminal window |
| `/repl stop` | Stop the shared session |

## Tool

| Tool | Description |
|------|-------------|
| `repl_send` | Execute code in the running shared Python/IPython session |

Notes:

- the shared session must already be running
- for plain Python, `print(...)` is the safest way to get values back reliably
- tool output includes both the submitted code and the captured output

## Shared session

The default shared tmux session name is:

- `pi-repl-python`

That session can currently be launched in either:

- `python` mode
- `ipython` mode

## Attaching

After running `/repl attach`, open a new terminal window and run:

```bash
tmux attach -t pi-repl-python
```

## Example workflow

```text
/repl ipython
/repl env
/repl status
/repl attach
```

Example things pi can do once the REPL is running:

- use `repl_send` to run `print(sys.executable)`
- use `repl_send` to inspect variables with `print(sorted(globals().keys()))`
- use `repl_send` to run a small IPython cell

## Notes

- `tmux` is required.
- Current scope is Python/IPython only.

## Related extensions

[`pi-interactive-shell`](https://github.com/nicobailon/pi-interactive-shell) offers related but distinct functionality for interactive CLI sessions in pi, including overlay-based interaction and user take-over. `pi-repl` is focused specifically on a shared tmux-backed Python/IPython REPL.

## License

MIT
