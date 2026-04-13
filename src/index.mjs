#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WikiClient } from './wiki-client.mjs';
import {
	PAGE_KINDS,
	parseWikiPage,
	cleanTitle,
	stripHtmlTags,
	classifyPageTitle,
	isInScopePageKind,
	wikiPageUrl,
	normalizeCategories,
} from './html-parser.mjs';

const client = new WikiClient();
const SECTION_KEYS = [
	'all',
	'description',
	'arguments',
	'returns',
	'payload',
	'details',
	'example',
	'patch_changes',
	'see_also',
	'fields',
	'members',
	'values',
	'related_events',
];
const LOOKUP_SECTION_ORDER = [
	'description',
	'arguments',
	'returns',
	'payload',
	'fields',
	'members',
	'values',
	'details',
	'example',
	'patch_changes',
	'see_also',
	'related_events',
];
const DATA_SECTION_MAP = {
	arguments: 'argumentsData',
	returns: 'returnsData',
	payload: 'payloadData',
	fields: 'fieldsData',
	members: 'membersData',
	values: 'valuesData',
};
const SEARCH_PAGE_LIMIT = 50;

const docItemSchema = z.lazy(() => z.object({
	name: z.string(),
	type: z.string().nullable(),
	value: z.string().nullable(),
	description: z.string().nullable(),
	annotations: z.array(z.string()),
	children: z.array(docItemSchema),
}));

const docBlockSchema = z.object({
	kind: z.enum(['heading', 'item', 'table', 'text']),
	text: z.string().optional(),
	item: docItemSchema.optional(),
	headers: z.array(z.string()).optional(),
	rows: z.array(z.array(z.string())).optional(),
});

const docSectionSchema = z.object({
	blocks: z.array(docBlockSchema),
	items: z.array(docItemSchema),
});

const deprecationInfoSchema = z.object({
	isDeprecated: z.boolean(),
	note: z.string().nullable(),
	deprecatedIn: z.string().nullable(),
	removedIn: z.string().nullable(),
	replacementApis: z.array(z.string()),
	source: z.enum(['ambox', 'category', 'patch_changes']).nullable(),
	hasConflict: z.boolean(),
	conflictDetails: z.array(z.string()),
	recommendedState: z.enum(['active', 'deprecated', 'removed']),
});

const lookupOutputSchema = z.object({
	error: z.string().nullable(),
	pageKind: z.enum(PAGE_KINDS),
	title: z.string(),
	url: z.string(),
	deprecated: z.string().nullable(),
	deprecationInfo: deprecationInfoSchema,
	description: z.string().nullable(),
	arguments: z.string().nullable(),
	returns: z.string().nullable(),
	payload: z.string().nullable(),
	details: z.string().nullable(),
	example: z.string().nullable(),
	patchChanges: z.string().nullable(),
	seeAlso: z.string().nullable(),
	fields: z.string().nullable(),
	members: z.string().nullable(),
	values: z.string().nullable(),
	relatedEvents: z.string().nullable(),
	argumentsData: docSectionSchema.nullable(),
	returnsData: docSectionSchema.nullable(),
	payloadData: docSectionSchema.nullable(),
	fieldsData: docSectionSchema.nullable(),
	membersData: docSectionSchema.nullable(),
	valuesData: docSectionSchema.nullable(),
	selectedSection: z.string().nullable(),
	selectedSectionText: z.string().nullable(),
	selectedSectionData: z.object({}).passthrough().nullable(),
	availableSections: z.array(z.string()),
});

const searchResultSchema = z.object({
	title: z.string(),
	url: z.string(),
	pageKind: z.enum(PAGE_KINDS),
	snippet: z.string().nullable(),
});

const searchOutputSchema = z.object({
	error: z.string().nullable(),
	query: z.string(),
	scope: z.literal('api-docs'),
	results: z.array(searchResultSchema),
});

