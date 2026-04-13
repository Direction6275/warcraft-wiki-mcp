import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

async function main() {
	const client = new Client({ name: 'warcraft-wiki-smoke', version: '1.0.0' });
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ['src/index.mjs'],
		cwd: process.cwd(),
		stderr: 'pipe',
	});

	transport.stderr?.on('data', chunk => process.stderr.write(chunk));

	await client.connect(transport);
	await client.listTools();

	try {
		const lookup = await client.callTool({ name: 'wiki_lookup', arguments: { name: 'C_Spell.GetSpellCooldown' } });
		const lookupData = lookup.structuredContent;
		assert(lookupData.arguments, 'Expected arguments text for C_Spell.GetSpellCooldown');
		assert(lookupData.details, 'Expected details text for C_Spell.GetSpellCooldown');
		assert(lookupData.returnsData?.items, 'Expected structured returnsData for C_Spell.GetSpellCooldown');
		const returnNames = lookupData.returnsData.items.map(item => item.name);
		for (const expected of ['startTime', 'duration', 'isEnabled', 'modRate', 'isOnGCD']) {
			assert(returnNames.includes(expected), `Expected returnsData item "${expected}"`);
		}
		const isOnGCD = lookupData.returnsData.items.find(item => item.name === 'isOnGCD');
		assert(isOnGCD.annotations.includes('NeverSecret'), 'Expected NeverSecret annotation on isOnGCD');

		const legacy = await client.callTool({ name: 'wiki_lookup', arguments: { name: 'GetSpellCooldown' } });
		const legacyData = legacy.structuredContent;
		assert(legacyData.deprecated, 'Expected deprecated text for GetSpellCooldown');
		assert(legacyData.deprecationInfo?.isDeprecated === true, 'Expected GetSpellCooldown to be marked deprecated');
		assert(legacyData.deprecationInfo?.deprecatedIn === '11.0.0', 'Expected deprecatedIn=11.0.0');
		assert(legacyData.deprecationInfo?.removedIn === '11.0.0', 'Expected removedIn=11.0.0 from patch history');
		assert(legacyData.deprecationInfo?.hasConflict === true, 'Expected conflicting deprecation metadata to be surfaced');
		assert(legacyData.deprecationInfo?.recommendedState === 'removed', 'Expected recommendedState=removed');
		assert(
			legacyData.deprecationInfo?.replacementApis?.includes('C_Spell.GetSpellCooldown'),
			'Expected replacement API C_Spell.GetSpellCooldown'
		);

		const payload = await client.callTool({ name: 'wiki_lookup', arguments: { name: 'SPELL_UPDATE_COOLDOWN', section: 'payload' } });
		const payloadData = payload.structuredContent;
		assert(payloadData.selectedSection === 'payload', 'Expected selectedSection=payload');
		assert(payloadData.selectedSectionText, 'Expected selectedSectionText for payload');
		assert(payloadData.selectedSectionData?.items?.some(item => item.name === 'spellID'), 'Expected payload spellID item');

		const widgetLookup = await client.callTool({ name: 'wiki_lookup', arguments: { name: 'GameTooltip SetUnitAura' } });
		const widgetData = widgetLookup.structuredContent;
		assert(widgetData.title === 'GameTooltip:SetUnitAura', 'Expected normalized widget method title');
		assert(
			widgetData.arguments || widgetData.returns,
			'Expected legacy widget page to expose arguments or returns as separate sections'
		);
		assert(widgetData.returnsData === null, 'Expected legacy widget returnsData to be null when return shape is unknown');
		const widgetArgumentNames = widgetData.argumentsData?.items?.map(item => item.name) || [];
		for (const expectedName of ['unitId', 'auraIndex', 'filter']) {
			assert(widgetArgumentNames.includes(expectedName), `Expected legacy widget argument item "${expectedName}"`);
		}
		for (const invalidName of ['String', 'Number', 'same']) {
			assert(!widgetArgumentNames.includes(invalidName), `Did not expect fake legacy argument item "${invalidName}"`);
		}

		const spellSearch = await client.callTool({ name: 'wiki_search', arguments: { query: 'spell cooldown', limit: 5 } });
		const spellTitles = spellSearch.structuredContent.results.map(result => result.title);
		assert(spellTitles.includes('C_Spell.GetSpellCooldown'), 'Expected spell cooldown search to include C_Spell.GetSpellCooldown');
		const cooldownIndex = spellTitles.indexOf('C_Spell.GetSpellCooldown');
		const remainingIndex = spellTitles.indexOf('C_Spell.GetSpellCooldownRemaining');
		assert(remainingIndex === -1 || cooldownIndex < remainingIndex, 'Expected canonical cooldown API to rank above helper variants');
		assert(spellSearch.structuredContent.results.every(result => result.pageKind !== 'unknown'), 'Expected technical-only spell search results');

		const actionBarSearch = await client.callTool({ name: 'wiki_search', arguments: { query: 'action bar', limit: 5 } });
		const actionTitles = actionBarSearch.structuredContent.results.map(result => result.title);
		assert(actionTitles.includes('ChangeActionBarPage') || actionTitles.includes('GetActionBarPage'), 'Expected action bar APIs in search results');
		assert(actionTitles.indexOf('TRAIT_CONFIG_CREATED') === -1 || actionTitles.indexOf('TRAIT_CONFIG_CREATED') > 2, 'Expected incidental TRAIT_CONFIG_CREATED result to rank lower');

		const unitAuraSearch = await client.callTool({ name: 'wiki_search', arguments: { query: 'unit aura', limit: 5 } });
		const unitAuraTitles = unitAuraSearch.structuredContent.results.map(result => result.title);
		assert(
			unitAuraTitles.some(title => title === 'UNIT_AURA' || title.startsWith('C_')),
			'Expected unit aura search results to include a modern API or event'
		);
		assert(typeof lookupData.returns === 'string', 'Expected legacy string field returns to remain present');

		console.log('Smoke test passed.');
	} finally {
		await client.close();
		await transport.close();
	}
}

main().catch(error => {
	console.error(error.stack || String(error));
	process.exit(1);
});
