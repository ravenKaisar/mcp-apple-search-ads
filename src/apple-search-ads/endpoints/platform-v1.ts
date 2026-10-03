import type { ValidationIssue } from '../errors.js';
import {
  booleanParam,
  countryCodeListParam,
  countryCodeParam,
  enumParam,
  int64Id,
  limitParam,
  offsetParam,
  opaqueId,
  productPageId,
  stringListParam,
  textParam,
  uuidId,
} from './params.js';
import type { EndpointDefinition, ParamSpec } from './types.js';
import { z } from 'zod';

/**
 * Every GET endpoint of the Apple Ads Platform API v1
 * (https://developer.apple.com/documentation/apple-ads-platform-api), base URL https://api.ads.apple.com/v1.
 *
 * In the Platform API all list/search/report reads except /search/apps and /search/geo are POST
 * `/query` endpoints; those are intentionally not implemented (see docs/api-coverage.json -> excluded).
 */

const api = 'platform-v1' as const;
const id = (what: string) => opaqueId(`The unique identifier of the ${what}`);

const changeHistoryDetailId: ParamSpec = {
  required: true,
  description:
    'Composite change identifier "EntityType.entityId.txnId" (e.g. "Campaign.444555666.txn_abc123def456"), from the change-history query.',
  schema: z
    .string()
    .regex(
      /^[A-Za-z][A-Za-z0-9]{0,63}\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{1,128}$/,
      'must look like EntityType.entityId.txnId',
    ),
};

function searchAppsValidation(args: Readonly<Record<string, unknown>>): ValidationIssue[] {
  const hasQuery = typeof args.query === 'string' && args.query.length > 0;
  const hasCpids = Array.isArray(args.cpids) && args.cpids.length > 0;
  const ownedApps = args.returnOwnedApps === true;
  if (hasQuery || hasCpids || ownedApps) return [];
  return [
    {
      path: 'query',
      message:
        'provide at least one of query, cpids or returnOwnedApps=true (Apple returns INVALID_INPUT otherwise)',
    },
  ];
}

