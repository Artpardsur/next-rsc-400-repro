# next-rsc-400-repro

Minimal reproduction: a **malformed `Next-Router-State-Tree` header returns HTTP 500 instead of 400** on a dynamically-rendered route in Next.js 16.4.1.

The header is fully client-controlled, so an unparseable value is a client error (400 Bad Request), but Next.js surfaces it as a server error (500 Internal Server Error).

## Setup

```bash
npm install
npm run build
npm start        # next start -p 3000 (production)
```

## Reproduce

In a second terminal:

```bash
# Dynamic route -> 500 (the bug)
curl -sL -o /dev/null -w "%{http_code}\n" \
  -H "RSC: 1" -H "Next-Router-State-Tree: xyzzy" \
  "http://localhost:3000/dyn/test"
# => 500   (body is a generic 21-byte text/plain message)

# Static route, same header -> 200 (for contrast)
curl -sL -o /dev/null -w "%{http_code}\n" \
  -H "RSC: 1" -H "Next-Router-State-Tree: xyzzy" \
  "http://localhost:3000/"
# => 200
```

Any unparseable value reproduces identically: `xyzzy`, `{"a":1}`, an empty string, `["",{`, or a long random string.

The server console logs:

```
⨯ Error: The router state header was sent but could not be parsed.
    at ... (.next/server/chunks/ssr/...js)
    at async Module.X [as handler] (...)
```

## Observations

- **Only dynamically-rendered routes are affected.** A static route serves the prerendered shell and never parses the header, so it returns 200/307.
- **No stack trace is leaked to the client** — the response body is a generic 21-byte message.
- **No crash / DoS** — the server stays up and handles each request independently (verified under a few hundred concurrent requests; no connection drops, no latency drift).

This is a status-code correctness issue: the error is already explicitly detected and named, it is just mapped to 500 rather than 400.

## Expected vs actual

- **Expected:** `400 Bad Request`
- **Actual:** `500 Internal Server Error`

## Environment

- Next.js 16.4.1 (Turbopack)
- react / react-dom 19.3.0-canary-dc9aed36-20261027
- Node.js 24.15.0
- Reproduced with `next start` (production) and `next dev`

## Measurement tool

`probe/rsc-probe.mjs` is a dependency-free Node script (Node 18+) that characterizes the behavior across all malformed variants, scans the response body for stack-trace leakage, and runs a small load test:

```bash
node probe/rsc-probe.mjs --target dyn=http://localhost:3000/dyn/test --follow --requests 300 --concurrency 15
```
