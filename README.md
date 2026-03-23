# warcraft-wiki-mcp

MCP server that gives LLMs live access to [warcraft.wiki.gg](https://warcraft.wiki.gg) — the community-maintained source for WoW API behavioral documentation.

## Why this server?

World of Warcraft's API surface is large (~3,000+ functions across 100+ C_ namespaces) and changes every patch. The wiki at warcraft.wiki.gg is the primary source for behavioral documentation — usage gotchas, edge cases, related events, code examples, and patch history — but it's HTML pages that LLMs can't browse mid-conversation.

**The problem this solves:**

- **LLM training data is frequently wrong for WoW APIs.** Functions get renamed, deprecated, or change behavior between patches. Training data lags months or years behind.
- **API signatures alone aren't enough.** Knowing that `C_Spell.GetSpellCooldown()` returns `{ startTime, duration, ... }` doesn't tell you that `startTime` and `duration` are secret values in 12.0.x that can't be used in Lua arithmetic. That critical behavioral context lives on the wiki.
- **No way to verify APIs without tools.** Without live lookup, an LLM will confidently generate code using deprecated or non-existent APIs.

**What this server provides:**

This server queries the wiki's MediaWiki API on demand and returns structured, clean text — not raw HTML. It extracts descriptions, parameter docs, return values, behavioral details, deprecation notices, code examples, and patch history into named sections that LLMs can reason about.

It complements structural API tools (like [wow-api-mcp](https://github.com/Wutname1/wow-api-mcp) which provides type signatures, enums, and event definitions) with the behavioral layer that only the wiki documents.

## Tools

| Tool | Purpose | Example input |
|------|---------|---------------|
| `wiki_lookup` | Fetch a specific API function or event page | `C_Spell.GetSpellCooldown`, `SPELL_UPDATE_COOLDOWN` |
| `wiki_search` | Full-text search across the wiki | `"spell cooldown"`, `"unit aura tracking"` |
| `wiki_namespace` | List all pages under a namespace prefix | `C_Spell`, `C_Item`, `GetSpell` |

## Quick Start

**Requirements:** Node.js >= 18.0.0

```bash
git clone https://github.com/Direction6275/warcraft-wiki-mcp.git
cd warcraft-wiki-mcp
npm install
```

No build step, no pre-indexing, no data files. The server queries the wiki live.

### Registration

Add to your project's `.mcp.json` (Claude Code) or equivalent MCP config:

```json
{
  "mcpServers": {
    "warcraft-wiki": {
      "command": "node",
      "args": ["/path/to/warcraft-wiki-mcp/src/index.mjs"]
    }
  }
}
```

Restart Claude Code after adding the config.

## Tool Details

### wiki_lookup

Fetches a specific API function or event page and returns structured content.

- **Auto-detection:** Function names get an `API_` prefix for the wiki page title (`C_Spell.GetSpellCooldown` -> `API_C_Spell.GetSpellCooldown`). Event names in ALL_CAPS are used as-is (`SPELL_UPDATE_COOLDOWN`).
- **Section filtering:** Optional `section` parameter narrows the response to: `description`, `arguments`, `returns`, `details`, `example`, `patch_changes`, `see_also`, or `all` (default).
- **Deprecation notices:** Automatically extracted and displayed when present.

### wiki_search

Full-text search across the entire wiki. Returns up to 20 results with page titles and text snippets. Useful for discovering APIs when you don't know the exact name.

### wiki_namespace

Lists all wiki pages matching a namespace prefix. Handles C_ namespace scoping by appending a trailing `.` — so `C_Spell` matches `C_Spell.GetSpellCooldown` but not `C_SpellBook.IsSpellKnown`. Supports pagination up to 1,000 results.

## How It Works

All data comes from [warcraft.wiki.gg](https://warcraft.wiki.gg) via its MediaWiki API:

| Endpoint | Used by | What it returns |
|----------|---------|-----------------|
| `action=parse&page={title}` | `wiki_lookup` | Full page HTML + section metadata |
| `action=query&list=search` | `wiki_search` | Matching pages with text snippets |
| `action=query&list=allpages` | `wiki_namespace` | All pages matching a title prefix |

### Caching

- In-memory cache with **4-hour TTL** per entry
- Caches the raw API response, so repeated lookups skip the network fetch
- No persistence across server restarts
- No manual cache management needed

### HTML Parsing

The wiki returns MediaWiki HTML. The parser (`html-parser.mjs`):

1. Strips pre-content noise (navigation, info boxes, API metadata tables)
2. Extracts deprecation notices from warning boxes
3. Splits content at `<h2>` boundaries into named sections (arguments, returns, details, etc.)
4. Converts HTML elements to clean text — code blocks become markdown fences, definition lists become indented text, tables become pipe-separated rows

### Network

- 10-second timeout per request
- Graceful error handling for missing pages, network failures, and wiki downtime

## Architecture

```
src/
  index.mjs          MCP server entry point, tool definitions, name normalization
  wiki-client.mjs    HTTP client for warcraft.wiki.gg/api.php, in-memory TTL cache
  html-parser.mjs    MediaWiki HTML -> structured text sections
```

## Maintenance

**This server requires zero maintenance.** All content comes live from the wiki. After WoW patches, the wiki community updates pages and this server automatically serves the new content.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Server won't start | Missing dependencies | Run `npm install` |
| Lookups return garbled text | Wiki changed HTML template structure | Update section splitting in `html-parser.mjs` |
| "Failed to fetch" errors | Wiki is down or network issue | Transient — retry later |
| Missing sections in output | Wiki page doesn't have that section | Normal — the parser omits missing sections gracefully |

### Dependencies

Only two runtime dependencies:

- `@modelcontextprotocol/sdk` — MCP protocol framework
- `node-html-parser` — Lightweight HTML parser (stable API)

## License

MIT
