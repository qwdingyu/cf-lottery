import { existsSync, readdirSync, readFileSync } from "node:fs";

/*
 * cf-shop 本地结构检查脚本。
 *
 * 用途：
 * - 快速确认项目关键文件存在。
 * - 检查 wrangler.jsonc 是否绑定 Static Assets。
 * - 检查 Static Assets 是否全量 Worker-first，避免 /admin 被静态层重定向到用户首页。
 * - 检查 Worker 是否保留发卡所需的核心 API 和 SQLite/libSQL 原子写入边界。
 * - 检查 migration 是否创建 products/cards/orders/order_items 等核心表。
 *
 * 必填环境变量：
 * - 无。
 *
 * 可选环境变量：
 * - 无。
 *
 * 常用命令：
 * - 在 cf-shop 项目根目录执行：
 *   npm run check
 *
 * 使用边界：
 * - 这是静态结构检查，不替代 wrangler dev、远程 verify 或 smoke。
 * - 它不会访问 Cloudflare，不会读写 libSQL，不会消耗库存。
 */

const requiredFiles = [
  "wrangler.jsonc",
  "src/index.ts",
  "src/routes/orders.ts",
  "src/routes/pay.ts",
  "src/routes/recharge.ts",
  "src/routes/email-access.ts",
  "src/routes/media.ts",
  "src/routes/admin.ts",
  "src/routes/admin-vouchers.ts",
  "src/services/order-service.ts",
  "src/services/order-service.real-db.test.ts",
  "src/services/recharge-service.ts",
  "src/services/recharge-service.real-db.test.ts",
  "src/services/admin-service.real-db.test.ts",
  "src/services/email-service.ts",
  "src/services/templates/order_issued.ts",
  "src/services/templates/lottery_winner.ts",
  "src/services/issue-service.ts",
  "src/services/admin-service.ts",
  "src/lib/idempotency.ts",
  "src/lib/rate-limit.ts",
  "src/lib/email-access.ts",
  "src/lib/product-id.ts",
  "src/lib/media-image.ts",
  "src/lib/api-body-limit.ts",
  "src/lib/system-config-definitions.json",
  "src/lib/system-config-registry.ts",
  "src/services/fulfillment-service.ts",
  "src/services/payments/catalog.ts",
  "public/_app/index.html",
  "package-lock.json",
  "frontend/package.json",
  "frontend/src/App.vue",
  "frontend/src/api/index.ts",
  "frontend/src/api/admin.ts",
  "frontend/src/views/AdminLoginView.vue",
  "frontend/src/views/admin/AdminProductsView.vue",
  "frontend/src/views/admin/AdminCardsView.vue",
  "frontend/src/views/admin/AdminCouponsView.vue",
  "frontend/src/views/admin/AdminOrdersView.vue",
  "frontend/src/views/admin/AdminLogsView.vue",
  "frontend/src/views/admin/AdminEmailLogsView.vue",
  "frontend/src/views/admin/AdminBalanceView.vue",
  "frontend/src/views/admin/AdminVouchersView.vue",
  "frontend/src/views/admin/AdminRechargesView.vue",
  "frontend/src/views/admin/AdminStorefrontsView.vue",
  "frontend/src/views/ShopView.vue",
  "frontend/src/composables/useTableSelection.ts",
  "frontend/src/composables/useAdminBatchOperation.ts",
  "frontend/src/composables/useConfirmDialog.ts",
  "frontend/src/lib/csv-export.ts",
  "frontend/src/composables/useShopConfig.ts",
  "frontend/src/composables/useCheckoutFlow.ts",
  "frontend/src/composables/usePayment.ts",
  "frontend/src/composables/useOfflinePayment.ts",
  "frontend/src/lib/storefront-stock.ts",
  "frontend/src/components/AdminModal.vue",
  "frontend/src/components/HeaderBar.vue",
  "frontend/src/components/PayModal.vue",
  "frontend/src/components/RechargeModal.vue",
  "docs/000_文档索引_2026-07-14.md",
  "docs/028_易支付回调地址配置说明_2026-07-14.md",
  "docs/029_开发规范与文档治理准则_2026-07-14.md",
  "docs/030_邮箱限领卡密活动产品评审_2026-07-14.md",
  "docs/036_多店铺展示渠道轻量规划与架构边界_2026-07-19.md",
  "docs/038_公开仓库变量部署与管理令牌故障复盘_2026-07-19.md",
  "docs/039_SPA部署后旧Chunk404与充值交互故障复盘_2026-07-20.md",
  "docs/040_展示渠道模板与商品图片托管决策_2026-07-20.md",
  "scripts/26-smoke-frontend-assets.mjs",
  "scripts/frontend-assets-smoke.test.mjs",
  "scripts/13-apply-turso-migrations.sh",
  "scripts/install-dependencies.mjs",
  "scripts/resolve-local-chromium.mjs",
  "scripts/migrate.mjs",
  "scripts/sync-turso-backup.mjs",
  "scripts/16-verify-launch.mjs",
  "scripts/23-verify-light-architecture.mjs",
  "scripts/24-verify-lightweight-principles.mjs",
  "migrations/0001_init.sql",
  "migrations/0004_order_delivery_visibility.sql",
  "migrations/0005_operational_retention_indexes.sql",
  "migrations/0006_idempotency_request_binding.sql",
  "migrations/0007_log_cursor_indexes.sql",
  "migrations/0008_product_stock_visibility.sql",
  "migrations/0009_balance_recharge_orders.sql",
  "migrations/0012_storefront_templates.sql",
 ];

for (const file of requiredFiles) {
  readFileSync(file, "utf8");
}

const wrangler = readFileSync("wrangler.jsonc", "utf8");
const worker = readFileSync("src/index.ts", "utf8");
const ordersRoute = readFileSync("src/routes/orders.ts", "utf8");
const payRoute = readFileSync("src/routes/pay.ts", "utf8");
const rechargeRoute = readFileSync("src/routes/recharge.ts", "utf8");
const payTest = readFileSync("src/routes/pay.test.ts", "utf8");
const emailAccessRoute = readFileSync("src/routes/email-access.ts", "utf8");
const mediaRoute = readFileSync("src/routes/media.ts", "utf8");
const mediaImage = readFileSync("src/lib/media-image.ts", "utf8");
const apiBodyLimit = readFileSync("src/lib/api-body-limit.ts", "utf8");
const emailAccess = readFileSync("src/lib/email-access.ts", "utf8");
const voucherRoute = readFileSync("src/routes/vouchers.ts", "utf8");
const telegramBot = readFileSync("src/telegram-bot/index.ts", "utf8");
const adminRoute = readFileSync("src/routes/admin.ts", "utf8");
const productId = readFileSync("src/lib/product-id.ts", "utf8");
const adminVoucherRoute = readFileSync("src/routes/admin-vouchers.ts", "utf8");
const adminPaymentRoute = readFileSync("src/routes/admin-payment.ts", "utf8");
const orderService = readFileSync("src/services/order-service.ts", "utf8");
const orderServiceRealDbTest = readFileSync("src/services/order-service.real-db.test.ts", "utf8");
const adminServiceRealDbTest = readFileSync("src/services/admin-service.real-db.test.ts", "utf8");
const emailService = readFileSync("src/services/email-service.ts", "utf8");
const orderIssuedTemplate = readFileSync("src/services/templates/order_issued.ts", "utf8");
const lotteryWinnerTemplate = readFileSync("src/services/templates/lottery_winner.ts", "utf8");
const lotteryServiceSource = readFileSync("src/services/lottery-service.ts", "utf8");
const issueService = readFileSync("src/services/issue-service.ts", "utf8");
/*
 * Admin 服务层按域拆分到 src/services/admin/*.ts，admin-service.ts 保留为 barrel 再导出。
 * 门禁关心的是「服务层整体是否具备某项能力」，而不是它恰好落在哪个文件里，
 * 因此读取整层的聚合内容 —— 后续继续按域抽取模块时，这里的断言无需任何改动。
 */
