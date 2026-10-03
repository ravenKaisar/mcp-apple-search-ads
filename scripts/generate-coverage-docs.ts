import { readFileSync, writeFileSync } from 'node:fs';
import { renderCoverageMarkdown, type Inventory } from './coverage-markdown.js';

const inventoryUrl = new URL('../docs/api-coverage.json', import.meta.url);
const markdownUrl = new URL('../docs/API-COVERAGE.md', import.meta.url);

const inventory = JSON.parse(readFileSync(inventoryUrl, 'utf8')) as Inventory;
writeFileSync(markdownUrl, renderCoverageMarkdown(inventory));
process.stderr.write(
  `Wrote docs/API-COVERAGE.md (${inventory.endpoints.length} GET, ${inventory.excluded.length} excluded)\n`,
);
