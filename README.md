# warcraft-wiki-mcp

MCP server that gives LLMs live access to [warcraft.wiki.gg](https://warcraft.wiki.gg) API documentation — the community-maintained source for WoW API behavioral notes, restrictions, and patch history.

## Why this server?

- **LLM training data is frequently wrong for WoW APIs.** Functions get renamed, deprecated, or change behavior between patches. Training data lags months or years behind.
- **API signatures alone aren't enough.** Knowing that `C_Spell.GetSpellCooldown()` returns `{ startTime, duration, ... }` doesn't tell you that `startTime` and `duration` are secret values in 12.0.x that can't be used in Lua arithmetic. That critical behavioral context lives on the wiki.
- **No way to verify APIs without tools.** Without live lookup, an LLM will confidently generate code using deprecated or non-existent APIs.

This server queries the wiki on demand and returns clean text plus structured fields — not raw HTML:

- Descriptions, parameter docs, return values, and code examples
- Behavioral details and usage gotchas
- Deprecation notices
- Event payload sections
- Restriction and compatibility notes surfaced by the wiki
- Patch history
- Structured argument/return/payload items for agent use
- Explicit deprecation and replacement metadata when the wiki exposes it
- Conflict signals when the deprecated banner and patch history disagree
- Retry/throttle behavior that is safer under bursty agent lookups
- Safer legacy-page parsing that prefers clean text over misleading fake structure
- Search ranking biased toward current namespaced APIs when broad queries are ambiguous

It complements structural API tools (like [wow-api-mcp](https://github.com/Wutname1/wow-api-mcp) which provides type signatures, enums, and event definitions) with the behavioral layer that only the wiki documents.

The server is intentionally scoped to API and closely related technical documentation. It is not designed for general Warcraft Wiki article browsing.

## Tools

| Tool | Purpose | Example input |
|------|---------|---------------|
| `wiki_lookup` | Fetch a specific API function, event, or exact technical doc page | `C_Spell.GetSpellCooldown`, `SPELL_UPDATE_COOLDOWN` |
| `wiki_search` | Search API/event/technical documentation pages only | `"spell cooldown"`, `"unit aura tracking"` |
| `wiki_namespace` | List all pages under a namespace prefix | `C_Spell`, `C_Item`, `GetSpell` |

### wiki_lookup

Fetches a specific API function, event, or exact technical page and returns readable text plus structured content.

- **Auto-detection:** Function names get an `API_` prefix for the wiki page title (`C_Spell.GetSpellCooldown` -> `API_C_Spell.GetSpellCooldown`). Event names in ALL_CAPS are used as-is (`SPELL_UPDATE_COOLDOWN`).
- **Section filtering:** Optional `section` parameter narrows the response to: `description`, `arguments`, `returns`, `payload`, `details`, `example`, `patch_changes`, `see_also`, `fields`, `members`, `values`, `related_events`, or `all` (default).
- **Deprecation notices:** Automatically extracted and displayed when present.
- **Structured output:** Includes normalized fields such as `pageKind`, `description`, `payload`, `patchChanges`, `relatedEvents`, `availableSections`, `deprecationInfo`, and structured section data like `argumentsData`, `returnsData`, and `payloadData`.
- **Conflict-aware deprecation metadata:** `deprecationInfo` now includes `hasConflict`, `conflictDetails`, and `recommendedState` so callers can detect when banner text and patch history disagree.
- **Lean section focus:** When `section` is provided, the response also includes `selectedSection`, `selectedSectionText`, and `selectedSectionData`.

### wiki_search

Searches Warcraft Wiki technical documentation only. General gameplay and random wiki articles are filtered out so agents stay focused on APIs, events, enums, widgets, and closely related technical pages. Returns up to 20 filtered results with titles, page kinds, URLs, and text snippets.

### wiki_namespace

Lists all wiki pages matching a namespace prefix. Handles C_ namespace scoping by appending a trailing `.` — so `C_Spell` matches `C_Spell.GetSpellCooldown` but not `C_SpellBook.IsSpellKnown`. Supports pagination up to 1,000 results.

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

## How It Works

All data comes from [warcraft.wiki.gg](https://warcraft.wiki.gg) via its MediaWiki API:

| Endpoint | Used by | What it returns |
|----------|---------|-----------------|
| `action=parse&page={title}` | `wiki_lookup` | Full page HTML + section metadata |
| `action=query&list=search` | `wiki_search` | Matching pages with text snippets |
| `action=query&list=allpages` | `wiki_namespace` | All pages matching a title prefix |

The wiki returns MediaWiki HTML. The parser strips noise (navigation, compatibility metadata tables, info boxes), extracts deprecation notices, surfaces banner-vs-patch conflicts, salvages legacy inline sections, splits content at `<h2>` boundaries into named sections, and converts HTML to clean text (code blocks become markdown fences, definition lists become indented text, tables become pipe-separated rows).

```
src/
  index.mjs          MCP server entry point, tool definitions, name normalization
  wiki-client.mjs    HTTP client for warcraft.wiki.gg, in-memory TTL cache
  html-parser.mjs    MediaWiki HTML -> structured text sections
```

**Technical details:** 4-hour in-memory cache (TTL per entry, no persistence across restarts). 10-second timeout per request. In-flight request coalescing, throttling, and retry/backoff are built in for live wiki calls. Graceful error handling for missing pages and network failures. Search is API-scoped by default.

## Maintenance

The content source is low maintenance because it comes live from the wiki, but the parser still needs occasional upkeep if the wiki changes its HTML structure.

## Testing

Run the smoke test with:

```bash
npm test
```

The smoke test spins up the local MCP server through the SDK client and verifies representative lookup and search behavior against live wiki data.

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Server won't start | Missing dependencies | Run `npm install` |
| Lookups return garbled text | Wiki changed HTML template structure | Update section splitting in `html-parser.mjs` |
| "Failed to fetch" errors | Wiki is down or network issue | Transient — retry later |
| Missing sections in output | Wiki page doesn't have that section | Normal — the parser omits missing sections gracefully |

**Dependencies:** `@modelcontextprotocol/sdk` (MCP framework) and `node-html-parser` (HTML parsing).

## License

MIT