function readAdminServiceLayer() {
  const parts = [readFileSync("src/services/admin-service.ts", "utf8")];
  const dir = "src/services/admin";
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith(".ts") && !name.endsWith(".test.ts")) parts.push(readFileSync(`${dir}/${name}`, "utf8"));
    }
  }
  return parts.join("\n");
}

const adminService = readAdminServiceLayer();
const deployFull = readFileSync("scripts/02-deploy-full.mjs", "utf8");
const security = readFileSync("src/lib/security.ts", "utf8");
const systemConfigDefinitions = readFileSync("src/lib/system-config-definitions.json", "utf8");
const systemConfigRegistry = readFileSync("src/lib/system-config-registry.ts", "utf8");
const fulfillmentService = readFileSync("src/services/fulfillment-service.ts", "utf8");
const paymentCatalog = readFileSync("src/services/payments/catalog.ts", "utf8");
const smokeHttpClient = readFileSync("scripts/http-client.mjs", "utf8");
const readonlySmoke = readFileSync("scripts/04-smoke-readonly.mjs", "utf8");
const writeSmoke = readFileSync("scripts/06-smoke-write.mjs", "utf8");
const launchVerify = readFileSync("scripts/16-verify-launch.mjs", "utf8");
const architectureVerify = readFileSync("scripts/23-verify-light-architecture.mjs", "utf8");
const lightweightVerify = readFileSync("scripts/24-verify-lightweight-principles.mjs", "utf8");
const opsMaintenance = readFileSync("scripts/12-ops-maintenance.sh", "utf8");
const migrationWrapper = readFileSync("scripts/13-apply-turso-migrations.sh", "utf8");
const migrationRunner = readFileSync("scripts/migrate.mjs", "utf8");
const dependencyInstaller = readFileSync("scripts/install-dependencies.mjs", "utf8");
const localChromiumResolver = readFileSync("scripts/resolve-local-chromium.mjs", "utf8");
const migration001 = readFileSync("migrations/0001_init.sql", "utf8");
const migration003 = readFileSync("migrations/0003_delivery_visibility.sql", "utf8");
const migration004 = readFileSync("migrations/0004_order_delivery_visibility.sql", "utf8");
const migration008 = readFileSync("migrations/0008_product_stock_visibility.sql", "utf8");
const migration009 = readFileSync("migrations/0009_balance_recharge_orders.sql", "utf8");
const migration012 = readFileSync("migrations/0012_storefront_templates.sql", "utf8");
const cleanupBusinessData = readFileSync("scripts/22-cleanup-business-data.sh", "utf8");
const apiClient = readFileSync("frontend/src/api/index.ts", "utf8");
const adminApiClient = readFileSync("frontend/src/api/admin.ts", "utf8");
const adminLoginView = readFileSync("frontend/src/views/AdminLoginView.vue", "utf8");
const adminProductsView = readFileSync("frontend/src/views/admin/AdminProductsView.vue", "utf8");
const orderView = readFileSync("frontend/src/views/OrderView.vue", "utf8");
const lookupView = readFileSync("frontend/src/views/LookupView.vue", "utf8");
const adminCardsViewSource = readFileSync("frontend/src/views/admin/AdminCardsView.vue", "utf8");
const adminCouponsView = readFileSync("frontend/src/views/admin/AdminCouponsView.vue", "utf8");
const adminOrdersView = readFileSync("frontend/src/views/admin/AdminOrdersView.vue", "utf8");
const adminLogsView = readFileSync("frontend/src/views/admin/AdminLogsView.vue", "utf8");
const adminEmailLogsView = readFileSync("frontend/src/views/admin/AdminEmailLogsView.vue", "utf8");
const adminBalanceView = readFileSync("frontend/src/views/admin/AdminBalanceView.vue", "utf8");
const adminDashboardView = readFileSync("frontend/src/views/admin/AdminDashboardView.vue", "utf8");
const adminSystemConfigView = readFileSync("frontend/src/views/admin/AdminSystemConfigView.vue", "utf8");
const adminPaymentView = readFileSync("frontend/src/views/admin/AdminPaymentView.vue", "utf8");
const adminStorefrontsView = readFileSync("frontend/src/views/admin/AdminStorefrontsView.vue", "utf8");
const shopView = readFileSync("frontend/src/views/ShopView.vue", "utf8");
const productCard = readFileSync("frontend/src/components/ProductCard.vue", "utf8");
const configField = readFileSync("frontend/src/components/admin/ConfigField.vue", "utf8");
const tableSelection = readFileSync("frontend/src/composables/useTableSelection.ts", "utf8");
const adminBatchOperation = readFileSync("frontend/src/composables/useAdminBatchOperation.ts", "utf8");
const confirmDialogComposable = readFileSync("frontend/src/composables/useConfirmDialog.ts", "utf8");
const csvExport = readFileSync("frontend/src/lib/csv-export.ts", "utf8");
const shopConfig = readFileSync("frontend/src/composables/useShopConfig.ts", "utf8");
const checkoutFlow = readFileSync("frontend/src/composables/useCheckoutFlow.ts", "utf8");
const paymentComposable = readFileSync("frontend/src/composables/usePayment.ts", "utf8");
const offlinePayment = readFileSync("frontend/src/composables/useOfflinePayment.ts", "utf8");
const storefrontStock = readFileSync("frontend/src/lib/storefront-stock.ts", "utf8");
const adminModal = readFileSync("frontend/src/components/AdminModal.vue", "utf8");
const headerBar = readFileSync("frontend/src/components/HeaderBar.vue", "utf8");
const lotteryView = readFileSync("frontend/src/views/LotteryView.vue", "utf8");
const payModal = readFileSync("frontend/src/components/PayModal.vue", "utf8");
const deliveryInfo = readFileSync("frontend/src/components/DeliveryInfo.vue", "utf8");
const appVue = readFileSync("frontend/src/App.vue", "utf8");
const frontendEntry = readFileSync("frontend/src/main.ts", "utf8");
const vueEntry = readFileSync("public/_app/index.html", "utf8");
const appVueSource = readFileSync("frontend/src/App.vue", "utf8");
const adminLayout = readFileSync("frontend/src/views/AdminLayout.vue", "utf8");
const frontendPackageJson = readFileSync("frontend/package.json", "utf8");
const packageJson = readFileSync("package.json", "utf8");
const readme = readFileSync("README.md", "utf8");
const docsReadme = readFileSync("docs/000_文档索引_2026-07-14.md", "utf8");
const architectureOverviewDoc = readFileSync("docs/016_系统架构与业务全景图_2026-06-27.md", "utf8");
const easyPayCallbackDoc = readFileSync("docs/028_易支付回调地址配置说明_2026-07-14.md", "utf8");
const devGovernanceDoc = readFileSync("docs/029_开发规范与文档治理准则_2026-07-14.md", "utf8");
const emailOnlyCampaignDoc = readFileSync("docs/030_邮箱限领卡密活动产品评审_2026-07-14.md", "utf8");
const multiStorefrontPlanDoc = readFileSync("docs/036_多店铺展示渠道轻量规划与架构边界_2026-07-19.md", "utf8");
const deploymentTokenDoc = readFileSync("docs/038_公开仓库变量部署与管理令牌故障复盘_2026-07-19.md", "utf8");
const staleAssetDoc = readFileSync("docs/039_SPA部署后旧Chunk404与充值交互故障复盘_2026-07-20.md", "utf8");
const storefrontTemplateDoc = readFileSync("docs/040_展示渠道模板与商品图片托管决策_2026-07-20.md", "utf8");
const frontendAssetSmoke = readFileSync("scripts/26-smoke-frontend-assets.mjs", "utf8");
const backupWorkflow = readFileSync(".github/workflows/backup-daily.yml", "utf8");
const backupSync = readFileSync("scripts/sync-turso-backup.mjs", "utf8");
const gitignore = readFileSync(".gitignore", "utf8");

