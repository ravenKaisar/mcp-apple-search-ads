/**
 * Renders docs/API-COVERAGE.md from docs/api-coverage.json. Used by `npm run docs:coverage` and by the
 * coverage test (which fails when the committed markdown is stale).
 */

interface Param {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  allowed?: string[];
  maximum?: number;
}

interface InventoryEndpoint {
  id: string;
  api: string;
  apiVersion: string;
  category: string;
  title: string;
  method: string;
  path: string;
  pathParams: Param[];
  queryParams: Param[];
  contextHeader: string | null;
  response: string;
  pagination: string;
  docUrl: string;
  implemented: boolean;
  required: boolean;
  mcpTool: string;
  notes?: string[];
}

interface ExcludedEndpoint {
  api: string;
  category: string;
  title: string;
  method: string;
  path: string;
  reason: string;
  note?: string;
}

interface ApiInfo {
  name: string;
  version: string;
  status: string;
  baseUrl: string;
  docs: string;
  authentication: string;
  headers: Record<string, string>;
  responseEnvelope: string;
  pagination: string;
  errors: string;
  rateLimits: string;
}

export interface Inventory {
  source: string;
  policy: { statement: string };
  apis: Record<string, ApiInfo>;
  endpoints: InventoryEndpoint[];
  excluded: ExcludedEndpoint[];
  notDocumented: { api: string; title: string; note: string }[];
}

const API_ORDER = ['campaign-management-v5', 'platform-v1'];
const REASONS: Record<string, string> = {
  mutation: 'Mutation (create / update / delete / apply / dismiss / upload)',
  'read-via-post': 'Read-only query implemented by Apple as POST (/find, /query)',
  'report-generation-via-post': 'Report generation via POST',
  'async-report-job-creation': 'Creates an asynchronous report job (POST)',
};

function cell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function formatParam(param: Param): string {
  const extras: string[] = [];
  if (param.default !== undefined) extras.push(`default ${JSON.stringify(param.default)}`);
  if (param.maximum !== undefined) extras.push(`max ${param.maximum}`);
  if (param.allowed) extras.push(param.allowed.join('/'));
  const flag = param.required ? '**' : '';
  return `${flag}${param.name}${flag}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`;
}

export function renderCoverageMarkdown(inventory: Inventory): string {
  const lines: string[] = [];
  const getCount = inventory.endpoints.length;
  const implemented = inventory.endpoints.filter((e) => e.implemented).length;
  lines.push('# API Coverage');
  lines.push('');
  lines.push(
    '<!-- Generated from docs/api-coverage.json by `npm run docs:coverage`. Do not edit by hand. -->',
  );
  lines.push('');
  lines.push(`> ${inventory.policy.statement}`);
  lines.push('');
  lines.push(`Source: ${inventory.source}.`);
  lines.push('');
  lines.push('| | GET endpoints | Implemented | Excluded (non-GET) |');
  lines.push('|---|---:|---:|---:|');
  for (const api of API_ORDER) {
    const gets = inventory.endpoints.filter((e) => e.api === api);
    lines.push(
      `| ${inventory.apis[api]?.name ?? api} | ${gets.length} | ${gets.filter((e) => e.implemented).length} | ${inventory.excluded.filter((e) => e.api === api).length} |`,
    );
  }
  lines.push(`| **Total** | **${getCount}** | **${implemented}** | **${inventory.excluded.length}** |`);
  lines.push('');

  lines.push('## APIs');
  lines.push('');
  for (const api of API_ORDER) {
    const info = inventory.apis[api];
    if (!info) continue;
    lines.push(`### ${info.name}`);
    lines.push('');
    lines.push(`- **Version:** ${info.version}`);
    lines.push(`- **Status:** ${info.status}`);
    lines.push(`- **Base URL:** \`${info.baseUrl}\``);
    lines.push(`- **Docs:** ${info.docs}`);
    lines.push(`- **Authentication:** ${info.authentication}`);
    for (const [name, value] of Object.entries(info.headers))
      lines.push(`- **Header \`${name}\`:** ${value}`);
    lines.push(`- **Response envelope:** \`${info.responseEnvelope}\``);
    lines.push(`- **Pagination:** ${info.pagination}`);
    lines.push(`- **Errors:** ${info.errors}`);
    lines.push(`- **Rate limits:** ${info.rateLimits}`);
    lines.push('');
  }

  lines.push('## Implemented GET endpoints');
  lines.push('');
  lines.push(
    'Required parameters are in **bold**. "Context" is the `X-AP-Context` key the endpoint requires.',
  );
  lines.push('');
  for (const api of API_ORDER) {
    lines.push(`### ${inventory.apis[api]?.name ?? api}`);
    lines.push('');
    lines.push(
      '| MCP tool | Category | Method & path | Path params | Query params | Context | Pagination | Response | Docs |',
    );
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const e of inventory.endpoints.filter((x) => x.api === api)) {
      lines.push(
        `| \`${e.mcpTool}\` | ${cell(e.category)} | \`${e.method} ${e.path}\` | ${e.pathParams.map(formatParam).join(', ') || '-'} | ${cell(e.queryParams.map(formatParam).join(', ') || '-')} | ${e.contextHeader ?? 'none'} | ${cell(e.pagination)} | ${cell(e.response)} | [${cell(e.title)}](${e.docUrl}) |`,
      );
    }
    lines.push('');
  }

  lines.push('## Intentionally excluded (non-GET) endpoints');
  lines.push('');
  lines.push(
    'None of these are implemented. Read-style operations that Apple exposes only through POST (including every report) are excluded as well, because the server never sends anything but GET to the Apple Ads APIs.',
  );
  lines.push('');
  for (const api of API_ORDER) {
    lines.push(`### ${inventory.apis[api]?.name ?? api}`);
    lines.push('');
    lines.push('| Category | Title | Method | Path | Reason |');
    lines.push('|---|---|---|---|---|');
    for (const e of inventory.excluded.filter((x) => x.api === api)) {
      lines.push(
        `| ${cell(e.category)} | ${cell(e.title)} | ${e.method} | \`${e.path}\` | ${cell(REASONS[e.reason] ?? e.reason)}${e.note ? ` - ${cell(e.note)}` : ''} |`,
      );
    }
    lines.push('');
  }

  if (inventory.notDocumented.length > 0) {
    lines.push('## Not implementable');
    lines.push('');
    for (const item of inventory.notDocumented) lines.push(`- **${item.title}** (${item.api}): ${item.note}`);
    lines.push('');
  }
  return lines.join('\n');
}
