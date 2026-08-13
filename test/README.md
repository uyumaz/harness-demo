# Browser verification suite

`verify.mjs` drives headless Chrome over the DevTools Protocol and checks
`index.html` against the behaviour the specs describe: the simulation, the
deep-dive layer, accessibility, responsiveness, dark mode, reduced motion,
touch input, and the no-JavaScript reading path.

It is dependency-free on purpose — no `package.json`, no `node_modules`. It uses
only Node's global `fetch` and `WebSocket` (Node 22+).

## Running it

Start Chrome with remote debugging on port 9222:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/verify-profile \
  --no-first-run --no-default-browser-check --hide-scrollbars about:blank &
```

Then, from the repository root:

```sh
node test/verify.mjs
```

Use `CDP_PORT=9333 node test/verify.mjs` if 9222 is taken. Exit status is 0 when
every check passes and 1 otherwise, so it drops straight into CI.

## Output

A pass/fail line per check, a total at the end, and the failures repeated with
detail. Screenshots and `results.json` are written to `test/artifacts/`, which is
gitignored.

## Notes

- All paths derive from the script's own location, so it runs from any checkout.
- `Page.bringToFront` is called after every navigation: focus events do not fire
  in headless Chrome unless the page is frontmost, and several checks depend on
  real focus.
- The no-JavaScript checks use `Emulation.setScriptExecutionDisabled` and read
  the built DOM over the `DOM` domain, since `Runtime.evaluate` is unavailable
  in that mode.