const systemConfigDefinitionsList = JSON.parse(systemConfigDefinitions);
const systemConfigKeys = systemConfigDefinitionsList.map((definition) => definition.key);
const invalidDocsNames = readdirSync("docs")
  .filter((name) => name.endsWith(".md"))
  .filter((name) => !/^\d{3}_[^\s]+_\d{4}-\d{2}-\d{2}\.md$/.test(name));
const missingSeedKeys = deployFull.includes("buildSystemConfigSeedSql")
  ? []
  : systemConfigKeys.filter((key) => !deployFull.includes(`'${key}'`));

const checks = [
  [wrangler.includes('"binding": "ASSETS"'), "wrangler.jsonc must bind Static Assets as ASSETS"],
  [wrangler.includes('"binding": "PRODUCT_MEDIA"') && wrangler.includes('"bucket_name": "cf-shop-public-media"'), "wrangler.jsonc must bind the lightweight public media R2 bucket"],
  [wrangler.includes('"run_worker_first": true'), "wrangler.jsonc must route all assets requests through Worker first"],
  [wrangler.includes('"main": "src/index.ts"'), "wrangler.jsonc must use TypeScript Worker entry"],
  [worker.includes("Hono") && worker.includes("requireAdmin") && worker.includes('response.ok && url.pathname.startsWith("/_app/assets/")'), "Worker must use Hono/admin auth and must not long-cache missing frontend assets"],
  [worker.includes("getApiBodyLimitBytes") && apiBodyLimit.includes('MEDIA_UPLOAD_PATH = "/admin/media/images"') && mediaRoute.includes('adminMediaRoute.post("/images"') && mediaRoute.includes('mediaRoute.get("/media/images/:filename"') && mediaImage.includes("detectMediaImage"), "R2 media upload must keep its narrow body limit, authenticated write route, constrained read route, and signature validation"],
  [worker.includes("getDb") || worker.includes("database"), "Worker must initialize database (Turso/D1)"],
  [worker.includes('url.pathname.startsWith("/admin/")') && worker.includes('"/_app/index.html"') && !worker.includes('url.pathname = "/admin.html"') && !worker.includes('url.pathname = "/index.html"'), "Worker must serve Vue SPA for user and admin routes without old HTML fallbacks"],
  [ordersRoute.includes("LEGACY_ORDER_DISABLED") && ordersRoute.includes("/api/pay/unified"), "Orders route must reject legacy order creation and direct clients to unified payment"],
  [!ordersRoute.includes("getOrderByCouponCode") && !/query\(\s*["']code["']\s*\)/.test(ordersRoute), "Public order lookup must not use coupon codes as delivery credentials"],
  [productId.includes("PRODUCT_ID_PATTERN") && adminRoute.includes("productIdSchema") && ordersRoute.includes("productIdSchema") && payRoute.includes("productIdSchema") && !/productId:\s*z\.string\(\)\.regex\(\s*\/\^\[a-z0-9_-\]\{2,80\}\$\/\s*\)/.test(`${adminRoute}\n${ordersRoute}\n${payRoute}`), "Core routes must share productIdSchema so legacy Chinese product IDs do not break cards, coupons, quotes, or payments"],
  [adminRoute.includes("/cards/import") && adminRoute.includes("mark-paid"), "Admin route must expose card import and manual issue APIs"],
  [adminRoute.includes("adminVoucherRoute") && adminVoucherRoute.includes("/balance-transactions") && adminVoucherRoute.includes("listBalanceTransactions"), "Admin voucher route must expose balance transaction ledger query"],
  [issueService.includes("issueAvailableCard") || issueService.includes("update(cards)"), "Issue service must issue cards with Drizzle ORM or raw SQL"],
  [orderService.includes("付费商品不能使用直接发卡模式"), "Order service must block paid direct-issue orders"],
  [orderService.includes("issue_failed") && !orderService.includes("status: \"pending\", paidAt: null"), "Order service must keep paid orders paid when issue fails"],
  [payRoute.includes("refundBalance") && payRoute.includes("balance_refunded"), "Balance payment must refund balance when issuing fails"],
  [payRoute.includes("offlineHint") && payRoute.includes("getOrderExpireMinutes") && payRoute.includes("readSystemConfigMap"), "Payment route must consume registered offline hint and order expiry system configs"],
  [payRoute.includes("lockFulfillmentInventory") && orderService.includes("fulfillCardInventory") && orderService.includes("lockFulfillmentInventory") && fulfillmentService.includes("FulfillmentResult"), "Payment and order services must use the fulfillment boundary for inventory lock and delivery"],
  [fulfillmentService.includes("issueAvailableCard") && fulfillmentService.includes("lockCardForOrder") && fulfillmentService.includes("rollbackFulfilledInventory"), "Fulfillment service must wrap existing card inventory operations without introducing a premature plugin framework"],
  [payRoute.includes("isValidProviderName") && !payRoute.includes("VALID_PROVIDER_NAMES"), "Payment callback must validate provider names through payment catalog"],
  [payRoute.includes("callback_issue_failed") && payRoute.includes("markPaidAndIssue"), "Payment callback must route paid fulfillment through markPaidAndIssue"],
  [adminVoucherRoute.includes("/vouchers/generate") && adminVoucherRoute.includes("generateVoucherCodes"), "Admin voucher route must expose voucher generation APIs"],
  [adminService.includes("导入数据包含重复卡密") && adminService.includes("已有 ${existingCards.length} 张相同卡密"), "Admin card import must reject duplicate secrets"],
  [adminService.includes("releaseLockedCardByOrder"), "Admin order cancel must release cards by locked_order_id"],
  [offlinePayment.includes("微信/支付宝账单详情") && offlinePayment.includes("交易单号或商户单号") && systemConfigDefinitions.includes("微信/支付宝账单详情"), "Offline payment hint must clearly explain which external payment reference last 4 digits to submit"],
  [packageJson.includes('"workspaces"') && packageJson.includes('"frontend"'), "cf-shop must declare npm workspaces for the Vue frontend"],
  [packageJson.includes('"browser:chromium-path"') && packageJson.includes('"deps:install"') && packageJson.includes('"deps:ci"') && dependencyInstaller.includes('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"') && localChromiumResolver.includes("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH") && localChromiumResolver.includes("ms-playwright") && !localChromiumResolver.includes("playwright install"), "Browser QA and dependency installation must reuse an existing Chromium and must not trigger Playwright browser downloads"],
  [frontendPackageJson.includes('"@vitejs/plugin-vue"') && frontendPackageJson.includes('"vue-tsc"'), "Frontend package must declare Vue Vite build dependencies"],
  [existsSync("package-lock.json"), "Root npm package-lock.json must exist for reproducible GitHub Actions installs"],
  [vueEntry.includes("/_app/assets/"), "Built Vue frontend must be synced to public/_app before deploy"],
  [appVueSource.includes("isAdminRoute") && appVueSource.includes("<HeaderBar v-if=\"!isAdminRoute\"") && appVueSource.includes("<PayModal v-if=\"!isAdminRoute\""), "Vue admin routes must not render storefront header/footer/payment modal"],
  [adminApiClient.includes("handleUnauthorized") && adminApiClient.includes("localStorage.removeItem('admin_token')") && adminApiClient.includes("redirect="), "Admin API client must clear expired tokens and redirect back to login with return path"],
  [adminLoginView.includes("redirectAfterLogin") && adminLoginView.includes("autofocus"), "Admin login must return to the intended admin page and focus the token field"],
  [adminProductsView.includes("saving") && adminProductsView.includes("deletingId") && adminProductsView.includes("adminProducts.saving") && adminProductsView.includes("adminProducts.deleting"), "Admin product CRUD must prevent duplicate save/delete clicks and show in-progress labels"],
  [adminCardsViewSource.includes("importing") && adminCardsViewSource.includes("generating") && adminCardsViewSource.includes("downloadingTemplate") && adminCardsViewSource.includes("updatingId") && adminCardsViewSource.includes("adminCards.importing") && adminCardsViewSource.includes("adminCards.generating"), "Admin card CRUD must prevent duplicate import/generate/status/template actions and show in-progress labels"],
  [adminCouponsView.includes("saving") && adminCouponsView.includes("generating") && adminCouponsView.includes("deletingCode") && adminCouponsView.includes("adminCoupons.saving") && adminCouponsView.includes("adminCoupons.actionDeleting"), "Admin coupon CRUD must prevent duplicate save/generate/delete clicks and show in-progress labels"],
  [adminOrdersView.includes("markingPaidId") && adminOrdersView.includes("cancelingId") && adminOrdersView.includes("resendingEmailId") && adminOrdersView.includes("savingCompensation") && adminOrdersView.includes("adminOrders.actionMarkingPaid") && adminOrdersView.includes("adminOrders.actionCanceling") && adminOrdersView.includes("adminOrders.detailResendingEmail") && adminOrdersView.includes("adminOrders.submitting"), "Admin order actions must prevent duplicate payment/cancel/email/compensation clicks and show in-progress labels"],
  [tableSelection.includes("useTableSelection") && tableSelection.includes("toggleAllVisible") && tableSelection.includes("partiallySelected"), "Admin tables must share selection logic through useTableSelection"],
  [adminBatchOperation.includes("useAdminBatchOperation") && adminBatchOperation.includes("runSequential") && adminBatchOperation.includes("operating"), "Admin batch actions must share sequential execution state through useAdminBatchOperation"],
  [confirmDialogComposable.includes("useConfirmDialog") && confirmDialogComposable.includes("askConfirm") && confirmDialogComposable.includes("confirmVisible"), "Admin destructive confirms must share useConfirmDialog instead of duplicating callback state"],
  [csvExport.includes("downloadCsv") && csvExport.includes("safeCsvCell") && csvExport.includes("^[=+\\-@\\t\\n]"), "Admin CSV exports must share formula-injection-safe csv-export helper"],
  [adminProductsView.includes("useTableSelection") && adminProductsView.includes("batchRemove") && adminProductsView.includes("adminProducts.bulkSelected"), "Admin products table must support shared multi-select batch delete"],
  [adminProductsView.includes("item.deliveryVisibility === 'email_only'") && adminProductsView.includes("adminProducts.deliveryEmailOnly"), "Admin products must expose generic email-only delivery visibility without an industry-specific campaign module"],
  [orderService.includes("deliveryVisibilityPayload") && orderService.includes("email_only") && orderService.includes("deliveryVisibility: orders.deliveryVisibility") && orderService.includes('input.status !== "issued"') && orderService.includes("邮件可能延迟") && orderService.includes("API 与 Web 页面均不返回 delivery/cards"), "Order service must enforce email-only redaction, only show delivery state after issued, and avoid claiming synchronous email delivery"],
  [payRoute.includes("deliveryVisibilityPayload") && payRoute.includes("deliveryVisibility: orders.deliveryVisibility") && payRoute.includes("deliveryVisibility: product.deliveryVisibility") && payRoute.includes("orderFulfillmentModeSnapshot") && payRoute.includes("if (!emailOnly && delivery) responseBody.delivery"), "Pay routes must return immutable order delivery and fulfillment snapshots, including balance-payment responses"],
  [apiClient.includes("fulfillmentMode?: string") && payModal.includes("orderState?.fulfillmentMode || product.fulfillmentMode") && orderView.includes("order.value?.fulfillmentMode") && lookupView.includes("order.fulfillmentMode"), "Frontend payment and order views must consume the order fulfillment snapshot before falling back to current product state"],
  [adminServiceRealDbTest.includes("real libSQL order snapshots") && adminServiceRealDbTest.includes("getOrderList") && adminServiceRealDbTest.includes("exportOrders") && adminServiceRealDbTest.includes("getOrderDetail"), "Admin fulfillment snapshots must have a real libSQL regression covering list, export, and detail"],
  [emailService.includes("buildIssuedDeliveryTemplateData") && orderIssuedTemplate.includes("additionalDeliveries") && orderService.includes("buildIssuedDeliveryTemplateData(fulfillment.cards)") && adminService.includes("eq(cards.issuedOrderId, orderId)") && adminService.includes("buildIssuedDeliveryTemplateData(deliverableCards)"), "Issued-order email and admin resend must include every card in quantity orders"],
  [emailService.includes("lottery_winner") && emailService.includes("buildLotteryWinnerTemplateData") && lotteryWinnerTemplate.includes("drawName") && lotteryWinnerTemplate.includes("恭喜中奖") && lotteryServiceSource.includes('template: "lottery_winner"') && !lotteryServiceSource.includes('template: "order_issued"'), "Lottery winner email must use lottery_winner template, not order_issued purchase copy"],
  [headerBar.includes('to="/lottery"') && headerBar.includes("$t('nav.lottery')") && lotteryView.includes("my-records") && lotteryView.includes("myEntryList") && lotteryView.includes("myWonById") && lotteryView.includes("path: '/order'") && !lotteryView.includes("'/#/order") && !lotteryView.includes('"/#/order'), "Storefront lottery UX must expose nav entry, my-records, and history-mode order links"],
  [adminCardsViewSource.includes("useTableSelection") && adminCardsViewSource.includes("batchSetStatus") && adminCardsViewSource.includes("adminCards.batchEnable") && adminCardsViewSource.includes("adminCards.batchDisable"), "Admin cards table must support shared multi-select batch enable/disable"],
  [adminCouponsView.includes("useTableSelection") && adminCouponsView.includes("useAdminBatchOperation") && adminCouponsView.includes("batchSetActive") && adminCouponsView.includes("batchRemove") && adminCouponsView.includes("adminCoupons.selectedCount"), "Admin coupons table must support shared multi-select batch enable/disable/delete"],
  [adminOrdersView.includes("useTableSelection") && adminOrdersView.includes("useAdminBatchOperation") && adminOrdersView.includes("exportSelectedCsv") && adminOrdersView.includes("batchResendEmail") && adminOrdersView.includes("batchCancelPending") && adminOrdersView.includes("selectedCancelableOrders"), "Admin orders table must support selected export, batch resend, and pending-only batch cancel"],
  [adminLogsView.includes("useTableSelection") && adminLogsView.includes("copySelectedLogs") && adminLogsView.includes("exportSelectedLogs") && adminLogsView.includes("adminLogs.selectedCount"), "Admin logs table must support read-only selected copy/export actions"],
  [adminBalanceView.includes("useTableSelection") && adminBalanceView.includes("copySelectedTransactions") && adminBalanceView.includes("exportSelectedTransactions") && adminBalanceView.includes("adminBalance.ledgerSelected"), "Admin balance table must support read-only selected copy/export actions"],
  [configField.includes("adminConfigField.saving") && configField.includes("adminConfig.saved") && configField.includes("adminConfig.saveFailed") && adminSystemConfigView.includes("fieldStatus") && adminSystemConfigView.includes("fieldStatus[key] = 'saving'"), "Admin system config fields must show per-field saving/saved/error feedback"],
  [adminPaymentView.includes("savingProvider") && adminPaymentView.includes("togglingProvider") && adminPaymentView.includes("deletingProvider") && adminPaymentView.includes("adminPayment.statusSaving") && adminPaymentView.includes("adminPayment.statusProcessing") && adminPaymentView.includes("adminPayment.statusDeleting"), "Admin payment provider actions must show independent save/toggle/delete progress"],
  [adminApiClient.includes("fetchAdminPaymentHealth") && adminPaymentView.includes("paymentHealth") && adminPaymentView.includes("CREDENTIALS_ENCRYPTION_KEY") && adminPaymentView.includes("paymentHealthTitle"), "Admin payment view must surface credentials encryption key health before launch"],
  [payModal.includes("hasOfflineQr") && payModal.includes("checkout.offlineWarning") && payModal.includes(":disabled=\"!hasOfflineQr || confirming || refLast4.length !== 4\""), "Offline payment confirmation must be disabled when no collection QR code is configured"],
  [adminDashboardView.includes("adminDashboard.checklist") && adminDashboardView.includes("adminDashboard.checklistGateDesc") && adminDashboardView.includes("adminDashboard.checklistSmokeDesc") && adminDashboardView.includes("adminDashboard.checklistPayment") && adminDashboardView.includes("goToPayment"), "Admin dashboard must expose a truthful pre-launch checklist and payment/config/log shortcuts"],
  [readme.includes("POST /api/pay/unified") && readme.includes("POST /api/pay/offline/cancel") && !readme.includes("POST /api/pay/offline`"), "README public API list must reflect unified offline order creation and cancel route"],
  [readme.includes("按邮箱查单") && readme.includes("web_and_email") && readme.includes("email_only") && readme.includes("不再把订单 Token 持久化"), "README must document mailbox-scoped lookup (OTP delivery for web_and_email, email_only mail-only) and must not claim persistent browser token recovery"],
  [readme.includes("Vue 3") && (readme.includes("Vue Router") || readme.includes("SPA")) && !readme.includes("Element Plus（管理后台）"), "README frontend stack must match current lightweight Vue dependencies"],
  [docsReadme.includes("当前准则文档") && docsReadme.includes("016_系统架构与业务全景图") && docsReadme.includes("026_上线前全链路严格审查") && docsReadme.includes("历史重复编号"), "docs/000_文档索引_2026-07-14.md must index current architecture, launch, and historical duplicate-number guidance"],
  [docsReadme.includes("038_公开仓库变量部署与管理令牌故障复盘") && docsReadme.includes("039_SPA部署后旧Chunk404与充值交互故障复盘") && deploymentTokenDoc.includes("TURSO_API_TOKEN") && staleAssetDoc.includes("immutable") && staleAssetDoc.includes("methods: []"), "docs must preserve the recent deployment/token and stale-asset/recharge incident records"],
  [docsReadme.includes("040_展示渠道模板与商品图片托管决策") && storefrontTemplateDoc.includes("Cloudflare R2") && storefrontTemplateDoc.includes("不建设拖拽页面搭建器") && migration012.includes("template_key IN ('catalog', 'compact')") && adminStorefrontsView.includes('v-model="form.templateKey"') && shopView.includes(':display-mode="storefrontTemplate"') && productCard.includes("displayMode?: 'catalog' | 'compact'"), "storefront templates and image hosting must remain a controlled two-template/R2-ready design"],
  [paymentCatalog.includes("易支付接口地址") && paymentCatalog.includes("/api/pay/callback/easypay") && adminPaymentRoute.includes("hint: f.hint") && adminPaymentView.includes("field.hint"), "EasyPay admin payment config must explain that async callback URL is auto-generated"],
  [payRoute.includes("const returnUrl = `${origin}/lookup`;") && payRoute.includes("notifyUrl = `${origin}/api/pay/callback/${provider.name}`") && payTest.includes('returnUrl).toBe("https://shop.example.com/lookup")'), "Unified payment must auto-generate the provider callback and return to lookup without leaking order identifiers"],
  [easyPayCallbackDoc.includes("不需要手工填写异步回调地址") && easyPayCallbackDoc.includes("/api/pay/callback/easypay") && easyPayCallbackDoc.includes("不带安全 token"), "EasyPay callback documentation must explain automatic callback and safe return URL behavior"],
  [docsReadme.includes("029_开发规范与文档治理准则") && devGovernanceDoc.includes("每次代码变更必须提交") && devGovernanceDoc.includes("代码和文档同步") && devGovernanceDoc.includes("ORM 优先") && devGovernanceDoc.includes("踩坑记录必须包含"), "docs must preserve development governance rules for commits, documentation sync, incident records, and ORM-first changes"],
  [docsReadme.includes("030_邮箱限领卡密活动产品评审") && emailOnlyCampaignDoc.includes("不应作为默认发卡模式全面改造") && emailOnlyCampaignDoc.includes("email_only") && emailOnlyCampaignDoc.includes("后端返回策略") && emailOnlyCampaignDoc.includes("同一邮箱同一商品只能成功领取一次"), "docs must preserve the product review for email-only limited card campaigns"],
  [
    docsReadme.includes("036_多店铺展示渠道轻量规划与架构边界") &&
      architectureOverviewDoc.includes("多店铺展示渠道不是多租户") &&
      devGovernanceDoc.includes("小而美的虚拟商品瑞士军刀") &&
      devGovernanceDoc.includes("允许 storefront，不允许 tenant") &&
      multiStorefrontPlanDoc.includes("同一运营主体") &&
      multiStorefrontPlanDoc.includes("storefront_products") &&
      multiStorefrontPlanDoc.includes("orders.order_source") &&
      multiStorefrontPlanDoc.includes("orders.storefront_id") &&
      multiStorefrontPlanDoc.includes("storefront_name_snapshot") &&
      multiStorefrontPlanDoc.includes("storefront_slug_snapshot") &&
      multiStorefrontPlanDoc.includes("支付幂等请求摘要必须包含 `storefrontId`") &&
      multiStorefrontPlanDoc.includes("coupon_redeem") &&
      multiStorefrontPlanDoc.includes("Telegram") &&
      devGovernanceDoc.includes("后台不得隐式切店") &&
      multiStorefrontPlanDoc.includes("明确不做") &&
      multiStorefrontPlanDoc.includes("升级为 SaaS 的决策闸门") &&
      multiStorefrontPlanDoc.includes("缺少任一条件，结论仍是多店铺展示渠道，不做 SaaS"),
    "multi-storefront planning must remain a same-operator display-channel capability with an explicit SaaS prohibition and decision gate",
  ],
  [invalidDocsNames.length === 0, `docs markdown filenames must follow 序号_中文文件名_日期.md without spaces: ${invalidDocsNames.join(", ")}`],
  [(adminLayout.includes('to="/admin/logs"') || adminLayout.includes("to: '/admin/logs'")) && adminLayout.includes("adminLayout.menuLogs"), "Vue admin layout must expose operation logs navigation"],
  [apiClient.includes("delivery?: Delivery"), "Frontend unified payment type must include balance-payment delivery payload"],
  [apiClient.includes("request<{ order?: Order }>") && apiClient.includes("const rows = d.order ? [d.order] : []") && apiClient.includes("priceCents: order.priceCents ?? order.amountCents"), "Frontend lookup API must preserve the single-order token response contract"],
  [deployFull.includes('databaseProvider: process.env.DATABASE_PROVIDER || "turso"'), "deploy:full must default to Turso/libSQL, matching runtime database.ts"],
  [deployFull.includes("TURSO_URL") && deployFull.includes("TURSO_TOKEN") && deployFull.includes("--secrets-file"), "deploy:full must upload Turso secrets during Worker deploy"],
  [packageJson.includes('"frontend:build": "npm --workspace frontend run build') && packageJson.includes('"verify:launch": "node scripts/16-verify-launch.mjs"'), "package.json must expose npm frontend build and verify:launch gates"],
  [packageJson.includes('"verify:whitespace": "git diff --check"') && packageJson.includes("npm run verify:whitespace"), "verify:delivery must include git diff --check so release candidates cannot carry whitespace errors or conflict markers"],
  [packageJson.includes('"type-check:frontend"') && packageJson.includes("npm --workspace frontend run type-check") && packageJson.includes('"type-check:all"') && frontendPackageJson.includes('"type-check"') && frontendPackageJson.includes("vue-tsc -b"), "package.json must expose type-check:frontend (vue-tsc) so local gates catch the same Vue unused/type errors as CI frontend:build"],
  [adminOrdersView.includes("openEmailLogsForOrder") && adminOrdersView.includes("path: '/admin/email-logs'") && adminOrdersView.includes("openBalanceLedgerForOrder") && adminOrdersView.includes("path: '/admin/balance'") && adminOrdersView.includes("filter.q = String(query.q).slice(0, 120)"), "Admin orders must deep-link to email logs / balance ledger and cap route q at 120"],
  // paymentRef：列表/详情在 AdminOrdersView；CSV 列在 shared/admin-order-export；查询投影在 admin-service。
  // 这条断言历史上因实现搬家漂移过两次（路由层 → 服务层、硬编码列名 → 共享契约），故用标签式写法，
  // 下次断裂时直接指出是哪一层，而不是让人重新排查六个字面量。
  [{
    "列表表头": adminOrdersView.includes("adminOrders.colPaymentRef"),
    "列表单元格": adminOrdersView.includes("item.paymentRef"),
    "详情字段": adminOrdersView.includes("currentOrder.paymentRef"),
    "服务层查询投影": adminService.includes("paymentRef: orders.paymentRef"),
    "服务层导出行": adminService.includes("row.paymentRef"),
    "CSV 共享契约列": readFileSync("shared/admin-order-export.ts", "utf8").includes('"paymentRef"'),
  }, "Admin order list and CSV exports must expose paymentRef for reconciliation see-in-list"],
  [adminService.includes("purgeEmptyCardBatches") && adminService.includes("deleteEmptyCardBatches") && adminService.includes("includeEmpty") && adminService.includes("EXISTS (SELECT 1 FROM cards WHERE cards.batch_id") && adminRoute.includes("/batches/purge-empty") && adminCardsViewSource.includes("purgeEmptyBatches") && adminCardsViewSource.includes("adminCards.purgeTitle"), "Admin card batches must hide empty batches by default, cascade-delete empty rows, and expose purge-empty"],
  [adminEmailLogsView.includes("initFilterFromRoute") && adminEmailLogsView.includes("route.query.search") && adminEmailLogsView.includes("path: '/admin/orders'") && adminBalanceView.includes("initFilterFromRoute") && adminBalanceView.includes("query.referenceId") && adminBalanceView.includes("path: '/admin/orders'"), "Admin email logs and balance views must hydrate filters from route query and deep-link back to orders"],
  [packageJson.includes('"verify:architecture": "node scripts/23-verify-light-architecture.mjs"') && packageJson.includes("npm run verify:architecture"), "package.json must expose and run the lightweight architecture gate"],
  [packageJson.includes('"verify:lightweight": "node scripts/24-verify-lightweight-principles.mjs"') && packageJson.includes("npm run verify:lightweight"), "package.json must expose and run the lightweight principles gate"],
  [architectureVerify.includes("services layer must not import routes") && architectureVerify.includes("admin API client must stay inside admin surfaces"), "architecture gate must protect backend layer direction and frontend admin-surface boundaries"],
  [lightweightVerify.includes("allowedRuntimeDependencies") && lightweightVerify.includes("legacy smoke wrappers") && lightweightVerify.includes("verify:delivery must include"), "lightweight principles gate must protect dependency budget, smoke entrypoints, and delivery gate composition"],
  [packageJson.includes('"smoke:readonly": "node scripts/04-smoke-readonly.mjs"') && packageJson.includes('"smoke:frontend-assets": "node scripts/26-smoke-frontend-assets.mjs"') && packageJson.includes('"smoke:admin": "node scripts/05-smoke-admin.mjs"') && frontendAssetSmoke.includes("extractFrontendAssetPaths") && frontendAssetSmoke.includes("immutable"), "package.json smoke scripts must include full frontend asset integrity checks"],
  [security.includes('ALLOW_TURNSTILE_BYPASS_FOR_SMOKE === "true"') && security.includes('"x-smoke-admin-token"') && security.includes("请完成人机验证"), "Turnstile must reject missing token by default and allow only explicit admin-token smoke bypass"],
  [emailAccess.includes('name: "HMAC"') && emailAccess.includes('hash: "SHA-256"') && emailAccess.includes("currentWindow - 1") && emailAccessRoute.includes('post("/email/access-code"') && emailAccessRoute.includes("verifyTurnstile") && emailAccessRoute.includes('template: "email_access_code"'), "Email ownership checks must use short-lived HMAC codes sent only after Turnstile verification"],
  [emailAccessRoute.includes("EMAIL_ACCESS_CODE_RESEND_COOLDOWN_SECONDS = 60") && emailAccessRoute.includes("reserveCooldown") && emailAccessRoute.includes("EMAIL_CODE_COOLDOWN"), "Email access code sends must enforce a server-side 60 second resend cooldown"],
  [!payModal.includes("watch([email, emailAccessCode]") && payModal.includes("watch(emailAccessCode"), "PayModal must not watch emailAccessCode and clear emailAccessCode in the same watcher"],
  [ordersRoute.includes('post("/orders/lookup"') && ordersRoute.includes("getOrderSummariesByEmail") && ordersRoute.includes("verifyEmailAccessCode") && !ordersRoute.includes("getOrderSummaryByNoAndEmail") && orderService.includes("getOrderSummariesByEmail") && orderServiceRealDbTest.includes("returns delivery for verified mailbox (never orderToken/PII)") && apiClient.includes("body: JSON.stringify({ email })") && payRoute.indexOf("const mailboxVerified") < payRoute.indexOf("const idempotencyKey") && voucherRoute.includes("verifyEmailAccessCode"), "Mailbox lookup must use a POST body, require verification, and return real-libSQL-tested summaries (delivery after OTP for web_and_email); balance reads/debits must verify mailbox ownership before replay"],
  [adminRoute.includes("payload.sub") && adminRoute.includes("TG_OWNER_ID") && adminRoute.includes("Number.isFinite(payload.exp)") && telegramBot.includes("providedAdminToken") && telegramBot.includes('env.ADMIN_TOKEN'), "Telegram admin JWT exchange and webhook setup must enforce owner/admin credentials"],
  [apiClient.includes("requestEmailAccessCode") && apiClient.includes("X-Email-Access-Code") && ordersRoute.includes('c.req.header("x-email-access-code")') && payModal.includes("emailAccessCode") && payModal.includes("balanceChecked"), "Frontend balance and order access must complete the email-code verification flow before enabling private actions"],
  [systemConfigRegistry.includes("system-config-definitions.json") && systemConfigRegistry.includes("normalizeSystemConfigValue") && systemConfigRegistry.includes("未注册，保存后不会被业务代码读取"), "System config registry must load supported keys from JSON definitions and reject zombie parameters"],
  [systemConfigKeys.includes("offline_pay_hint") && systemConfigKeys.includes("order_expire_minutes") && systemConfigKeys.includes("inventory_warning_threshold"), "System config registry must cover public payment hint, order expiry, and inventory warning settings"],
  [systemConfigKeys.includes("shop_name") && systemConfigKeys.includes("support_email") && systemConfigDefinitions.includes('"format": "email"'), "System config registry must include real shop brand settings with email validation"],
  [deployFull.includes("buildSystemConfigSeedSql") && deployFull.includes("system-config-definitions.json"), "deploy:full must generate system_config seed from the shared definitions file"],
  [missingSeedKeys.length === 0, `deploy:full system_config seed is missing registered keys: ${missingSeedKeys.join(", ")}`],
  [shopConfig.includes("fetchConfig") && shopConfig.includes("shop_name") && shopConfig.includes("support_email"), "Frontend must consume shop_name/support_email from public system config"],
  [headerBar.includes("shopName") && appVue.includes("supportEmail") && appVue.includes("loadShopConfig()"), "Shop brand settings must have real Header and footer display points"],
  [checkoutFlow.includes("startStatusPolling") && checkoutFlow.includes("startOfflineCountdown") && offlinePayment.includes("confirmOfflinePay"), "Checkout state must live in composables for polling, countdown, and offline confirmation"],
  [checkoutFlow.includes("fulfillmentPending") && checkoutFlow.includes("res.message") && checkoutFlow.includes("res.cards") && checkoutFlow.includes("多张卡密已发放"), "Checkout polling must surface paid-but-not-issued fulfillment status truthfully and pass issued cards to the result view"],
  [payModal.includes("余额支付已完成，多张卡密已发放") && payModal.includes("isBasePriceFreeProduct.value ? '领取成功' : '支付成功'") && payModal.includes("res.cards"), "Internal-settlement result view must distinguish free collection from paid success and pass multi-card payloads to DeliveryInfo"],
  [payRoute.includes("payableCents === 0") && payRoute.includes('internalPaymentProvider = payableCents === 0 ? "free" : "balance"') && payModal.includes("订单无需支付"), "Zero-amount orders must skip external payment providers and show a no-payment completion flow"],
  [!payModal.includes("addRecentOrder") && paymentComposable.includes("sessionStorage.getItem(PENDING_ATTEMPTS_KEY)") && !paymentComposable.includes("localStorage.getItem(PENDING_ATTEMPTS_KEY)") && frontendEntry.includes("localStorage.removeItem('recent_orders')") && frontendEntry.includes("localStorage.removeItem('pending_checkout_attempts')"), "Storefront must not persist order tokens or checkout recovery credentials across browser sessions and must remove legacy localStorage data"],
  [orderView.includes("cards: res.cards || []"), "Order detail page must preserve card arrays returned by pay/status for multi-quantity orders"],
  [deliveryInfo.includes("showCardDelivery") && deliveryInfo.includes("normalizedCards") && deliveryInfo.includes("showCardDelivery && delivery?.deliverySecret"), "DeliveryInfo must avoid duplicating the first card when a card list is present"],
  [payModal.includes("useCheckoutFlow") && payModal.includes("useOfflinePayment") && payModal.includes("await refreshCurrentProductStock()") && !payModal.includes("let pollTimer"), "PayModal must use checkout composables instead of owning polling timers and must refresh modal stock after inventory conflicts"],
  [paymentCatalog.includes("PAYMENT_PROVIDER_CATALOG") && paymentCatalog.includes("PAYMENT_PROVIDER_FACTORIES") && paymentCatalog.includes("VALID_PROVIDER_NAMES"), "Payment provider catalog must be the source for factories, callback whitelist, and admin metadata"],
  [adminPaymentRoute.includes("PAYMENT_PROVIDER_CATALOG") && adminPaymentRoute.includes("getProviderMeta") && !adminPaymentRoute.includes("PROVIDER_METADATA"), "Admin payment route must derive provider metadata from the payment catalog"],
  [smokeHttpClient.includes('"x-smoke-admin-token": process.env.ADMIN_TOKEN'), "Smoke client must send x-smoke-admin-token when ADMIN_TOKEN is present"],
  [readonlySmoke.includes("products.storefront?.id") && (readonlySmoke.includes("JSON.stringify({ storefrontId, productId: product.id") || readonlySmoke.includes("JSON.stringify({ storefrontId, productId: paidProduct.id")), "Readonly coupon quote smoke must bind the stable storefront id returned by the catalog"],
  [writeSmoke.includes("body: JSON.stringify(paymentBody)") && writeSmoke.includes("IDEMPOTENCY_REQUEST_MISMATCH"), "Write smoke must replay an identical payment request and separately reject changed parameters for the same idempotency key"],
  [launchVerify.includes("/api/admin/payment/providers") && launchVerify.includes("LAUNCH_TEST_EMAIL_TO") && launchVerify.includes("backup-remote"), "verify:launch must cover payment provider, email, and backup readiness gates"],
  [launchVerify.includes("远程运行时邮件配置可用") && !launchVerify.includes('if (!process.env.RESEND_API_KEY)'), "verify:launch must accept email credentials from remote admin config when the real test email succeeds"],
  [opsMaintenance.includes("turso db export") && opsMaintenance.includes("--with-metadata") && opsMaintenance.includes("sync-turso-backup.mjs") && !opsMaintenance.includes("turso db dump") && backupSync.includes("await client.sync()") && backupWorkflow.includes("TURSO_CLI_VERSION: v1.0.30") && gitignore.includes("/backups/"), "Turso backups must export, SDK-sync, checkpoint, encrypt, use a pinned CLI, and keep plaintext backup paths out of Git"],
  [migrationWrapper.includes("scripts/migrate.mjs") && !migrationWrapper.includes(' < "$f"') && !migrationWrapper.includes("for f in"), "Turso migration wrapper must delegate to the UP/DOWN-aware migration runner"],
  [migrationRunner.includes("executed.clear()"), "Migration reset must clear the in-memory executed set before applying fresh migrations"],
  [migration004.includes("ALTER TABLE orders ADD COLUMN delivery_visibility") && migration004.includes("UPDATE orders") && migration004.includes("products.delivery_visibility"), "Order delivery visibility migration must add and backfill the immutable order snapshot"],
  [migration008.includes("stock_display_mode") && adminProductsView.includes("stockDisplayMode") && storefrontStock.includes("exactStockOrNull") && storefrontStock.includes("availability_only") && storefrontStock.includes("hidden"), "Product stock visibility must be backed by migration, admin configuration, and a shared storefront policy"],
  [migration009.includes("CREATE TABLE IF NOT EXISTS balance_recharge_orders") && migration009.includes("idx_balance_recharge_payment_ref_unique") && rechargeRoute.includes('post("/recharge/create"') && rechargeRoute.includes('post("/recharge/status"') && rechargeRoute.includes('all("/recharge/callback/:provider"'), "Balance recharge must use its own migration and create/status/callback contract"],
  [adminService.includes('recordDelete("balance_recharge_orders"') && cleanupBusinessData.includes("balance_recharge_orders"), "Admin and operator business-data cleanup must delete balance recharge orders"],
  [adminModal.includes("closeOnBackdrop: false") && adminModal.includes("closeOnEscape: false") && adminModal.includes("max-height: calc(100dvh - 48px)") && adminModal.includes("bodyRef.value.scrollTop = 0"), "Admin modals must resist accidental dismissal and open long content at the top inside the viewport"],
  [adminRoute.includes('post("/logs/clear"') && adminService.includes("clearAllMergedLogs") && adminLogsView.includes("clearAllAdminLogs") && adminLogsView.includes("清除全部日志"), "Admin operation logs must expose an authenticated, explicit-confirmation clear-all flow with retained audit evidence"],
  [migration001.includes("CREATE TABLE IF NOT EXISTS products"), "migration 0001 must create products"],
  [migration001.includes("CREATE TABLE IF NOT EXISTS cards"), "migration 0001 must create cards"],
  [migration001.includes("CREATE TABLE IF NOT EXISTS orders"), "migration 0001 must create orders"],
  [migration001.includes("CREATE TABLE IF NOT EXISTS coupons"), "migration 0001 must create coupons"],
  [migration001.includes("CREATE TABLE IF NOT EXISTS admin_audit_logs"), "migration 0001 must create admin audit logs"],
  [migration001.includes("CREATE TABLE IF NOT EXISTS idempotency_keys"), "migration 0001 must create idempotency keys"],
  [migration001.includes("CREATE TABLE IF NOT EXISTS system_config"), "migration 0001 must create system_config"],
  [migration001.includes("CREATE TABLE IF NOT EXISTS card_logs"), "migration 0001 must create card_logs"],
  [migration001.includes("CREATE TABLE IF NOT EXISTS rate_limit_windows"), "migration 0001 must create rate_limit_windows"],
  [migration001.includes("'pending'"), "migration 0001 must define orders status check with pending"],
  [migration001.includes("CREATE TABLE IF NOT EXISTS voucher_codes"), "migration 0001 baseline must create voucher_codes"],
  [migration001.includes("CREATE TABLE IF NOT EXISTS user_balances"), "migration 0001 baseline must create user_balances"],
  [migration001.includes("CREATE TABLE IF NOT EXISTS balance_transactions"), "migration 0001 baseline must create balance transaction ledger"],
  [migration001.includes("delivery_json TEXT NOT NULL DEFAULT ''"), "migration 0001 baseline must include virtual fulfillment delivery_json"],
  [migration001.includes("buyer_email TEXT NOT NULL DEFAULT ''") && migration001.includes("buyer_contact TEXT NOT NULL DEFAULT ''"), "migration 0001 baseline must bind issued cards to buyers"],
  [migration001.includes("expires_at TEXT"), "migration 0001 baseline must include nullable expiry fields"],
  [migration001.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_product_delivery_secret_unique"), "migration 0001 baseline must add hard unique card-secret index"],
  [migration001.includes("CREATE TABLE IF NOT EXISTS order_items"), "migration 0001 baseline must create order_items"],
  [migration001.includes("delivery_visibility TEXT NOT NULL DEFAULT 'web_and_email'"), "migration 0001 baseline must include product delivery_visibility"],
  [migration003.includes("ALTER TABLE products ADD COLUMN delivery_visibility"), "migration 0003 must add product delivery_visibility for existing deployments"]
 ];

/*
 * 断言条件支持三种写法（完全向后兼容）：
 *   boolean            —— 传统写法；失败时只能打印整句 message
 *   [cond, cond, ...]  —— 失败时报告断裂项的下标
 *   { 标签: cond, ... } —— 失败时报告断裂项的标签（新增/易漂移的断言优先用这种）
 *
 * 动机：多路 && 拼成的断言一旦失败，只会输出一句笼统的 message，
 * 无法判断是「功能真的回归」还是「实现重构后字面量漂移」，定位成本极高。
 */
function evaluateCondition(condition) {
  if (Array.isArray(condition)) {
    const broken = condition.map((ok, index) => (ok ? null : `#${index}`)).filter(Boolean);
    return { ok: broken.length === 0, broken };
  }
  if (condition && typeof condition === "object") {
    const broken = Object.entries(condition).filter(([, ok]) => !ok).map(([label]) => label);
    return { ok: broken.length === 0, broken };
  }
  return { ok: Boolean(condition), broken: [] };
}

const failed = checks
  .map(([condition, message]) => ({ ...evaluateCondition(condition), message }))
  .filter((result) => !result.ok);
if (failed.length > 0) {
  for (const { message, broken } of failed) {
    console.error(broken.length > 0 ? `${message}\n    断裂条件: ${broken.join(" / ")}` : message);
  }
  process.exit(1);
}

console.log("cf-shop checks passed.");
