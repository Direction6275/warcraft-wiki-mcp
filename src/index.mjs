#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WikiClient } from './wiki-client.mjs';
import { parseWikiPage, cleanTitle, stripHtmlTags } from './html-parser.mjs';

const client = new WikiClient();

// ---- Name Normalization ----

/**
 * Normalize a user-provided name to a wiki page title.
 * - Already has "API_" or "API " prefix → use as-is (normalize spaces to underscores)
 * - ALL_CAPS_WITH_UNDERSCORES → event page, no prefix
 * - Otherwise → prepend "API_"
 */
function normalizePageTitle(name) {
	const trimmed = name.trim();

	// Already prefixed
	if (/^API[_ ]/i.test(trimmed)) {
		return trimmed.replace(/ /g, '_');
	}

	// Event names: ALL_CAPS_WITH_UNDERSCORES (at least one underscore, all uppercase/digits)
	if (/^[A-Z][A-Z0-9_]*_[A-Z0-9_]+$/.test(trimmed)) {
		return trimmed;
	}

	// Regular API function
	return 'API_' + trimmed;
}

// ---- Output Formatting ----

function formatLookupResult(parsed, sectionFilter) {
	const lines = [];

	lines.push(`=== ${parsed.title} ===`);
	lines.push(`Source: ${parsed.url}`);
	lines.push('');

	if (parsed.deprecated) {
		lines.push(`[DEPRECATED] ${parsed.deprecated}`);
		lines.push('');
	}

	if (sectionFilter && sectionFilter !== 'all') {
		// Single section requested
		if (sectionFilter === 'description') {
			if (parsed.description) {
				lines.push('--- Description ---');
				lines.push(parsed.description);
			} else {
				lines.push('(No description available)');
			}
		} else {
			const content = parsed.sections[sectionFilter];
			if (content) {
				lines.push(`--- ${formatSectionHeader(sectionFilter)} ---`);
				lines.push(content);
			} else {
				const available = Object.keys(parsed.sections);
				lines.push(`Section "${sectionFilter}" not found on this page.`);
				if (available.length > 0) {
					lines.push(`Available sections: ${available.join(', ')}`);
				}
			}
		}
	} else {
		// All sections
		if (parsed.description) {
			lines.push('--- Description ---');
			lines.push(parsed.description);
			lines.push('');
		}

		for (const [name, content] of Object.entries(parsed.sections)) {
			lines.push(`--- ${formatSectionHeader(name)} ---`);
			lines.push(content);
			lines.push('');
		}
	}

	return lines.join('\n').trim();
}