const namespaceOutputSchema = z.object({
	error: z.string().nullable(),
	prefix: z.string(),
	searchedPrefix: z.string(),
	results: z.array(z.object({
		title: z.string(),
		url: z.string(),
		pageKind: z.enum(PAGE_KINDS),
	})),
});

function normalizePageTitle(name) {
	const trimmed = name.trim();
	const underscored = trimmed.replace(/ /g, '_');

	if (/^API[_ ]/i.test(trimmed)) return underscored;
	if (/^[A-Z][A-Z0-9_]*_[A-Z0-9_]+$/.test(trimmed)) return underscored;
	if (/^Enum[._ ]/i.test(trimmed) || /^UIOBJECT_/i.test(trimmed) || trimmed.includes(':')) return underscored;

	return 'API_' + underscored;
}

function normalizeSearchText(text) {
	return String(text || '')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.toLowerCase()
		.replace(/[.:/()]+/g, ' ')
		.replace(/_/g, ' ')
		.replace(/-/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function extractMemberSearchText(title) {
	const raw = String(title || '');
	const member = raw.split(/[.:]/).pop() || raw;
	return normalizeSearchText(member);
}

function formatSectionHeader(key) {
	return key
		.split('_')
		.map(word => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

function getSectionValue(parsed, sectionKey) {
	if (sectionKey === 'description') return parsed.description || null;
	return parsed.sections[sectionKey] || null;
}

function getSectionDataValue(parsed, sectionKey) {
	return parsed.sectionData?.[sectionKey] || null;
}

function lookupAvailableSections(parsed) {
	const sections = [];
	if (parsed.description) sections.push('description');
	for (const key of LOOKUP_SECTION_ORDER) {
		if (key === 'description') continue;
		if (parsed.sections[key]) sections.push(key);
	}
	for (const key of Object.keys(parsed.sections)) {
		if (!sections.includes(key)) sections.push(key);
	}
	return sections;
}

function buildLookupOutput(parsed, section = 'all', error = null) {
	const output = {
		error,
		pageKind: parsed.pageKind,
		title: parsed.title,
		url: parsed.url,
		deprecated: parsed.deprecated || null,
		deprecationInfo: parsed.deprecationInfo,
		description: parsed.description || null,
		arguments: parsed.sections.arguments || null,
		returns: parsed.sections.returns || null,
		payload: parsed.sections.payload || null,
		details: parsed.sections.details || null,
		example: parsed.sections.example || null,
		patchChanges: parsed.sections.patch_changes || null,
		seeAlso: parsed.sections.see_also || null,
		fields: parsed.sections.fields || null,
		members: parsed.sections.members || null,
		values: parsed.sections.values || null,
		relatedEvents: parsed.sections.related_events || null,
		argumentsData: parsed.sectionData.arguments || null,
		returnsData: parsed.sectionData.returns || null,
		payloadData: parsed.sectionData.payload || null,
		fieldsData: parsed.sectionData.fields || null,
		membersData: parsed.sectionData.members || null,
		valuesData: parsed.sectionData.values || null,
		selectedSection: null,
		selectedSectionText: null,
		selectedSectionData: null,
		availableSections: lookupAvailableSections(parsed),
	};

	if (section !== 'all') {
		output.selectedSection = section;
		output.selectedSectionText = getSectionValue(parsed, section);
		output.selectedSectionData = getSelectedSectionData(parsed, section, output.selectedSectionText);
	}

	return output;
}

function buildEmptyLookupOutput(name, attemptedTitle, error, section = 'all') {
	return {
		error,
		pageKind: 'unknown',
		title: cleanTitle(name),
		url: wikiPageUrl(attemptedTitle),
		deprecated: null,
		deprecationInfo: {
			isDeprecated: false,
			note: null,
			deprecatedIn: null,
			removedIn: null,
			replacementApis: [],
			source: null,
			hasConflict: false,
			conflictDetails: [],
			recommendedState: 'active',
		},
		description: null,
		arguments: null,
		returns: null,
		payload: null,
		details: null,
		example: null,
		patchChanges: null,
		seeAlso: null,
		fields: null,
		members: null,
		values: null,
		relatedEvents: null,
		argumentsData: null,
		returnsData: null,
		payloadData: null,
		fieldsData: null,
		membersData: null,
		valuesData: null,
		selectedSection: section === 'all' ? null : section,
		selectedSectionText: null,
		selectedSectionData: null,
		availableSections: [],
	};
}

function getSelectedSectionData(parsed, section, sectionText) {
	const data = getSectionDataValue(parsed, section);
	if (data) return data;
	if (sectionText) return { text: sectionText };
	return null;
}

function formatLookupResult(parsed, section = 'all') {
	const lines = [];
	lines.push(`=== ${parsed.title} ===`);
	lines.push(`Kind: ${parsed.pageKind}`);
	lines.push(`Source: ${parsed.url}`);
	lines.push('');

	if (parsed.deprecated) {
		lines.push(`[DEPRECATED] ${parsed.deprecated}`);
		lines.push('');
	}

	if (section !== 'all') {
		const content = getSectionValue(parsed, section);
		if (content) {
			lines.push(`--- ${formatSectionHeader(section)} ---`);
			lines.push(content);
		} else {
			lines.push(`Section "${section}" not found on this page.`);
			const available = lookupAvailableSections(parsed);
			if (available.length > 0) lines.push(`Available sections: ${available.join(', ')}`);
		}
		return lines.join('\n').trim();
	}

	for (const key of LOOKUP_SECTION_ORDER) {
		const content = getSectionValue(parsed, key);
		if (!content) continue;
		lines.push(`--- ${formatSectionHeader(key)} ---`);
		lines.push(content);
		lines.push('');
	}

	for (const key of Object.keys(parsed.sections)) {
		if (LOOKUP_SECTION_ORDER.includes(key)) continue;
		lines.push(`--- ${formatSectionHeader(key)} ---`);
		lines.push(parsed.sections[key]);
		lines.push('');
	}

	return lines.join('\n').trim();
}

function normalizeNamespacePrefix(prefix) {
	let apiPrefix = prefix.trim();
	if (!/^API[_ ]/i.test(apiPrefix)) apiPrefix = 'API_' + apiPrefix;
	apiPrefix = apiPrefix.replace(/ /g, '_');
	if (/^API_C_[A-Za-z]+$/.test(apiPrefix)) apiPrefix += '.';
	return apiPrefix;
}

function buildSearchQueries(query) {
	const queries = [query];
	if (query.includes(' ')) {
		queries.push(`"${query}" incategory:"API_functions"`);
	}
	return queries;
}

function cleanSnippet(snippet) {
	if (!snippet) return null;
	return stripHtmlTags(snippet).replace(/\s+/g, ' ').trim() || null;
}

function classifySearchResult(rawResult, metadata) {
	const rawTitle = rawResult.title || metadata?.title || 'Unknown';
	const categories = normalizeCategories(metadata?.categories || []);
	return {
		rawTitle,
		title: cleanTitle(rawTitle),
		url: wikiPageUrl(rawTitle),
		pageKind: classifyPageTitle(rawTitle, categories),
		snippet: cleanSnippet(rawResult.snippet),
		categories,
	};
}

function scoreRawSearchCandidate(rawResult, normalizedQuery) {
	const title = cleanTitle(rawResult.title || '');
	const titleNorm = normalizeSearchText(title);
	const snippetNorm = normalizeSearchText(cleanSnippet(rawResult.snippet));
	const queryWords = normalizedQuery.split(' ').filter(Boolean);
	let score = 0;

	if (titleNorm === normalizedQuery) score += 1000;
	if (titleNorm.startsWith(normalizedQuery) && normalizedQuery) score += 700;
	if (normalizedQuery && titleNorm.includes(normalizedQuery)) score += 350;

	for (const word of queryWords) {
		if (titleNorm.includes(word)) score += 80;
	}

	if (snippetNorm && normalizedQuery && snippetNorm.includes(normalizedQuery)) score += 60;
	return score;
}

function scoreSearchResult(result, normalizedQuery) {
	const titleNorm = normalizeSearchText(result.title);
	const memberNorm = extractMemberSearchText(result.title);
	const queryWords = normalizedQuery.split(' ').filter(Boolean);
	const kindScore = {
		api: 700,
		event: 620,
		enum: 540,
		widget: 520,
		technical: 250,
		unknown: 0,
	}[result.pageKind] || 0;

	let score = kindScore;
	if (titleNorm === normalizedQuery) score += 1200;
	if (titleNorm.startsWith(normalizedQuery) && normalizedQuery) score += 900;
	if (normalizedQuery && titleNorm.includes(normalizedQuery)) score += 500;
	if (memberNorm === normalizedQuery || memberNorm === `get ${normalizedQuery}`) score += 950;
	if (memberNorm.startsWith(`${normalizedQuery} `)) score += 280;
	if (memberNorm.startsWith(`get ${normalizedQuery} `)) score += 180;

	let matchedWords = 0;
	for (const word of queryWords) {
		if (titleNorm.includes(word)) matchedWords++;
	}
	score += matchedWords * 90;
	if (queryWords.length > 0 && matchedWords === queryWords.length) score += 250;

	if (result.snippet && normalizeSearchText(result.snippet).includes(normalizedQuery)) score += 120;
	if (result.categories.some(category => /^API_functions\/deprecated$/i.test(category))) score -= 10;
	if (/^Patch\b/i.test(result.rawTitle) || /^Events$/i.test(result.title) || /^World_of_Warcraft_API$/i.test(result.title)) score -= 180;
	score += modernApiBias(result, normalizedQuery, memberNorm);
	score -= trailingWordPenalty(memberNorm, normalizedQuery);

	return score;
}

function modernApiBias(result, normalizedQuery, memberNorm) {
	const rawTitle = result.title;
	let score = 0;

	if (/^C_[A-Za-z]/.test(rawTitle)) score += 180;
	if (/^(?:C_UnitAuras|C_TooltipInfo|C_ActionBar|C_Spell|C_SpellBook)\b/.test(rawTitle)) score += 70;
	if (/^[A-Z][A-Z0-9_]+$/.test(rawTitle)) score += 50;
	if (/^(?:Get|Set|Is|Has|Unit)[A-Z]/.test(rawTitle) && !/^C_[A-Za-z]/.test(rawTitle)) score -= 80;
	if (normalizedQuery.includes('aura') && /^UnitAura(?:BySlot|Slots)?$/.test(rawTitle)) score -= 70;
	if (normalizedQuery.includes('action bar') && /^GetActionBarToggles$/.test(rawTitle)) score -= 30;
	if (normalizedQuery.includes('tooltip') && /^GameTooltip:/.test(rawTitle)) score += 30;
	if (memberNorm === normalizedQuery && /^C_[A-Za-z]/.test(rawTitle)) score += 120;

	return score;
}

function trailingWordPenalty(memberNorm, normalizedQuery) {
	const helperWordPenalty = {
		remaining: 110,
		percent: 110,
		percentage: 110,
		duration: 90,
		info: 90,
		data: 90,
		secrecy: 150,
		by: 70,
		index: 70,
		id: 50,
	};
	const phraseCandidates = [normalizedQuery, `get ${normalizedQuery}`].filter(Boolean);

	for (const phrase of phraseCandidates) {
		if (!memberNorm.startsWith(phrase)) continue;

		const trailingWords = memberNorm
			.slice(phrase.length)
			.trim()
			.split(' ')
			.filter(Boolean);

		if (trailingWords.length === 0) return 0;
		return trailingWords.reduce((total, word) => total + (helperWordPenalty[word] || 40), 0);
	}

	return 0;
}

async function runScopedSearch(query, limit) {
	const searchQueries = buildSearchQueries(query);
	const rawResults = [];

	for (let index = 0; index < searchQueries.length; index++) {
		const searchQuery = searchQueries[index];
		const results = await client.searchPages(searchQuery, SEARCH_PAGE_LIMIT);
		rawResults.push(...results);
	}

	const deduped = new Map();
	for (const rawResult of rawResults) {
		const key = rawResult.title || rawResult.pageid || JSON.stringify(rawResult);
		if (!deduped.has(key)) deduped.set(key, rawResult);
	}

	const normalizedQuery = normalizeSearchText(query);
	const shortlisted = [...deduped.values()]
		.sort((a, b) => scoreRawSearchCandidate(b, normalizedQuery) - scoreRawSearchCandidate(a, normalizedQuery))
		.slice(0, Math.max(limit * 4, 20));

	const metadataByTitle = await client.fetchPageMetadataBatch(
		shortlisted.map(result => result.title).filter(Boolean)
	);

	const results = shortlisted
		.map(result => classifySearchResult(result, metadataByTitle[result.title] || null))
		.filter(result => isInScopePageKind(result.pageKind))
		.sort((a, b) => scoreSearchResult(b, normalizedQuery) - scoreSearchResult(a, normalizedQuery))
		.slice(0, limit)
		.map(({ title, url, pageKind, snippet }) => ({ title, url, pageKind, snippet }));

	return results;
}

function formatSearchResult(query, results) {
	const lines = [`Wiki API search: "${query}" (${results.length} results)`, ''];
	for (let index = 0; index < results.length; index++) {
		const result = results[index];
		lines.push(`${index + 1}. ${result.title} [${result.pageKind}]`);
		if (result.snippet) lines.push(`   ${result.snippet}`);
		lines.push(`   ${result.url}`);
		lines.push('');
	}
	return lines.join('\n').trim();
}

const server = new McpServer({
	name: 'warcraft-wiki',
	version: '1.4.0',
	description: 'Warcraft wiki API companion - behavioral API docs, restrictions, structured payload details, and patch history.',
});

server.registerTool(
	'wiki_lookup',
	{
		description: `Look up a WoW API function, event, or closely related technical wiki page. Returns readable documentation plus structured fields for arguments, returns, payloads, patch history, and deprecation metadata.

Accepts function names like "C_Spell.GetSpellCooldown", "GetSpellInfo", event names like "SPELL_UPDATE_COOLDOWN", and exact technical page names such as "Enum.SpellBookSpellBank" when those pages exist.

Use the section parameter to retrieve a focused section while still receiving the full compatible lookup envelope.`,
		inputSchema: {
			name: z.string().describe('API function, event, or exact technical page name (e.g. "C_Spell.GetSpellCooldown", "SPELL_UPDATE_COOLDOWN", "Enum.SpellBookSpellBank")'),
			section: z.enum(SECTION_KEYS).optional().describe('Specific section to focus on (default: all).'),
		},
		outputSchema: lookupOutputSchema,
	},
	async ({ name, section = 'all' }) => {
		const title = normalizePageTitle(name);

		try {
			const data = await client.fetchPage(title);

			if (data.error) {
				const error = data.error.code === 'missingtitle'
					? `No wiki page found for "${name}" (tried: ${title}).`
					: `Wiki API error: ${data.error.info || data.error.code}`;
				const guidance = data.error.code === 'missingtitle'
					? `Try wiki_search for API documentation matches, or wiki_namespace with a prefix like "${name.split('.')[0]}".`
					: error;

				return {
					content: [{ type: 'text', text: `${error}\n\n${guidance}`.trim() }],
					structuredContent: buildEmptyLookupOutput(name, title, error, section),
					isError: true,
				};
			}

			const html = data.parse?.text?.['*'];
			if (!html) {
				const error = `Page "${title}" returned no content.`;
				return {
					content: [{ type: 'text', text: error }],
					structuredContent: buildEmptyLookupOutput(name, title, error, section),
					isError: true,
				};
			}

			const pageTitle = data.parse.title || title;
			const parsed = parseWikiPage(html, pageTitle, data.parse?.categories || []);

			return {
				content: [{ type: 'text', text: formatLookupResult(parsed, section) }],
				structuredContent: buildLookupOutput(parsed, section),
			};
		} catch (error) {
			const message = `Failed to fetch wiki page: ${error.message}`;
			return {
				content: [{ type: 'text', text: message }],
				structuredContent: buildEmptyLookupOutput(name, title, message, section),
				isError: true,
			};
		}
	}
);

server.registerTool(
	'wiki_search',
	{
		description: 'Search Warcraft Wiki for API/event documentation pages only. Search stays strict to technical docs, but uses category-aware enrichment and ranking to improve vague technical queries.',
		inputSchema: {
			query: z.string().describe('Technical search terms (e.g. "spell cooldown", "unit aura tracking", "action bar slot")'),
			limit: z.number().optional().describe('Max results to return after filtering (default: 10, max: 20)'),
		},
		outputSchema: searchOutputSchema,
	},
	async ({ query, limit }) => {
		const resultLimit = Math.min(limit || 10, 20);

		try {
			const results = await runScopedSearch(query, resultLimit);
			const structuredContent = {
				error: null,
				query,
				scope: 'api-docs',
				results,
			};

			if (results.length === 0) {
				return {
					content: [{
						type: 'text',
						text: `No in-scope API documentation results found for "${query}".\n\nThis search is intentionally limited to API, event, enum, widget, and closely related technical pages. Try an exact API/event name with wiki_lookup or browse a namespace with wiki_namespace.`,
					}],
					structuredContent,
				};
			}

			return {
				content: [{ type: 'text', text: formatSearchResult(query, results) }],
				structuredContent,
			};
		} catch (error) {
			const message = `Wiki search failed: ${error.message}`;
			return {
				content: [{ type: 'text', text: message }],
				structuredContent: {
					error: message,
					query,
					scope: 'api-docs',
					results: [],
				},
				isError: true,
			};
		}
	}
);

server.registerTool(
	'wiki_namespace',
	{
		description: 'List Warcraft Wiki API pages for a given namespace prefix. Useful for browsing all functions in a C_ namespace or finding legacy globals with a shared prefix.',
		inputSchema: {
			prefix: z.string().describe('Namespace or function prefix (e.g. "C_Spell", "C_Item", "GetSpell", "Unit")'),
		},
		outputSchema: namespaceOutputSchema,
	},
	async ({ prefix }) => {
		const searchedPrefix = normalizeNamespacePrefix(prefix);

		try {
			const pages = await client.listByPrefix(searchedPrefix);
			const results = pages.map(page => ({
				title: cleanTitle(page.title || ''),
				url: wikiPageUrl(page.title || ''),
				pageKind: classifyPageTitle(page.title || ''),
			}));

			if (results.length === 0) {
				const error = `No wiki pages found with prefix "${prefix}" (searched: ${searchedPrefix}).`;
				return {
					content: [{ type: 'text', text: error }],
					structuredContent: {
						error,
						prefix,
						searchedPrefix,
						results: [],
					},
				};
			}

			const lines = [
				`Wiki pages with prefix "${prefix}" (${results.length} results):`,
				'',
				...results.map(result => `  ${result.title}`),
			];

			return {
				content: [{ type: 'text', text: lines.join('\n') }],
				structuredContent: {
					error: null,
					prefix,
					searchedPrefix,
					results,
				},
			};
		} catch (error) {
			const message = `Wiki namespace listing failed: ${error.message}`;
			return {
				content: [{ type: 'text', text: message }],
				structuredContent: {
					error: message,
					prefix,
					searchedPrefix,
					results: [],
				},
				isError: true,
			};
		}
	}
);

const transport = new StdioServerTransport();
await server.connect(transport);
