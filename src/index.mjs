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
	deriveRelatedEvents,
	deriveCodingNotes,
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
const RESOLVE_STOP_WORDS = new Set([
	'a',
	'an',
	'and',
	'check',
	'detect',
	'display',
	'find',
	'for',
	'get',
	'handle',
	'listen',
	'listening',
	'show',
	'the',
	'to',
	'track',
	'tracking',
	'update',
	'updates',
	'use',
	'using',
	'watch',
	'when',
]);

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

const codingNoteSchema = z.object({
	severity: z.enum(['info', 'warning']),
	topic: z.string(),
	text: z.string(),
	relatedEvents: z.array(z.string()),
	sourceSection: z.string().nullable(),
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
	relatedEventsData: z.array(z.string()),
	warnings: z.array(codingNoteSchema),
	codingNotes: z.array(codingNoteSchema),
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

const resolveRecommendationSchema = z.object({
	title: z.string(),
	url: z.string(),
	pageKind: z.enum(PAGE_KINDS),
	snippet: z.string().nullable(),
	confidence: z.enum(['high', 'medium', 'low']),
	score: z.number(),
	reason: z.string(),
	recommendedNextTools: z.array(z.string()),
	deprecationInfo: deprecationInfoSchema,
	relatedEventsData: z.array(z.string()),
	warnings: z.array(codingNoteSchema),
	codingNotes: z.array(codingNoteSchema),
	availableSections: z.array(z.string()),
	error: z.string().nullable(),
});

const resolveOutputSchema = z.object({
	error: z.string().nullable(),
	query: z.string(),
	scope: z.literal('api-docs'),
	recommendations: z.array(resolveRecommendationSchema),
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

function buildLookupSignals(parsed) {
	const relatedEventsData = deriveRelatedEvents(parsed);
	const codingNotes = deriveCodingNotes(parsed, relatedEventsData);
	const warnings = codingNotes.filter(note => note.severity === 'warning');
	return { relatedEventsData, codingNotes, warnings };
}

function buildLookupOutput(parsed, section = 'all', error = null) {
	const signals = buildLookupSignals(parsed);
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
		relatedEvents: parsed.sections.related_events || (signals.relatedEventsData.length > 0 ? signals.relatedEventsData.join('\n') : null),
		relatedEventsData: signals.relatedEventsData,
		warnings: signals.warnings,
		codingNotes: signals.codingNotes,
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
		relatedEventsData: [],
		warnings: [],
		codingNotes: [],
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
	const signals = buildLookupSignals(parsed);
	lines.push(`=== ${parsed.title} ===`);
	lines.push(`Kind: ${parsed.pageKind}`);
	lines.push(`Source: ${parsed.url}`);
	lines.push('');

	if (parsed.deprecated) {
		lines.push(`[DEPRECATED] ${parsed.deprecated}`);
		lines.push('');
	}

	if (signals.codingNotes.length > 0) {
		lines.push('Coding notes:');
		for (const note of signals.codingNotes) {
			const related = note.relatedEvents.length > 0 ? ` Related events: ${note.relatedEvents.join(', ')}.` : '';
			lines.push(`- [${note.severity}] ${note.text}${related}`);
		}
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

async function runRankedScopedSearch(query, limit) {
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
		.map(result => ({
			...result,
			score: scoreSearchResult(result, normalizedQuery),
		}))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);

	return results;
}

async function runScopedSearch(query, limit) {
	const results = await runRankedScopedSearch(query, limit);
	return results.map(({ title, url, pageKind, snippet }) => ({ title, url, pageKind, snippet }));
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

async function buildResolveRecommendations(query, limit) {
	const rankedResults = await runRankedResolveSearch(query, Math.min(limit || 5, 5));
	const topScore = rankedResults[0]?.score || 0;
	const recommendations = [];

	for (let index = 0; index < rankedResults.length; index++) {
		const result = rankedResults[index];
		const details = await lookupResolveDetails(result);
		const confidence = resolveConfidence(result, index, topScore);
		const recommendation = {
			title: result.title,
			url: result.url,
			pageKind: result.pageKind,
			snippet: result.snippet,
			confidence,
			score: result.score,
			reason: buildResolveReason(result, confidence, details),
			recommendedNextTools: buildRecommendedNextTools(result, details),
			...details,
		};
		recommendations.push(recommendation);
	}

	return recommendations;
}

async function runRankedResolveSearch(query, limit) {
	const resultMap = new Map();
	const resolveQueries = buildResolveSearchQueries(query);

	for (const resolveQuery of resolveQueries) {
		const results = await runRankedScopedSearch(resolveQuery, Math.max(limit, 5));
		const queryBoost = resolveQuery === query ? 0 : 25;
		for (const result of results) {
			const key = result.rawTitle || result.title;
			const existing = resultMap.get(key);
			const adjusted = {
				...result,
				score: result.score + queryBoost,
			};
			if (!existing || adjusted.score > existing.score) {
				resultMap.set(key, adjusted);
			}
		}
	}

	return [...resultMap.values()]
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
}

function buildResolveSearchQueries(query) {
	const normalized = normalizeSearchText(query);
	const words = normalized.split(' ').filter(word => word && !RESOLVE_STOP_WORDS.has(word));
	const stripped = words.join(' ');
	const queries = [];

	if (/\bcooldown\b/i.test(normalized)) {
		queries.push('spell cooldown', 'cooldown event');
	}
	if (/\baura\b/i.test(normalized) && /\b(change|changes|update|updates|removed|added|track|tracking|listen|listening)\b/i.test(normalized)) {
		queries.push('unit aura', 'UNIT_AURA');
	}
	if (/\btooltip\b/i.test(normalized) && /\baura\b/i.test(normalized)) {
		queries.push('tooltip aura', 'GameTooltip SetUnitAura');
	}
	if (stripped && stripped !== normalized) queries.push(stripped);
	if (queries.length === 0) queries.push(query);
	if (stripped === normalized && !queries.includes(query)) queries.push(query);

	return [...new Set(queries.filter(Boolean))].slice(0, 4);
}

async function lookupResolveDetails(result) {
	try {
		const data = await client.fetchPage(result.rawTitle || normalizePageTitle(result.title));
		if (data.error || !data.parse?.text?.['*']) {
			const message = data.error?.info || data.error?.code || 'No page content returned.';
			return buildEmptyResolveDetails(`Unable to inspect candidate details: ${message}`);
		}

		const parsed = parseWikiPage(data.parse.text['*'], data.parse.title || result.rawTitle, data.parse?.categories || []);
		const signals = buildLookupSignals(parsed);
		return {
			deprecationInfo: parsed.deprecationInfo,
			relatedEventsData: signals.relatedEventsData,
			warnings: signals.warnings,
			codingNotes: signals.codingNotes,
			availableSections: lookupAvailableSections(parsed),
			error: null,
		};
	} catch (error) {
		return buildEmptyResolveDetails(`Unable to inspect candidate details: ${error.message}`);
	}
}

function buildEmptyResolveDetails(error = null) {
	return {
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
		relatedEventsData: [],
		warnings: [],
		codingNotes: [],
		availableSections: [],
		error,
	};
}

function resolveConfidence(result, index, topScore) {
	if (index === 0 && result.score >= 1700) return 'high';
	if (result.score >= Math.max(1000, topScore * 0.65)) return 'medium';
	return 'low';
}

function buildResolveReason(result, confidence, details) {
	const parts = [`${confidence} confidence ${result.pageKind} match from API-scoped search.`];
	if (details.deprecationInfo.recommendedState !== 'active') {
		parts.push(`Marked ${details.deprecationInfo.recommendedState}; prefer a replacement when one is listed.`);
	}
	if (details.relatedEventsData.length > 0) {
		parts.push(`Related events: ${details.relatedEventsData.join(', ')}.`);
	}
	if (details.warnings.length > 0) {
		parts.push(`${details.warnings.length} coding warning(s) found.`);
	}
	if (details.error) {
		parts.push(details.error);
	}
	return parts.join(' ');
}

function buildRecommendedNextTools(result, details) {
	const nextTools = [`wiki_lookup({ "name": "${result.title}" })`];
	if (details.relatedEventsData.length > 0) {
		for (const eventName of details.relatedEventsData.slice(0, 3)) {
			nextTools.push(`wiki_lookup({ "name": "${eventName}", "section": "payload" })`);
		}
	}
	return nextTools;
}

function formatResolveResult(query, recommendations) {
	if (recommendations.length === 0) {
		return `No in-scope API documentation recommendations found for "${query}".`;
	}

	const lines = [`Wiki API resolution: "${query}"`, ''];
	for (let index = 0; index < recommendations.length; index++) {
		const recommendation = recommendations[index];
		lines.push(`${index + 1}. ${recommendation.title} [${recommendation.pageKind}, ${recommendation.confidence}]`);
		lines.push(`   ${recommendation.reason}`);
		if (recommendation.snippet) lines.push(`   ${recommendation.snippet}`);
		lines.push(`   Next: ${recommendation.recommendedNextTools.join(' -> ')}`);
		lines.push(`   ${recommendation.url}`);
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
	'wiki_resolve',
	{
		description: `Resolve a coding-oriented WoW API question into ranked Warcraft Wiki documentation candidates.

Use this when an agent knows the intended behavior but not the exact API, event, enum, or widget page to inspect. Results include confidence, deprecation state, related events, coding warnings, and suggested follow-up wiki_lookup calls.`,
		inputSchema: {
			query: z.string().describe('Coding intent or technical search terms (e.g. "track spell cooldown", "listen for aura changes", "tooltip aura API")'),
			limit: z.number().optional().describe('Max recommendations to return after filtering (default: 5, max: 5)'),
		},
		outputSchema: resolveOutputSchema,
	},
	async ({ query, limit }) => {
		try {
			const recommendations = await buildResolveRecommendations(query, limit);
			const structuredContent = {
				error: null,
				query,
				scope: 'api-docs',
				recommendations,
			};

			return {
				content: [{ type: 'text', text: formatResolveResult(query, recommendations) }],
				structuredContent,
			};
		} catch (error) {
			const message = `Wiki resolution failed: ${error.message}`;
			return {
				content: [{ type: 'text', text: message }],
				structuredContent: {
					error: message,
					query,
					scope: 'api-docs',
					recommendations: [],
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