function formatSectionHeader(key) {
	return key
		.split('_')
		.map(w => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}

// ---- MCP Server ----

const server = new McpServer({
	name: 'warcraft-wiki',
	version: '1.0.0',
	description: 'Warcraft wiki — behavioral API docs, usage notes, gotchas, patch history. Queries warcraft.wiki.gg on demand.',
});

// ---- Tool: wiki_lookup ----
server.tool(
	'wiki_lookup',
	`Look up a WoW API function or event on the Warcraft wiki. Returns behavioral documentation: description, arguments, returns, usage details/gotchas, code examples, and patch history.

Accepts function names like "C_Spell.GetSpellCooldown", "GetSpellInfo", or event names like "SPELL_UPDATE_COOLDOWN". Automatically adds the "API_" prefix for function pages.

Use the section parameter to retrieve only a specific section (saves context when you only need details or patch history).`,
	{
		name: z.string().describe('API function or event name (e.g. "C_Spell.GetSpellCooldown", "GetSpellInfo", "SPELL_UPDATE_COOLDOWN")'),
		section: z.enum(['all', 'description', 'arguments', 'returns', 'details', 'example', 'patch_changes', 'see_also']).optional().describe('Specific section to return (default: all). Use "details" for usage notes/gotchas.'),
	},
	async ({ name, section }) => {
		const title = normalizePageTitle(name);

		try {
			const data = await client.fetchPage(title);

			if (data.error) {
				if (data.error.code === 'missingtitle') {
					return {
						content: [{
							type: 'text',
							text: `No wiki page found for "${name}" (tried: ${title}).\n\nTry wiki_search to find the correct page name, or wiki_namespace with a prefix like "${name.split('.')[0]}" to browse related functions.`,
						}],
					};
				}
				return {
					content: [{ type: 'text', text: `Wiki API error: ${data.error.info || data.error.code}` }],
				};
			}

			const html = data.parse?.text?.['*'];
			if (!html) {
				return { content: [{ type: 'text', text: `Page "${title}" returned no content.` }] };
			}

			const pageTitle = data.parse.title || title;
			const parsed = parseWikiPage(html, pageTitle);
			const formatted = formatLookupResult(parsed, section);

			return { content: [{ type: 'text', text: formatted }] };
		} catch (err) {
			return {
				content: [{ type: 'text', text: `Failed to fetch wiki page: ${err.message}` }],
			};
		}
	}
);

// ---- Tool: wiki_search ----
server.tool(
	'wiki_search',
	'Search the Warcraft wiki for pages matching a query. Returns page titles and text snippets. Useful for finding the correct page name when wiki_lookup returns "not found", or for discovering related API functions.',
	{
		query: z.string().describe('Search terms (e.g. "spell cooldown", "unit aura tracking", "action bar slot")'),
		limit: z.number().optional().describe('Max results (default: 10, max: 20)'),
	},
	async ({ query, limit }) => {
		try {
			const results = await client.searchPages(query, limit || 10);

			if (results.length === 0) {
				return { content: [{ type: 'text', text: `No wiki results found for "${query}".` }] };
			}

			const lines = [`Wiki search: "${query}" (${results.length} results)`, ''];

			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				const title = cleanTitle(r.title || 'Unknown');
				const snippet = stripHtmlTags(r.snippet || '').trim();
				lines.push(`${i + 1}. ${title}`);
				if (snippet) lines.push(`   ${snippet}`);
				lines.push('');
			}

			return { content: [{ type: 'text', text: lines.join('\n').trim() }] };
		} catch (err) {
			return {
				content: [{ type: 'text', text: `Wiki search failed: ${err.message}` }],
			};
		}
	}
);

// ---- Tool: wiki_namespace ----
server.tool(
	'wiki_namespace',
	`List all Warcraft wiki pages for a given API namespace prefix. Useful for browsing all functions in a C_ namespace (e.g. "C_Spell", "C_Item") or finding legacy globals with a shared prefix (e.g. "GetSpell").`,
	{
		prefix: z.string().describe('Namespace or function prefix (e.g. "C_Spell", "C_Item", "GetSpell", "Unit")'),
	},
	async ({ prefix }) => {
		try {
			// Normalize prefix for the allpages API
			let apiPrefix = prefix.trim();

			// Prepend API_ if not already present
			if (!/^API[_ ]/i.test(apiPrefix)) {
				apiPrefix = 'API_' + apiPrefix;
			}
			apiPrefix = apiPrefix.replace(/ /g, '_');

			// For namespace prefixes like "C_Spell", add trailing dot to scope to that namespace
			// But only if it looks like a namespace (contains underscore after C or similar pattern)
			// and doesn't already end with a dot or specific function start
			if (/^API_C_[A-Za-z]+$/.test(apiPrefix)) {
				apiPrefix += '.';
			}

			const pages = await client.listByPrefix(apiPrefix);

			if (pages.length === 0) {
				return {
					content: [{
						type: 'text',
						text: `No wiki pages found with prefix "${prefix}" (searched: ${apiPrefix}).`,
					}],
				};
			}

			// Clean display: strip "API " prefix, restore C_ underscores
			const displayNames = pages.map(p => cleanTitle(p.title || ''));

			const lines = [
				`Wiki pages with prefix "${prefix}" (${displayNames.length} results):`,
				'',
				...displayNames.map(n => `  ${n}`),
			];

			return { content: [{ type: 'text', text: lines.join('\n') }] };
		} catch (err) {
			return {
				content: [{ type: 'text', text: `Wiki namespace listing failed: ${err.message}` }],
			};
		}
	}
);

// ---- Start ----
const transport = new StdioServerTransport();
await server.connect(transport);
