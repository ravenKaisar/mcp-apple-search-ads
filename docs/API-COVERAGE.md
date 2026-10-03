# API Coverage

<!-- Generated from docs/api-coverage.json by `npm run docs:coverage`. Do not edit by hand. -->

> This MCP server only supports Apple Search Ads GET APIs. Report-generation APIs and other endpoints requiring POST are intentionally excluded, even when they only read data.

Source: Apple official documentation (developer.apple.com/documentation/apple_ads and /apple-ads-platform-api), reviewed 2026-10-03.

| | GET endpoints | Implemented | Excluded (non-GET) |
|---|---:|---:|---:|
| Apple Search Ads Campaign Management API (Apple Ads Campaign Management API) | 30 | 30 | 43 |
| Apple Ads Platform API | 24 | 24 | 77 |
| **Total** | **54** | **54** | **120** |

## APIs

### Apple Search Ads Campaign Management API (Apple Ads Campaign Management API)

- **Version:** 5 (changelog through 5.6, June 2026)
- **Status:** Deprecated by Apple; sunset on 2027-01-26 in favour of the Apple Ads Platform API
- **Base URL:** `https://api.searchads.apple.com/api/v5`
- **Docs:** https://developer.apple.com/documentation/apple_ads
- **Authentication:** OAuth 2.0 client credentials: ES256 client-secret JWT (iss=teamId, sub=clientId, aud=https://appleid.apple.com, exp<=iat+180d, kid=keyId) exchanged at POST https://appleid.apple.com/auth/oauth2/token (scope=searchadsorg) for a 1-hour Bearer token
- **Header `Authorization`:** Bearer {access_token}
- **Header `X-AP-Context`:** orgId={orgId} - required on every endpoint except GET /acls and GET /me
- **Response envelope:** `{ data, pagination: { totalResults, startIndex, itemsPerPage } | null, error: { errors: [ { messageCode, message, field } ] } | null }`
- **Pagination:** GET list endpoints take limit (default 20, max 1000 for most objects) and offset (default 0) query parameters
- **Errors:** 400, 401, 403, 404, 429, 500 return ApiErrorResponse { error: { errors: [ErrorResponseItem] } }
- **Rate limits:** No numeric limits published; 429 when exceeded; Apple recommends exponential backoff (2s, 4s, 8s, 16s cap)

### Apple Ads Platform API

- **Version:** 1.0 (released August 2026)
- **Status:** Current
- **Base URL:** `https://api.ads.apple.com/v1`
- **Docs:** https://developer.apple.com/documentation/apple-ads-platform-api
- **Authentication:** Same OAuth 2.0 client-credentials flow as v5 (scope=searchadsorg, 1-hour Bearer token)
- **Header `Authorization`:** Bearer {access_token}
- **Header `X-AP-Context`:** adAccountId={adAccountId} - required except Get User ACLs, Get Me, Get Org by ID, Get Advertiser Resources (and POST /ad-accounts)
- **Response envelope:** `{ result, pagination?: { offset, pageSize, totalCount }, error?: { code, message, details: [ { code, message } ] } }`
- **Pagination:** Most list reads are POST /query with body pagination; the GET search endpoints take offset + limit/pageSize query parameters
- **Errors:** 400 bad_request, 401 unauthorized, 403 forbidden, 404 not_found, 429 rate_limit_exceeded, 500 internal_server_error
- **Rate limits:** RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset (seconds) on every response; 429 includes Retry-After (seconds); exponential backoff up to 16s

## Implemented GET endpoints

Required parameters are in **bold**. "Context" is the `X-AP-Context` key the endpoint requires.

### Apple Search Ads Campaign Management API (Apple Ads Campaign Management API)

| MCP tool | Category | Method & path | Path params | Query params | Context | Pagination | Response | Docs |
|---|---|---|---|---|---|---|---|---|
| `v5_get_user_acl` | User Access | `GET /acls` | - | - | none | none | UserAclListResponse {data:[UserAcl], pagination, error} | [Get User ACL](https://developer.apple.com/documentation/apple_ads/get-user-acl) |
| `v5_get_me_details` | User Access | `GET /me` | - | - | none | none | MeDetailResponse {data: MeDetail} | [Get Me Details](https://developer.apple.com/documentation/apple_ads/get-me-details) |
| `v5_search_apps` | Apps | `GET /search/apps` | - | **query**, returnOwnedApps (default false), limit (default 20, max 1000), offset (default 0) | orgId | offset/limit query params (default 20, max 1000); response pagination {totalResults,startIndex,itemsPerPage} | AppInfoListResponse {data:[AppInfo], pagination, error} | [Search for iOS Apps](https://developer.apple.com/documentation/apple_ads/search-for-ios-apps) |
| `v5_get_app_details` | App Details | `GET /apps/{adamId}` | **adamId** | - | orgId | none | MediaDetailResponse {data: MediaDetail} | [Get App Details](https://developer.apple.com/documentation/apple_ads/get-app-details) |
| `v5_get_localized_app_details` | App Details | `GET /apps/{adamId}/locale-details` | **adamId** | expand | orgId | none | MediaLocaleDetailResponse {data:[MediaLocaleDetail]} | [Get Localized App Details](https://developer.apple.com/documentation/apple_ads/get-localized-app-details) |
| `v5_get_campaign` | Campaigns | `GET /campaigns/{campaignId}` | **campaignId** | fields | orgId | none | CampaignResponse {data: Campaign, pagination, error} | [Get a Campaign](https://developer.apple.com/documentation/apple_ads/get-a-campaign) |
| `v5_get_all_campaigns` | Campaigns | `GET /campaigns` | - | limit (default 20, max 1000), offset (default 0), fields | orgId | offset/limit query params (default 20, max 1000); response pagination {totalResults,startIndex,itemsPerPage} | CampaignListResponse {data:[Campaign], pagination, error} | [Get all Campaigns](https://developer.apple.com/documentation/apple_ads/get-all-campaigns) |
| `v5_get_budget_order` | Budget Orders | `GET /budgetorders/{boId}` | **boId** | fields | orgId | none | BudgetOrderInfoResponse {data: {orgIds, bo: BudgetOrder}, pagination, error} | [Get a Budget Order](https://developer.apple.com/documentation/apple_ads/get-a-budget-order) |
| `v5_get_all_budget_orders` | Budget Orders | `GET /budgetorders` | - | limit (default 20, max 1000), offset (default 0), fields | orgId | offset/limit query params (default 20, max 1000); response pagination {totalResults,startIndex,itemsPerPage} | BudgetOrderInfoListResponse {data:[BudgetOrderInfo], pagination, error} | [Get all Budget Orders](https://developer.apple.com/documentation/apple_ads/get-all-budget-orders) |
| `v5_get_ad_group` | Ad Groups | `GET /campaigns/{campaignId}/adgroups/{adgroupId}` | **campaignId**, **adgroupId** | fields | orgId | none | AdGroupResponse {data: AdGroup, pagination, error} | [Get an Ad Group](https://developer.apple.com/documentation/apple_ads/get-an-ad-group) |
| `v5_get_all_ad_groups` | Ad Groups | `GET /campaigns/{campaignId}/adgroups` | **campaignId** | limit (default 20, max 1000), offset (default 0), fields | orgId | offset/limit query params (default 20, max 1000); response pagination {totalResults,startIndex,itemsPerPage} | AdGroupListResponse {data:[AdGroup], pagination, error} | [Get all Ad Groups](https://developer.apple.com/documentation/apple_ads/get-all-ad-groups) |
| `v5_get_targeting_keyword` | Targeting Keywords | `GET /campaigns/{campaignId}/adgroups/{adgroupId}/targetingkeywords/{keywordId}` | **campaignId**, **adgroupId**, **keywordId** | fields | orgId | none | KeywordResponse {data: Keyword, pagination, error} | [Get a Targeting Keyword in an Ad Group](https://developer.apple.com/documentation/apple_ads/get-a-targeting-keyword-in-an-ad-group) |
| `v5_get_all_targeting_keywords` | Targeting Keywords | `GET /campaigns/{campaignId}/adgroups/{adgroupId}/targetingkeywords` | **campaignId**, **adgroupId** | limit (default 20, max 1000), offset (default 0), fields | orgId | offset/limit query params (default 20, max 1000); response pagination {totalResults,startIndex,itemsPerPage} | KeywordListResponse {data:[Keyword], pagination, error} | [Get All Targeting Keywords in an Ad Group](https://developer.apple.com/documentation/apple_ads/get-all-targeting-keywords-in-an-ad-group) |
| `v5_get_campaign_negative_keyword` | Campaign Negative Keywords | `GET /campaigns/{campaignId}/negativekeywords/{keywordId}` | **campaignId**, **keywordId** | fields | orgId | none | NegativeKeywordResponse {data: NegativeKeyword, pagination, error} | [Get a Campaign Negative Keyword](https://developer.apple.com/documentation/apple_ads/get-a-campaign-negative-keyword) |
| `v5_get_all_campaign_negative_keywords` | Campaign Negative Keywords | `GET /campaigns/{campaignId}/negativekeywords` | **campaignId** | limit (default 20, max 1000), offset (default 0), fields | orgId | offset/limit query params (default 20, max 1000); response pagination {totalResults,startIndex,itemsPerPage} | NegativeKeywordListResponse {data:[NegativeKeyword], pagination, error} | [Get All Campaign Negative Keywords](https://developer.apple.com/documentation/apple_ads/get-all-campaign-negative-keywords) |
| `v5_get_ad_group_negative_keyword` | Ad Group Negative Keywords | `GET /campaigns/{campaignId}/adgroups/{adgroupId}/negativekeywords/{keywordId}` | **campaignId**, **adgroupId**, **keywordId** | fields | orgId | none | NegativeKeywordResponse {data: NegativeKeyword, pagination, error} | [Get an Ad Group Negative Keyword](https://developer.apple.com/documentation/apple_ads/get-an-ad-group-negative-keyword) |
| `v5_get_all_ad_group_negative_keywords` | Ad Group Negative Keywords | `GET /campaigns/{campaignId}/adgroups/{adgroupId}/negativekeywords` | **campaignId**, **adgroupId** | limit (default 20, max 1000), offset (default 0), fields | orgId | offset/limit query params (default 20, max 1000); response pagination {totalResults,startIndex,itemsPerPage} | NegativeKeywordListResponse {data:[NegativeKeyword], pagination, error} | [Get All Ad Group Negative Keywords](https://developer.apple.com/documentation/apple_ads/get-all-ad-group-negative-keywords) |
| `v5_search_geolocations` | Search Geolocations | `GET /search/geo` | - | query (default "*:*"), entity (Country/AdminArea/Locality), countrycode (default "US"), limit (default 20, max 1000), offset (default 0) | orgId | offset/limit query params (default 20, max 1000); response pagination {totalResults,startIndex,itemsPerPage} | SearchEntityListResponse {data:[SearchEntity], pagination, error} | [Search for Geolocations](https://developer.apple.com/documentation/apple_ads/search-for-geolocations) |
| `v5_get_ad` | Ads | `GET /campaigns/{campaignId}/adgroups/{adgroupId}/ads/{adId}` | **campaignId**, **adgroupId**, **adId** | fields | orgId | none | AdResponse {data: Ad} | [Get an Ad](https://developer.apple.com/documentation/apple_ads/get-an-ad) |
| `v5_get_all_ads` | Ads | `GET /campaigns/{campaignId}/adgroups/{adgroupId}/ads` | **campaignId**, **adgroupId** | limit (default 20, max 1000), offset (default 0), fields | orgId | offset/limit query params (default 20, max 1000); response pagination {totalResults,startIndex,itemsPerPage} | AdListResponse {data:[Ad], pagination} | [Get All Ads](https://developer.apple.com/documentation/apple_ads/get-all-ads) |
| `v5_get_ad_creative_rejection_reason` | Ad Rejection Reasons | `GET /product-page-reasons/{productPageReasonId}` | **productPageReasonId** | - | orgId | none | ProductPageReasonResponse {data: ProductPageReason} | [Get Ad Creative Rejection Reasons](https://developer.apple.com/documentation/apple_ads/gets-a-product-page-reason) |
| `v5_get_creative` | Creatives | `GET /creatives/{creativeId}` | **creativeId** | includeDeletedCreativeSetAssets, fields | orgId | none | CreativeResponse {data: Creative} | [Get a Creative](https://developer.apple.com/documentation/apple_ads/get-a-creative) |
| `v5_get_all_creatives` | Creatives | `GET /creatives` | - | limit (default 20, max 1000), offset (default 0), fields | orgId | offset/limit query params (default 20, max 1000); response pagination {totalResults,startIndex,itemsPerPage} | CreativeListResponse {data:[Creative], pagination} | [Get All Creatives](https://developer.apple.com/documentation/apple_ads/get-all-creatives) |
| `v5_get_product_pages` | Custom Product Pages | `GET /apps/{adamId}/product-pages` | **adamId** | name, states (HIDDEN/VISIBLE) | orgId | none | ProductPageDetailListResponse {data:[ProductPageDetail]} | [Get Product Pages](https://developer.apple.com/documentation/apple_ads/get-product-pages) |
| `v5_get_product_page` | Custom Product Pages | `GET /apps/{adamId}/product-pages/{productPageId}` | **adamId**, **productPageId** | - | orgId | none | ProductPageDetailResponse {data: ProductPageDetail} | [Get Product Pages by Identifier](https://developer.apple.com/documentation/apple_ads/get-product-pages-by-identifier) |
| `v5_get_product_page_locales` | Custom Product Pages | `GET /apps/{adamId}/product-pages/{productPageId}/locale-details` | **adamId**, **productPageId** | deviceClasses (IPAD/IPHONE), expand (default false), languageCodes, languages | orgId | none | ProductPageLocaleDetailListResponse {data:[ProductPageLocaleDetail]} | [Get Product Page Locales](https://developer.apple.com/documentation/apple_ads/get-product-page-locales) |
| `v5_get_supported_countries_or_regions` | Custom Product Pages | `GET /countries-or-regions` | - | countriesOrRegions | orgId | none | CountriesOrRegionsListResponse {data:[CountryOrRegion]} | [Get Supported Countries or Regions](https://developer.apple.com/documentation/apple_ads/get-supported-countries-or-regions) |
| `v5_get_app_preview_device_sizes` | Custom Product Pages | `GET /creativeappmappings/devices` | - | - | orgId | none | AppPreviewDevicesMappingResponse {data: {deviceKey: displayName}} | [Get App Preview Device Sizes](https://developer.apple.com/documentation/apple_ads/get-app-preview-device-sizes) |
| `v5_get_impression_share_report` | Impression Share Reports | `GET /custom-reports/{reportId}` | **reportId** | - | orgId | none | CustomReportResponseBody {data: CustomReportResponse, pagination, error} | [Get a Single Impression Share Report](https://developer.apple.com/documentation/apple_ads/get-a-single-impression-share-report) |
| `v5_get_all_impression_share_reports` | Impression Share Reports | `GET /custom-reports` | - | field (default "creationTime"), limit (default 20, max 50), offset (default 0), sortOrder (default "DESCENDING") | orgId | offset/limit (default 20, max 50) | CustomReportResponseBody {data:[CustomReportResponse], pagination, error} | [Get All Impression Share Reports](https://developer.apple.com/documentation/apple_ads/get-all-impression-share-reports) |

### Apple Ads Platform API

| MCP tool | Category | Method & path | Path params | Query params | Context | Pagination | Response | Docs |
|---|---|---|---|---|---|---|---|---|
| `platform_get_me` | Account Management | `GET /me` | - | - | none | none | MeResponse {result: {userId, orgId}} | [Get Me Details](https://developer.apple.com/documentation/apple-ads-platform-api/get-current-user-details) |
| `platform_get_user_acls` | Account Management | `GET /acls` | - | - | none | none | UserAclListResponse {result: {acls: [{adAccount, roles}]}} | [Get User ACL](https://developer.apple.com/documentation/apple-ads-platform-api/get-user-acls) |
| `platform_get_org` | Account Management | `GET /orgs/{id}` | **id** | - | none | none | OrgResponse {result: Org} | [Get Org by ID](https://developer.apple.com/documentation/apple-ads-platform-api/get-orgs-_id_) |
| `platform_get_ad_account` | Account Management | `GET /ad-accounts/{id}` | **id** | - | adAccountId | none | AdAccountResponse {result: AdAccount} | [Get Ad Account by ID](https://developer.apple.com/documentation/apple-ads-platform-api/get-ad-accounts-_id_) |
| `platform_get_advertiser_resources` | Account Management | `GET /advertiser-resources` | - | **resourceType** (CONTENT_PROVIDER/BUSINESS_BRAND) | none | none | AdvertiserResourceListResponse {result: [Delegation]} | [Get Advertiser Resources](https://developer.apple.com/documentation/apple-ads-platform-api/get-advertiser-resources) |
| `platform_search_apps` | Search Apps | `GET /search/apps` | - | query, returnOwnedApps (default false), cpids, storeFronts, offset (default 0), limit (default 20) | adAccountId | offset/limit query params (default 20); response pagination {totalCount, offset, pageSize} | AppsSearchResponse {result: [AppInfo], pagination: {totalCount, offset, pageSize}} | [Search for Apps](https://developer.apple.com/documentation/apple-ads-platform-api/searches-for-a-list-of-apps) |
| `platform_get_app_details` | Search Apps | `GET /apps/{adamId}` | **adamId** | - | adAccountId | none | AppDetailsResponse {result: AppDetails} | [Get App Details by Adam ID](https://developer.apple.com/documentation/apple-ads-platform-api/get-app-details-by-adam-id) |
| `platform_get_app_rejection_reason` | App Eligibility | `GET /rejection-reasons/apps/{rejectionReasonId}` | **rejectionReasonId** | - | adAccountId | none | RejectionReasonResponse {result: CreativeRejectionReason} | [Get Rejection Reasons](https://developer.apple.com/documentation/apple-ads-platform-api/gets-rejection-reasons-by-id) |
| `platform_get_brand` | Ads on Apple Maps | `GET /business-brands/{id}` | **id** | - | adAccountId | none | BrandResponse {result: Brand} | [Get Brand by ID](https://developer.apple.com/documentation/apple-ads-platform-api/get-brand-by-id) |
| `platform_get_business_category` | Ads on Apple Maps | `GET /business-categories/{id}` | **id** | - | adAccountId | none | BusinessCategoryResponse {result: BusinessCategory} | [Get Business Category](https://developer.apple.com/documentation/apple-ads-platform-api/get-category-by-id) |
| `platform_get_location_group` | Ads on Apple Maps | `GET /location-groups/{id}` | **id** | - | adAccountId | none | LocationGroupResponse {result: LocationGroup} | [Get Location Group](https://developer.apple.com/documentation/apple-ads-platform-api/get-location-group-by-id) |
| `platform_get_location` | Ads on Apple Maps | `GET /locations/{id}` | **id** | - | adAccountId | none | LocationResponse {result: Location} | [Get a Location](https://developer.apple.com/documentation/apple-ads-platform-api/get-location-by-id) |
| `platform_get_campaign` | Campaigns | `GET /campaigns/{id}` | **id** | - | adAccountId | none | CampaignResponse {result: Campaign} | [Get a Campaign](https://developer.apple.com/documentation/apple-ads-platform-api/get-campaigns-_id_) |
| `platform_get_campaign_legacy_app_limited_status_reasons` | Campaigns | `GET /campaigns/{id}/legacy-app-limited-status-reason-details` | **id** | - | adAccountId | none | LegacyAppLimitedStatusReasonDetailsResponse {result: {countryOrRegionLimitedStatusReasons}} | [Get Legacy App Limited Status Reason Details](https://developer.apple.com/documentation/apple-ads-platform-api/get-campaigns-_id_-legacy-app-limited-status-reason-details) |
| `platform_get_ad_group` | Ad Groups | `GET /adgroups/{id}` | **id** | - | adAccountId | none | AdGroupResponse {result: AdGroup} | [Get an Ad Group](https://developer.apple.com/documentation/apple-ads-platform-api/get-adgroups-_id_) |
| `platform_search_geo_locations` | Geo Targeting | `GET /search/geo` | - | **supplySource** (APPSTORE/MAPS), query (default "*:*"), entity (Country/AdminArea/Locality/PostalCode), countrycode (default "US"), eligible (default false), offset (default 0), pageSize (default 20) | adAccountId | offset/pageSize query params (default 20); response pagination {totalCount, offset, pageSize} | GeoSearchResponse {result: [SearchEntity], pagination: {totalCount, offset, pageSize}} | [Search Geo Locations](https://developer.apple.com/documentation/apple-ads-platform-api/searches-for-a-list-of-geo-locations) |
| `platform_get_keyword` | Keywords | `GET /keywords/{id}` | **id** | - | adAccountId | none | KeywordResponse {result: Keyword} | [Get a Keyword](https://developer.apple.com/documentation/apple-ads-platform-api/get-keywords-_id_) |
| `platform_get_negative_keyword` | Negative Keywords | `GET /negative-keywords/{id}` | **id** | - | adAccountId | none | NegativeKeywordResponse {result: NegativeKeyword} | [Get a Negative Keyword](https://developer.apple.com/documentation/apple-ads-platform-api/get-negative-keywords-_id_) |
| `platform_get_ad` | Ads | `GET /ads/{id}` | **id** | - | adAccountId | none | AdResponse {result: Ad} | [Get an Ad](https://developer.apple.com/documentation/apple-ads-platform-api/get-ads-_id_) |
| `platform_get_creative` | Creatives | `GET /creatives/{id}` | **id** | - | adAccountId | none | CreativeResponse {result: Creative} | [Get an Ad Creative](https://developer.apple.com/documentation/apple-ads-platform-api/get-creatives-_id_) |
| `platform_get_asset` | Assets | `GET /assets/{id}` | **id** | - | adAccountId | none | AssetResponse {result: Asset} | [Get Asset](https://developer.apple.com/documentation/apple-ads-platform-api/get-asset-by-id) |
| `platform_get_product_page` | Product Pages | `GET /product-pages/{productPageId}` | **productPageId** | - | adAccountId | none | ProductPageDetailsResponse {result: ProductPageDetails} | [Get Product Page by ID](https://developer.apple.com/documentation/apple-ads-platform-api/get-product-page-by-id) |
| `platform_get_budget_order` | Budget Orders | `GET /shared-budgets/{id}` | **id** | - | adAccountId | none | SharedBudgetResponse {result: SharedBudget} | [Get a Budget Order by ID](https://developer.apple.com/documentation/apple-ads-platform-api/get-shared-budgets-_id_) |
| `platform_get_change_history_detail` | Change History | `GET /change-history/{detailId}` | **detailId** | limit (default 100), offset (default 0) | adAccountId | limit/offset page through the nested changes array (single request per call) | ChangeDetailsResponse {dataType, result: [ChangeDetails], pagination} | [Get Change History Detail](https://developer.apple.com/documentation/apple-ads-platform-api/get-change-details-by-detailid) |

## Intentionally excluded (non-GET) endpoints

None of these are implemented. Read-style operations that Apple exposes only through POST (including every report) are excluded as well, because the server never sends anything but GET to the Apple Ads APIs.

### Apple Search Ads Campaign Management API (Apple Ads Campaign Management API)

| Category | Title | Method | Path | Reason |
|---|---|---|---|---|
| App Eligibility | Find App Eligibility Records | POST | `/apps/{adamId}/eligibilities/find` | Read-only query implemented by Apple as POST (/find, /query) |
| Campaigns | Create a Campaign | POST | `/campaigns` | Mutation (create / update / delete / apply / dismiss / upload) |
| Campaigns | Find Campaigns | POST | `/campaigns/find` | Read-only query implemented by Apple as POST (/find, /query) |
| Campaigns | Update a Campaign | PUT | `/campaigns/{campaignId}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Campaigns | Delete a Campaign | DELETE | `/campaigns/{campaignId}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Budget Orders | Create a Budget Order | POST | `/budgetorders` | Mutation (create / update / delete / apply / dismiss / upload) |
| Budget Orders | Update a Budget Order | PUT | `/budgetorders/{boId}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ad Groups | Create an Ad Group | POST | `/campaigns/{campaignId}/adgroups` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ad Groups | Find Ad Groups | POST | `/campaigns/{campaignId}/adgroups/find` | Read-only query implemented by Apple as POST (/find, /query) |
| Ad Groups | Find Ad Groups (org-level) | POST | `/adgroups/find` | Read-only query implemented by Apple as POST (/find, /query) |
| Ad Groups | Update an Ad Group | PUT | `/campaigns/{campaignId}/adgroups/{adgroupId}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ad Groups | Delete an Ad Group | DELETE | `/campaigns/{campaignId}/adgroups/{adgroupId}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Targeting Keywords | Create Targeting Keywords | POST | `/campaigns/{campaignId}/adgroups/{adgroupId}/targetingkeywords/bulk` | Mutation (create / update / delete / apply / dismiss / upload) |
| Targeting Keywords | Find Targeting Keywords in a Campaign | POST | `/campaigns/{campaignId}/adgroups/targetingkeywords/find` | Read-only query implemented by Apple as POST (/find, /query) |
| Targeting Keywords | Update Targeting Keywords | PUT | `/campaigns/{campaignId}/adgroups/{adgroupId}/targetingkeywords/bulk` | Mutation (create / update / delete / apply / dismiss / upload) |
| Targeting Keywords | Delete Targeting Keywords | POST | `/campaigns/{campaignId}/adgroups/{adgroupId}/targetingkeywords/delete/bulk` | Mutation (create / update / delete / apply / dismiss / upload) |
| Targeting Keywords | Delete a Targeting Keyword | DELETE | `/campaigns/{campaignId}/adgroups/{adgroupId}/targetingkeywords/{keywordId}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Campaign Negative Keywords | Create Campaign Negative Keywords | POST | `/campaigns/{campaignId}/negativekeywords/bulk` | Mutation (create / update / delete / apply / dismiss / upload) |
| Campaign Negative Keywords | Find Campaign Negative Keywords | POST | `/campaigns/{campaignId}/negativekeywords/find` | Read-only query implemented by Apple as POST (/find, /query) |
| Campaign Negative Keywords | Update Campaign Negative Keywords | PUT | `/campaigns/{campaignId}/negativekeywords/bulk` | Mutation (create / update / delete / apply / dismiss / upload) |
| Campaign Negative Keywords | Delete Campaign Negative Keywords | POST | `/campaigns/{campaignId}/negativekeywords/delete/bulk` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ad Group Negative Keywords | Create Ad Group Negative Keywords | POST | `/campaigns/{campaignId}/adgroups/{adgroupId}/negativekeywords/bulk` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ad Group Negative Keywords | Find Ad Group Negative Keywords | POST | `/campaigns/{campaignId}/adgroups/negativekeywords/find` | Read-only query implemented by Apple as POST (/find, /query) |
| Ad Group Negative Keywords | Update Ad Group Negative Keywords | PUT | `/campaigns/{campaignId}/adgroups/{adgroupId}/negativekeywords/bulk` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ad Group Negative Keywords | Delete Ad Group Negative Keywords | POST | `/campaigns/{campaignId}/adgroups/{adgroupId}/negativekeywords/delete/bulk` | Mutation (create / update / delete / apply / dismiss / upload) |
| Search Geolocations | Get a List of Geo Locations | POST | `/search/geo` | Read-only query implemented by Apple as POST (/find, /query) |
| Ads | Create an Ad | POST | `/campaigns/{campaignId}/adgroups/{adgroupId}/ads` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ads | Find Ads | POST | `/campaigns/{campaignId}/ads/find` | Read-only query implemented by Apple as POST (/find, /query) |
| Ads | Find Ads (org-level) | POST | `/ads/find` | Read-only query implemented by Apple as POST (/find, /query) |
| Ads | Update an Ad | PUT | `/campaigns/{campaignId}/adgroups/{adgroupId}/ads/{adId}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ads | Delete an Ad | DELETE | `/campaigns/{campaignId}/adgroups/{adgroupId}/ads/{adId}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ad Rejection Reasons | Find Ad Creative Rejection Reasons | POST | `/product-page-reasons/find` | Read-only query implemented by Apple as POST (/find, /query) |
| Ad Rejection Reasons | Find App Assets | POST | `/apps/{adamId}/assets/find` | Read-only query implemented by Apple as POST (/find, /query) |
| Creatives | Create a Creative | POST | `/creatives` | Mutation (create / update / delete / apply / dismiss / upload) |
| Creatives | Find Creatives | POST | `/creatives/find` | Read-only query implemented by Apple as POST (/find, /query) |
| Reports | Get Campaign-Level Reports | POST | `/reports/campaigns` | Report generation via POST |
| Reports | Get Ad Group-Level Reports | POST | `/reports/campaigns/{campaignId}/adgroups` | Report generation via POST |
| Reports | Get Keyword-Level Reports | POST | `/reports/campaigns/{campaignId}/keywords` | Report generation via POST |
| Reports | Get Keyword-Level within Ad Group Reports | POST | `/reports/campaigns/{campaignId}/adgroups/{adgroupId}/keywords` | Report generation via POST |
| Reports | Get Search Term-Level Reports | POST | `/reports/campaigns/{campaignId}/searchterms` | Report generation via POST |
| Reports | Get Search Term-Level within Ad Group Reports | POST | `/reports/campaigns/{campaignId}/adgroups/{adgroupId}/searchterms` | Report generation via POST |
| Reports | Get Ad-Level Reports | POST | `/reports/campaigns/{campaignId}/ads` | Report generation via POST |
| Impression Share Reports | Impression Share Report | POST | `/custom-reports` | Creates an asynchronous report job (POST) - Creates an asynchronous report job; existing reports are readable via GET /custom-reports and GET /custom-reports/{reportId} |

### Apple Ads Platform API

| Category | Title | Method | Path | Reason |
|---|---|---|---|---|
| Account Management | Create Ad Accounts | POST | `/ad-accounts` | Mutation (create / update / delete / apply / dismiss / upload) |
| Account Management | Update Ad Accounts | PUT | `/ad-accounts/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Search Apps | Query Supported App Languages | POST | `/metadata/apps/supported-languages/query` | Read-only query implemented by Apple as POST (/find, /query) |
| App Eligibility | Check App Eligibility | POST | `/eligibilities/apps/query` | Read-only query implemented by Apple as POST (/find, /query) |
| App Eligibility | Query Rejection Reasons | POST | `/rejection-reasons/apps/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Ads on Apple Maps | Query Brands | POST | `/business-brands/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Ads on Apple Maps | Query Business Categories | POST | `/business-categories/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Ads on Apple Maps | Query Rejection Reasons for Brands | POST | `/rejection-reasons/business-brands/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Ads on Apple Maps | Create Location Group | POST | `/location-groups` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ads on Apple Maps | Query Location Groups | POST | `/location-groups/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Ads on Apple Maps | Update Location Group | PUT | `/location-groups/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ads on Apple Maps | Delete Location Group | DELETE | `/location-groups/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ads on Apple Maps | Query for Locations | POST | `/locations/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Campaigns | Create a Campaign | POST | `/campaigns` | Mutation (create / update / delete / apply / dismiss / upload) |
| Campaigns | Query Campaigns | POST | `/campaigns/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Campaigns | Update a Campaign | PUT | `/campaigns/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Campaigns | Delete a Campaign | DELETE | `/campaigns/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ad Groups | Create an Ad Group | POST | `/adgroups` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ad Groups | Query Ad Groups | POST | `/adgroups/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Ad Groups | Update an Ad Group | PUT | `/adgroups/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ad Groups | Delete an Ad Group | DELETE | `/adgroups/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Geo Targeting | Query Geo Locations | POST | `/search/geo` | Read-only query implemented by Apple as POST (/find, /query) |
| Keywords | Create a Keyword | POST | `/keywords` | Mutation (create / update / delete / apply / dismiss / upload) |
| Keywords | Query Keywords | POST | `/keywords/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Keywords | Update a Keyword | PUT | `/keywords/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Keywords | Delete a Keyword | DELETE | `/keywords/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Negative Keywords | Create a Negative Keyword | POST | `/negative-keywords` | Mutation (create / update / delete / apply / dismiss / upload) |
| Negative Keywords | Query Negative Keywords | POST | `/negative-keywords/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Negative Keywords | Update a Negative Keyword | PUT | `/negative-keywords/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Negative Keywords | Delete a Negative Keyword | DELETE | `/negative-keywords/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ads | Create an Ad | POST | `/ads` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ads | Query Ads | POST | `/ads/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Ads | Update an Ad | PUT | `/ads/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Ads | Delete an Ad | DELETE | `/ads/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Creatives | Create an Ad Creative | POST | `/creatives` | Mutation (create / update / delete / apply / dismiss / upload) |
| Creatives | Query Ad Creatives | POST | `/creatives/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Creatives | Update an Ad Creative | PUT | `/creatives/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Creatives | Delete an Ad Creative | DELETE | `/creatives/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Assets | Upload Asset | POST | `/assets/upload` | Mutation (create / update / delete / apply / dismiss / upload) |
| Assets | Query Assets | POST | `/assets/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Assets | Delete Asset | DELETE | `/assets/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Product Pages | Query Product Pages | POST | `/product-pages/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Product Pages | Query Product Page Locale Details | POST | `/product-pages/locale-details/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Product Pages | Query App Locale Details | POST | `/apps/{adamId}/locale-details/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Bulk Operations | Bulk Create Keywords | POST | `/keywords/bulk-create` | Mutation (create / update / delete / apply / dismiss / upload) |
| Bulk Operations | Bulk Update Keywords | POST | `/keywords/bulk-update` | Mutation (create / update / delete / apply / dismiss / upload) |
| Bulk Operations | Bulk Delete Keywords | POST | `/keywords/bulk-delete` | Mutation (create / update / delete / apply / dismiss / upload) |
| Bulk Operations | Bulk Create Negative Keywords | POST | `/negative-keywords/bulk-create` | Mutation (create / update / delete / apply / dismiss / upload) |
| Bulk Operations | Bulk Update Negative Keywords | POST | `/negative-keywords/bulk-update` | Mutation (create / update / delete / apply / dismiss / upload) |
| Bulk Operations | Bulk Delete Negative Keywords | POST | `/negative-keywords/bulk-delete` | Mutation (create / update / delete / apply / dismiss / upload) |
| Budget Orders | Create a Budget Order | POST | `/shared-budgets` | Mutation (create / update / delete / apply / dismiss / upload) |
| Budget Orders | Query Budget Orders | POST | `/shared-budgets/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Budget Orders | Update a Budget Order | PUT | `/shared-budgets/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Budget Orders | Delete a Budget Order | DELETE | `/shared-budgets/{id}` | Mutation (create / update / delete / apply / dismiss / upload) |
| Reports | Campaigns Report (App Store) | POST | `/reports/apps/campaigns/query` | Report generation via POST |
| Reports | Ad Groups Report (App Store) | POST | `/reports/apps/adgroups/query` | Report generation via POST |
| Reports | Ads Report (App Store) | POST | `/reports/apps/ads/query` | Report generation via POST |
| Reports | Keywords Report (App Store) | POST | `/reports/apps/keywords/query` | Report generation via POST |
| Reports | Search Terms Report (App Store) | POST | `/reports/apps/searchterms/query` | Report generation via POST |
| Reports | Campaigns Report (Brands) | POST | `/reports/business-brands/campaigns/query` | Report generation via POST |
| Reports | Ad Groups Report (Brands) | POST | `/reports/business-brands/adgroups/query` | Report generation via POST |
| Reports | Ads Report (Brands) | POST | `/reports/business-brands/ads/query` | Report generation via POST |
| Reports | Keywords Report (Brands) | POST | `/reports/business-brands/keywords/query` | Report generation via POST |
| Reports | Search Terms Report (Brands) | POST | `/reports/business-brands/searchterms/query` | Report generation via POST |
| Insights | Impression Share Query | POST | `/insights/apps/impression-share/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Insights | Search Term Popularity Query | POST | `/insights/apps/search-term-popularity/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Recommendations | Query Daily Budget Recommendations | POST | `/recommendations/daily-budgets/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Recommendations | Apply Daily Budget Recommendations | POST | `/recommendations/daily-budgets/apply` | Mutation (create / update / delete / apply / dismiss / upload) |
| Recommendations | Dismiss Daily Budget Recommendations | POST | `/recommendations/daily-budgets/dismiss` | Mutation (create / update / delete / apply / dismiss / upload) |
| Recommendations | Query Target CPA Recommendations | POST | `/recommendations/target-cpas/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Recommendations | Apply Target CPA Recommendations | POST | `/recommendations/target-cpas/apply` | Mutation (create / update / delete / apply / dismiss / upload) |
| Recommendations | Dismiss Target CPA Recommendations | POST | `/recommendations/target-cpas/dismiss` | Mutation (create / update / delete / apply / dismiss / upload) |
| Suggestions | Query Keyword Suggestions | POST | `/suggestions/keywords/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Suggestions | Query Phrase Suggestions | POST | `/suggestions/phrases/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Suggestions | Query Category Suggestions | POST | `/suggestions/categories/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Suggestions | Query Target CPA Suggestion | POST | `/suggestions/target-cpas/query` | Read-only query implemented by Apple as POST (/find, /query) |
| Change History | Query Change History | POST | `/change-history/query` | Read-only query implemented by Apple as POST (/find, /query) |

## Not implementable

- **Creative Sets endpoints** (campaign-management-v5): Deprecated and unavailable in API 5 (changelog 5.0); no endpoint paths are documented, so nothing can be implemented.