export const PLATFORM_V1_ENDPOINTS: readonly EndpointDefinition[] = [
  // ---------------------------------------------------------------- Account management
  {
    id: 'platform.getMe',
    toolName: 'platform_get_me',
    api,
    category: 'Account Management',
    title: 'Get Me Details',
    description:
      'Returns the userId and orgId bound to the access token. Does not require an ad account context.',
    method: 'GET',
    path: '/me',
    pathParams: {},
    queryParams: {},
    requiresContext: false,
    docSlug: 'get-current-user-details',
    responseType: 'MeResponse',
  },
  {
    id: 'platform.getUserAcls',
    toolName: 'platform_get_user_acls',
    api,
    category: 'Account Management',
    title: 'Get User ACL',
    description:
      'Lists the ad accounts (id, name, orgId) and roles the API user can access. Start here to discover ad_account_id values. Does not require an ad account context.',
    method: 'GET',
    path: '/acls',
    pathParams: {},
    queryParams: {},
    requiresContext: false,
    docSlug: 'get-user-acls',
    responseType: 'UserAclListResponse',
  },
  {
    id: 'platform.getOrg',
    toolName: 'platform_get_org',
    api,
    category: 'Account Management',
    title: 'Get Org by ID',
    description:
      'Fetches an organization (name, currency, timezone, payment model, system status). Get the org id from platform_get_me. Does not require an ad account context.',
    method: 'GET',
    path: '/orgs/{id}',
    pathParams: { id: id('organization') },
    queryParams: {},
    requiresContext: false,
    docSlug: 'get-orgs-_id_',
    responseType: 'OrgResponse',
  },
  {
    id: 'platform.getAdAccount',
    toolName: 'platform_get_ad_account',
    api,
    category: 'Account Management',
    title: 'Get Ad Account by ID',
    description:
      'Fetches an ad account (product features, delegations, currency, timezone, payment model, system status).',
    method: 'GET',
    path: '/ad-accounts/{id}',
    pathParams: { id: id('ad account') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'get-ad-accounts-_id_',
    responseType: 'AdAccountResponse',
  },
  {
    id: 'platform.getAdvertiserResources',
    toolName: 'platform_get_advertiser_resources',
    api,
    category: 'Account Management',
    title: 'Get Advertiser Resources',
    description:
      'Lists the content providers (CPIDs) or business brands in the org that can be delegated to ad accounts. Does not require an ad account context.',
    method: 'GET',
    path: '/advertiser-resources',
    pathParams: {},
    queryParams: {
      resourceType: enumParam(
        ['CONTENT_PROVIDER', 'BUSINESS_BRAND'] as const,
        'CONTENT_PROVIDER returns CPIDs; BUSINESS_BRAND returns Apple Maps brand ids.',
        true,
      ),
    },
    requiresContext: false,
    docSlug: 'get-advertiser-resources',
    responseType: 'AdvertiserResourceListResponse',
  },
  // ---------------------------------------------------------------- Apps
  {
    id: 'platform.searchApps',
    toolName: 'platform_search_apps',
    api,
    category: 'Search Apps',
    title: 'Search for Apps',
    description:
      'Searches App Store apps by name/developer, content provider ids, or apps owned by your org. Provide at least one of query, cpids or returnOwnedApps=true. Supports offset/limit paging and fetch_all.',
    method: 'GET',
    path: '/search/apps',
    pathParams: {},
    queryParams: {
      query: textParam(
        'Free-text search over app and developer name (at least 3 characters, 2 for CJK languages).',
      ),
      returnOwnedApps: booleanParam('Return apps owned by your org (default false).'),
      cpids: stringListParam(
        'iTunes content provider ids (sent comma-separated).',
        /^[A-Za-z0-9_-]{1,64}$/,
        'must be a content provider id',
      ),
      storeFronts: countryCodeListParam('Restrict to these App Store storefronts', 'repeat'),
      offset: offsetParam(),
      limit: limitParam({
        max: 1000,
        defaultValue: 20,
        description:
          'Maximum results per page (Apple default 20; Apple caps it at a service-side maximum, this tool at 1000).',
      }),
    },
    requiresContext: true,
    pagination: {
      kind: 'offset',
      offsetParam: 'offset',
      limitParam: 'limit',
      defaultPageSize: 20,
      maxPageSize: 1000,
      fetchAllPageSize: 100,
      supportsFetchAll: true,
    },
    docSlug: 'searches-for-a-list-of-apps',
    responseType: 'AppsSearchResponse',
    validate: searchAppsValidation,
  },
  {
    id: 'platform.getAppDetails',
    toolName: 'platform_get_app_details',
    api,
    category: 'Search Apps',
    title: 'Get App Details by Adam ID',
    description:
      'Fetches App Store details for an app: name, artist, primary language and genres, device classes, icon, pre-order flag and available storefronts.',
    method: 'GET',
    path: '/apps/{adamId}',
    pathParams: { adamId: int64Id('The App Store app identifier (adamId)') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'get-app-details-by-adam-id',
    responseType: 'AppDetailsResponse',
  },
  {
    id: 'platform.getAppRejectionReason',
    toolName: 'platform_get_app_rejection_reason',
    api,
    category: 'App Eligibility',
    title: 'Get Rejection Reasons',
    description:
      'Fetches an ad creative rejection reason by id (reason code/type/level, placement, country, language).',
    method: 'GET',
    path: '/rejection-reasons/apps/{rejectionReasonId}',
    pathParams: { rejectionReasonId: int64Id('The rejection reason identifier') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'gets-rejection-reasons-by-id',
    responseType: 'RejectionReasonResponse',
  },
  // ---------------------------------------------------------------- Ads on Apple Maps
  {
    id: 'platform.getBrand',
    toolName: 'platform_get_brand',
    api,
    category: 'Ads on Apple Maps',
    title: 'Get Brand by ID',
    description: 'Fetches an Apple Maps business brand (name, country, categories, eligibility).',
    method: 'GET',
    path: '/business-brands/{id}',
    pathParams: { id: id('business brand (large numeric string)') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'get-brand-by-id',
    responseType: 'BrandResponse',
  },
  {
    id: 'platform.getBusinessCategory',
    toolName: 'platform_get_business_category',
    api,
    category: 'Ads on Apple Maps',
    title: 'Get Business Category',
    description: 'Fetches an Apple Maps business category (name, qualifiedId taxonomy path, eligibility).',
    method: 'GET',
    path: '/business-categories/{id}',
    pathParams: { id: id('business category') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'get-category-by-id',
    responseType: 'BusinessCategoryResponse',
  },
  {
    id: 'platform.getLocationGroup',
    toolName: 'platform_get_location_group',
    api,
    category: 'Ads on Apple Maps',
    title: 'Get Location Group',
    description:
      'Fetches an Apple Maps location group (static or dynamic rules, total locations, system status, eligibility). Soft-deleted groups are still returned.',
    method: 'GET',
    path: '/location-groups/{id}',
    pathParams: { id: id('location group') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'get-location-group-by-id',
    responseType: 'LocationGroupResponse',
  },
  {
    id: 'platform.getLocation',
    toolName: 'platform_get_location',
    api,
    category: 'Ads on Apple Maps',
    title: 'Get a Location',
    description: 'Fetches an Apple Maps business location (address, display point, status, eligibility).',
    method: 'GET',
    path: '/locations/{id}',
    pathParams: { id: id('location') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'get-location-by-id',
    responseType: 'LocationResponse',
  },
  // ---------------------------------------------------------------- Campaigns
  {
    id: 'platform.getCampaign',
    toolName: 'platform_get_campaign',
    api,
    category: 'Campaigns',
    title: 'Get a Campaign',
    description:
      'Fetches a campaign (promoted object, budget, targeting, bid strategy, status, system/display status). Returned regardless of deleted status. Listing campaigns requires POST /campaigns/query and is not supported.',
    method: 'GET',
    path: '/campaigns/{id}',
    pathParams: { id: id('campaign') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'get-campaigns-_id_',
    responseType: 'CampaignResponse',
  },
  {
    id: 'platform.getCampaignLegacyAppLimitedStatusReasons',
    toolName: 'platform_get_campaign_legacy_app_limited_status_reasons',
    api,
    category: 'Campaigns',
    title: 'Get Legacy App Limited Status Reason Details',
    description:
      'Returns, for a legacy app campaign, a map of country/region code to limited-status reasons. Use it to diagnose why a campaign is not delivering in specific markets.',
    method: 'GET',
    path: '/campaigns/{id}/legacy-app-limited-status-reason-details',
    pathParams: { id: id('campaign') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'get-campaigns-_id_-legacy-app-limited-status-reason-details',
    responseType: 'LegacyAppLimitedStatusReasonDetailsResponse',
  },
  // ---------------------------------------------------------------- Ad groups
  {
    id: 'platform.getAdGroup',
    toolName: 'platform_get_ad_group',
    api,
    category: 'Ad Groups',
    title: 'Get an Ad Group',
    description:
      'Fetches an ad group (targeting, bid strategy, pricing model, status, system/display status).',
    method: 'GET',
    path: '/adgroups/{id}',
    pathParams: { id: id('ad group') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'get-adgroups-_id_',
    responseType: 'AdGroupResponse',
  },
  // ---------------------------------------------------------------- Geo targeting
  {
    id: 'platform.searchGeoLocations',
    toolName: 'platform_search_geo_locations',
    api,
    category: 'Geo Targeting',
    title: 'Search Geo Locations',
    description:
      'Searches geographic locations for ad group geo targeting. supplySource is required (APPSTORE excludes PostalCode; MAPS excludes Country and covers US/Canada). Supports offset/pageSize paging and fetch_all.',
    method: 'GET',
    path: '/search/geo',
    pathParams: {},
    queryParams: {
      supplySource: enumParam(['APPSTORE', 'MAPS'] as const, 'Supply source the geo targeting is for.', true),
      query: textParam('Search text (minimum 2 characters; omit or "*" to return all).'),
      entity: enumParam(
        ['Country', 'AdminArea', 'Locality', 'PostalCode'] as const,
        'Restrict results to one geo entity type.',
      ),
      countrycode: countryCodeParam(
        'Country to search within (Apple default "US" for AdminArea/Locality/PostalCode)',
      ),
      eligible: booleanParam(
        'true excludes soft-blocked geos; false (default) includes them with eligibility data.',
      ),
      offset: offsetParam(),
      pageSize: limitParam({
        name: 'pageSize',
        max: 1000,
        defaultValue: 20,
        description: 'Results per page (Apple default 20; this tool caps it at 1000).',
      }),
    },
    requiresContext: true,
    pagination: {
      kind: 'offset',
      offsetParam: 'offset',
      limitParam: 'pageSize',
      defaultPageSize: 20,
      maxPageSize: 1000,
      fetchAllPageSize: 100,
      supportsFetchAll: true,
    },
    docSlug: 'searches-for-a-list-of-geo-locations',
    responseType: 'GeoSearchResponse',
  },
  // ---------------------------------------------------------------- Keywords
  {
    id: 'platform.getKeyword',
    toolName: 'platform_get_keyword',
    api,
    category: 'Keywords',
    title: 'Get a Keyword',
    description:
      'Fetches a targeting keyword (text, match type, bid, status, display status). Deleted keywords are returned with deleted=true.',
    method: 'GET',
    path: '/keywords/{id}',
    pathParams: { id: id('keyword') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'get-keywords-_id_',
    responseType: 'KeywordResponse',
  },
  {
    id: 'platform.getNegativeKeyword',
    toolName: 'platform_get_negative_keyword',
    api,
    category: 'Negative Keywords',
    title: 'Get a Negative Keyword',
    description:
      'Fetches a negative keyword. Without adGroupId it is campaign-level; with adGroupId it is ad-group-level.',
    method: 'GET',
    path: '/negative-keywords/{id}',
    pathParams: { id: id('negative keyword') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'get-negative-keywords-_id_',
    responseType: 'NegativeKeywordResponse',
  },
  // ---------------------------------------------------------------- Ads
  {
    id: 'platform.getAd',
    toolName: 'platform_get_ad',
    api,
    category: 'Ads',
    title: 'Get an Ad',
    description: 'Fetches an ad (creative, ad group, status, system status and reasons, display status).',
    method: 'GET',
    path: '/ads/{id}',
    pathParams: { id: id('ad') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'get-ads-_id_',
    responseType: 'AdResponse',
  },
  // ---------------------------------------------------------------- Creatives
  {
    id: 'platform.getCreative',
    toolName: 'platform_get_creative',
    api,
    category: 'Creatives',
    title: 'Get an Ad Creative',
    description:
      'Fetches an ad creative (type, spec, destination, system status, eligibility). Deleted creatives return 404.',
    method: 'GET',
    path: '/creatives/{id}',
    pathParams: { id: id('ad creative') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'get-creatives-_id_',
    responseType: 'CreativeResponse',
  },
  // ---------------------------------------------------------------- Assets
  {
    id: 'platform.getAsset',
    toolName: 'platform_get_asset',
    api,
    category: 'Assets',
    title: 'Get Asset',
    description:
      'Fetches an uploaded asset (image details, promoted object, eligibility). Deleted assets are returned with deleted=true.',
    method: 'GET',
    path: '/assets/{id}',
    pathParams: { id: uuidId('The asset identifier') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'get-asset-by-id',
    responseType: 'AssetResponse',
  },
  // ---------------------------------------------------------------- Product pages
  {
    id: 'platform.getProductPage',
    toolName: 'platform_get_product_page',
    api,
    category: 'Product Pages',
    title: 'Get Product Page by ID',
    description:
      'Fetches a product page (default, custom or optimization page) by its App Store Connect UUID.',
    method: 'GET',
    path: '/product-pages/{productPageId}',
    pathParams: { productPageId: productPageId('The product page UUID assigned by App Store Connect') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'get-product-page-by-id',
    responseType: 'ProductPageDetailsResponse',
  },
  // ---------------------------------------------------------------- Budget orders
  {
    id: 'platform.getBudgetOrder',
    toolName: 'platform_get_budget_order',
    api,
    category: 'Budget Orders',
    title: 'Get a Budget Order by ID',
    description:
      'Fetches a budget order (shared budget): value, date range, assigned ad accounts, invoice details.',
    method: 'GET',
    path: '/shared-budgets/{id}',
    pathParams: { id: id('budget order') },
    queryParams: {},
    requiresContext: true,
    docSlug: 'get-shared-budgets-_id_',
    responseType: 'SharedBudgetResponse',
  },
  // ---------------------------------------------------------------- Change history
  {
    id: 'platform.getChangeHistoryDetail',
    toolName: 'platform_get_change_history_detail',
    api,
    category: 'Change History',
    title: 'Get Change History Detail',
    description:
      'Returns field-level before/after values for one entity change. limit/offset page through the nested "changes" entries. Querying the change history list requires POST and is not supported.',
    method: 'GET',
    path: '/change-history/{detailId}',
    pathParams: { detailId: changeHistoryDetailId },
    queryParams: {
      limit: limitParam({
        max: 10_000,
        defaultValue: 100,
        description: 'Maximum number of entries to return from the changes array (Apple default 100).',
      }),
      offset: offsetParam('Zero-based index of the first changes entry to return (default 0).'),
    },
    requiresContext: true,
    docSlug: 'get-change-details-by-detailid',
    responseType: 'ChangeDetailsResponse',
    notes: ['limit/offset apply to the nested changes array, so fetch_all is not offered for this endpoint.'],
  },
];
