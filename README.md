# Consensus

Ask a question and Consensus reads what people actually say about it on Reddit and X, groups the answers into a poll, and shows every opinion behind each option, with links back to the original comment or post.

Live: https://useconsensus.io

## How a search works (`src/v3/`)

One search is one streamed request to `/api/v3/search` (`netlify/functions/search-v3.mts`). `src/v3/run.ts` wires the stages together and sends server-sent events as results arrive, so the poll fills in while the search is still running. Every stage has a time budget so the stream always finishes before the 60s function limit.

1. **Reddit pool** (`reddit.ts`): an LLM writes about 10 Google searches (thread-title rewordings plus wider ones). They run in parallel through Serper with the raw question. The top 40 threads are downloaded with their full comment trees, comments outside the date window are dropped, and bots are removed.
2. **X pool** (`x.ts`, `xpace.ts`): an LLM writes narrow first-person opinion queries plus broad subject queries for TwitterAPI.io advanced search. These fan out into Top/Latest and popularity lanes that page in parallel. Every instance shares one global rate limiter with backoff, and per-search spend and time caps apply.
3. **Options** (`sort.ts`): a sample of the pool becomes the poll options, plus an Other bucket.
4. **Sorting** (`sort.ts`): every post is sorted into an option in parallel batches. The vote comes from three fast models; DeepSeek is primary. Each post gets a strength and a `relevance` score built from directness, agreement and recency. Posts that don't answer the question are dropped, not counted.
5. **Themes** (`themes.ts`): the detailed reasons people give ("A is better because ..."). They are multi-label and can span options.
6. **Counts** (`counts.ts`): the final poll, theme counts and listed posts are reconciled so the numbers always match what is shown.

Events: `meta`, `plan`, `progress`, `poll`, `posts`, `themes`, `reasons`, `authors`, `communities`, `done`, `error`.

## Frontend (`web/`)

Vite + React + TypeScript. Landing is a search bar, and results show the poll, sources, themes, and every opinion with its author and link. Sign-in uses Firebase (Google); results are cached and shareable by id.

## Setup

Node 22+.

```bash
npm install
cp .env.example .env   # fill in your own keys; .env is gitignored
npm run v3 -- "is a standing desk worth it"   # full pipeline in the terminal
npm run dev                                   # netlify dev: frontend + functions on :8888
npm run build
```

You need keys for Straitly (LLMs), TwitterAPI.io (X), Serper (Google search) and Oxylabs (residential proxy for Reddit).

LLM gateway: the pipeline runs on [Straitly](https://straitly.ai) by default (`STRAITLY_API_KEY`), an OpenAI-compatible gateway at `api.straitly.ai`. OpenRouter is supported as an alternative (`OPENROUTER_API_KEY`; if both keys are set, Straitly is used unless `LLM_GATEWAY=openrouter`), and any other OpenAI-compatible gateway via `LLM_GATEWAY=custom` with `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` and `LLM_USD_PER_1K_TOKENS`. Model ids are the gateway's own, so each preset carries its own default model, sort voters and concurrency; override with `LLM_MODEL`, `SORT_VOTERS` and `SORT_CONCURRENCY` (see `.env.example`). `LLM_PROVIDERS` applies to OpenRouter only. Per-call cost is read from the response's `usage.cost`, which both Straitly and OpenRouter send. If a response has none, the call is metered at `LLM_USD_PER_1K_TOKENS` (required for custom gateways, 0.002 by default for the presets), so the daily spend cap never counts LLM calls as free.

## MCP: use Consensus from Claude Code, Cursor, Claude Desktop (`mcp/`)

Step-by-step setup, keys and troubleshooting: [mcp/SETUP.md](mcp/SETUP.md).

`mcp/server.ts` is a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. Any MCP client can then ask "what do people on Reddit and X think about X" and get the poll with linked quotes.

Tools:

- `consensus_get(id)` replays a saved search from useconsensus.io (the `id=` in a result URL). Free, no keys.
- `consensus_featured()` lists the polls on the home page with their leading answer and id. Free, no keys.
- `consensus_search(question, since?, until?, sources?)` runs the full pipeline from `src/v3` on your machine with the keys in `.env`, streams progress, and returns the poll plus what it cost. Each search bills your own LLM, Serper, Oxylabs and X keys (tens of cents); pass `sources: ["reddit"]` without an X key.

Run it:

```bash
npm run mcp            # same as: npx tsx --env-file-if-exists=.env mcp/server.ts
```

Add it to a client (use the absolute path of this checkout):

```bash
# Claude Code
claude mcp add consensus -- npx -y tsx --env-file-if-exists=/ABS/PATH/consensus/.env /ABS/PATH/consensus/mcp/server.ts
```

```json
// Cursor: ~/.cursor/mcp.json (or .cursor/mcp.json in a project)
// VS Code: .vscode/mcp.json        Claude Desktop: claude_desktop_config.json
{ "mcpServers": { "consensus": { "command": "npx", "args": ["-y", "tsx", "--env-file-if-exists=/ABS/PATH/consensus/.env", "/ABS/PATH/consensus/mcp/server.ts"] } } }
```

A search can take up to a minute; if your client times out tool calls sooner, raise its MCP tool timeout (Claude Code: `MCP_TOOL_TIMEOUT`). Try it with the inspector: `npx @modelcontextprotocol/inspector npx tsx mcp/server.ts`, then call `consensus_get` with `ByAYXunnmt6BGCQR`.

## Limits and abuse guards

Each visitor can run one search at a time. Per-IP hourly rate limits, a daily spend cap (`DAILY_SPEND_CAP_USD`) and a global X request budget (`X_GLOBAL_RPS`) keep load and cost bounded. These are tunable through the environment variables in `.env.example` and the constants at the top of each `src/v3` file.

## Security

No keys live in this repo. Production functions read them from the host's environment variables. Report vulnerabilities privately to the maintainers rather than in a public issue.

## License

MIT
