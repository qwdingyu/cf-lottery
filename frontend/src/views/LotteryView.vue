<template>
  <div class="lottery-view">
    <header class="lottery-header">
      <div class="lottery-header-left">
        <RouterLink to="/" class="lottery-home-link" style="color:var(--primary);text-decoration:none;font-size:13px">{{ $t('common.backToHome') }}</RouterLink>
        <h1 class="lottery-title">{{ drawTitle }}</h1>
        <!-- 深链单活动：只保留分享，不提供「回全部/广场」（docs/055a ADR-055a-1） -->
        <div v-if="isDeepLinked && draws[0]" class="lottery-link-bar">
          <RouterLink
            v-if="draws[0].store?.storeSlug"
            :to="`/shop/${encodeURIComponent(draws[0].store.storeSlug)}`"
            class="lottery-store-btn"
          >
            {{ $t('lottery.viewStore', { name: draws[0].store.name || $t('shop.title') }) }}
          </RouterLink>
          <button type="button" class="lottery-share-btn" @click="handleCopyPublicLink(draws[0].id)">📋 {{ $t('lottery.copyShareLink') }}</button>
        </div>
      </div>
      <div class="lottery-header-actions">
        <select class="lang-select" :value="locale" @change="onLanguageChange">
          <option value="zh-CN">{{ $t('adminLayout.langZh') }}</option>
          <option value="en">{{ $t('adminLayout.langEn') }}</option>
        </select>
        <template v-if="sessionEmail || registeredUsername">
          <span class="lottery-user">{{ registeredUsername || sessionEmail }}</span>
          <button class="lottery-logout" @click="handleLogout">{{ $t('lottery.logout') }}</button>
        </template>
        <button v-else class="lottery-login-btn" @click="openLogin()">{{ $t('lottery.loginToViewRecords') }}</button>
      </div>
    </header>
<!-- 加载 / 空态 -->
    <div v-if="loading" class="lottery-skeleton">
      <div v-for="i in 3" :key="i" class="skeleton-card">
        <div class="skeleton-row skeleton-title" />
        <div class="skeleton-row skeleton-text" />
        <div class="skeleton-row skeleton-btn" />
      </div>
    </div>
    <div v-else-if="fetchError" class="lottery-center">
      <div class="empty-icon">⚠️</div>
      <p>{{ fetchError }}</p>
      <button class="btn btn-ghost btn-sm" style="margin-top:12px" @click="fetchDraws">{{ $t('lottery.retry') }}</button>
    </div>
    <div v-else-if="draws.length === 0" class="lottery-center">
      <div class="empty-icon">🎪</div>
      <!-- 055a：无 slug 不是「广场空列表」，而是请用活动链接；深链加载失败则诚实说明 -->
      <p>{{ isDeepLinked ? $t('lottery.noActivity') : $t('lottery.needActivityLink') }}</p>
      <p v-if="!isDeepLinked" class="lottery-empty-hint">{{ $t('lottery.needActivityLinkHint') }}</p>
      <!-- 空 slug 兜底：给一个可行动的出口，而不是死胡同（P2 404/空态优化） -->
      <RouterLink v-if="!isDeepLinked" to="/" class="btn btn-primary" style="margin-top:12px;display:inline-block;text-decoration:none">{{ $t('landing.marketBrowseCta') }}</RouterLink>
    </div>

    <!-- 活动卡片 -->
    <div v-else class="lottery-main" :class="{ 'lottery-main--deep': isDeepLinked }">
      <div
        v-for="draw in draws"
        :key="draw.id"
        class="lottery-card"
        :class="{
          expanded: isCardExpanded(draw.id),
          'lottery-card--deep': isDeepLinked,
        }"
      >
        <div
          class="lottery-card-head"
          :class="{ 'lottery-card-head--static': isDeepLinked }"
          @click="!isDeepLinked && toggleExpand(draw.id)"
        >
          <div class="lottery-card-left">
            <h3 class="lottery-card-title">{{ draw.name || draw.title }}</h3>
            <div class="lottery-card-tags">
              <span class="lottery-tag" :class="draw.status">{{ statusText(draw) }}</span>
              <span v-if="resultModeLabel(draw)" class="lottery-tag mode">{{ resultModeLabel(draw) }}</span>
              <span v-if="myWonById[draw.id]" class="lottery-tag won">🎉 {{ $t('lottery.wonTag') }}</span>
              <span v-else-if="isDrawJoined(draw)" class="lottery-tag joined">{{ $t('lottery.joined') }}</span>
              <span
                v-if="isInstantLottery(draw) && isDrawJoined(draw) && spinsLeftById[draw.id] != null"
                class="lottery-tag spins"
                role="status"
                aria-live="polite"
              >
                {{ $t('lottery.spinsLeftHint', {
                  left: spinsLeftById[draw.id],
                  max: draw.maxSpinsPerEntry || spinsLeftById[draw.id],
                }) }}
              </span>
              <span v-if="draw.entryCount != null" class="lottery-tag count">{{ $t('lottery.drawCount', { count: draw.entryCount }) }}</span>
            </div>
          </div>
          <!-- 深链单活动：始终展开，不提供收起（避免多一步才能看到主 CTA） -->
          <button
            v-if="!isDeepLinked"
            type="button"
            class="lottery-expand-btn"
          >{{ expandedId === draw.id ? '▲ ' + $t('lottery.collapse') : '▼ ' + $t('lottery.expand') }}</button>
        </div>
        <!-- 折叠态快捷操作（仅非深链列表心智；深链始终展开） -->
        <div v-if="!isDeepLinked && expandedId !== draw.id && draw.status === 'drawn' && !sessionEmail" class="lottery-quick-bar">
          <!-- docs/097：登录查结果，不带 drawId 以免进「参与 OTP」弹窗 -->
          <button class="lottery-share-btn" @click="openLogin()">{{ $t('lottery.loginToCheck') }}</button>
        </div>
        <div v-if="!isDeepLinked && expandedId !== draw.id && draw.status === 'drawn' && sessionEmail" class="lottery-quick-bar">
          <button class="lottery-share-btn" @click="openMyResult(draw)">{{ $t('lottery.queryResult') }}</button>
        </div>

        <div v-if="isCardExpanded(draw.id)" class="lottery-card-body">
          <!-- 活动说明：深链沉浸首屏可见，减少「只有动画不知道规则」 -->
          <p v-if="drawDescription(draw)" class="lottery-draw-desc">{{ drawDescription(draw) }}</p>
          <!-- docs/076：非 open 状态横幅 + 可执行 CTA，避免只剩一句灰字 -->
          <div
            v-if="statusPathHint(draw)"
            class="lottery-status-banner"
            :class="'lottery-status-banner--' + publicStatusBannerTone(draw.status)"
            role="status"
          >
            <p class="lottery-status-path">{{ statusPathHint(draw) }}</p>
          </div>
          <!--
            奖池陈列（docs/128）：
            - full/summary：公示「活动有什么奖」（信任），不宣称「你已中」
            - ritual_only / hidden：不展示条（强悬念）
            游戏壳扇面文案另走 shellPrizeItems，delayed 默认仪式短语。
          -->
          <ul
            v-if="prizePoolStripFor(draw).length"
            class="lottery-prize-strip"
            :aria-label="$t('lottery.prizeStripAria')"
          >
            <li v-for="(p, pi) in prizePoolStripFor(draw)" :key="pi" class="lottery-prize-chip">
              <span class="lottery-prize-chip-name">{{ p.name || p.tierName || $t('lottery.productPlaceholder') }}</span>
              <span v-if="p.winnerCount" class="lottery-prize-chip-n">×{{ p.winnerCount }}</span>
            </li>
          </ul>
          <!-- delayed 仪式壳：一行诚实说明，降低「停格=中奖」误读（docs/128） -->
          <p
            v-if="showPrizeShellRitualHint(draw)"
            class="lottery-prize-shell-hint"
            role="note"
          >{{ $t('lottery.prizeShellRitualHint') }}</p>
          <!--
            问卷/投票：提交字段必须在参与前可见可填（此前仅有 draft 逻辑与 CSS，模板未挂载 → 永远校验失败）。
            与 experience 游戏壳解耦：先填内容，再点游戏/底部 CTA 触发 handleJoin。
          -->
          <div
            v-if="requiresActivitySubmission(draw) && isDrawJoinable(draw) && !isDrawJoined(draw)"
            class="activity-submission"
          >
            <template v-if="draw.activityConfig?.kind === 'vote'">
              <p class="lottery-submission-title">{{ $t('lottery.votePickTitle') }}</p>
              <label
                v-for="opt in (draw.activityConfig.options || [])"
                :key="opt.id"
                class="vote-option"
              >
                <input
                  type="radio"
                  :name="'vote-' + draw.id"
                  :value="opt.id"
                  :checked="submissionDrafts[draw.id]?.optionId === opt.id"
                  :disabled="joiningId === draw.id"
                  @change="setVoteOption(draw.id, opt.id)"
                />
                <!-- 投票选项图片（2026-08 补漏）：运营配置的 imageUrl 此前只在管理端配置里存在，
                     公开端仅渲染 label/description——配置了图却不展示=「配置失效」感 -->
                <img
                  v-if="opt.imageUrl"
                  :src="opt.imageUrl"
                  :alt="opt.label"
                  class="vote-option-img"
                  loading="lazy"
                />
                <span>
                  <strong>{{ opt.label }}</strong>
                  <small v-if="opt.description">{{ opt.description }}</small>
                </span>
              </label>
            </template>
            <template v-else-if="draw.activityConfig?.kind === 'survey'">
              <p class="lottery-submission-title">{{ $t('lottery.surveyFillTitle') }}</p>
              <label
                v-for="field in (draw.activityConfig.fields || [])"
                :key="field.id"
                class="survey-field"
              >
                <span>{{ field.label }}<em v-if="field.required"> *</em></span>
                <textarea
                  v-if="field.type === 'textarea'"
                  :value="submissionDrafts[draw.id]?.fields?.[field.id] || ''"
                  :maxlength="field.maxLength || 500"
                  :disabled="joiningId === draw.id"
                  rows="3"
                  @input="setSurveyField(draw.id, field.id, ($event.target as HTMLTextAreaElement).value)"
                />
                <select
                  v-else-if="field.type === 'select'"
                  :value="submissionDrafts[draw.id]?.fields?.[field.id] || ''"
                  :disabled="joiningId === draw.id"
                  @change="setSurveyField(draw.id, field.id, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">{{ $t('lottery.pleaseSelect') }}</option>
                  <option v-for="o in (field.options || [])" :key="o.id" :value="o.id">{{ o.label }}</option>
                </select>
                <!-- docs/162 P2-3：radio 原先渲染为 select 下拉（与 select 合并分支），
                     单选语义丢失且多一次点按；现按投票区投票选项样式渲染为 radio 组 -->
                <div v-else-if="field.type === 'radio'" class="radio-stack">
                  <label v-for="o in (field.options || [])" :key="o.id" class="radio-option">
                    <input
                      type="radio"
                      :name="'survey-' + draw.id + '-' + field.id"
                      :value="o.id"
                      :checked="submissionDrafts[draw.id]?.fields?.[field.id] === o.id"
                      :disabled="joiningId === draw.id"
                      @change="setSurveyField(draw.id, field.id, o.id)"
                    />
                    <span>{{ o.label }}</span>
                  </label>
                </div>
                <div v-else-if="field.type === 'checkbox'" class="checkbox-stack">
                  <label v-for="o in (field.options || [])" :key="o.id" class="checkbox-option">
                    <input
                      type="checkbox"
                      :checked="Array.isArray(submissionDrafts[draw.id]?.fields?.[field.id]) && submissionDrafts[draw.id].fields[field.id].includes(o.id)"
                      :disabled="joiningId === draw.id"
                      @change="toggleSurveyCheckbox(draw.id, field.id, o.id, ($event.target as HTMLInputElement).checked)"
                    />
                    <span>{{ o.label }}</span>
                  </label>
                </div>
                <input
                  v-else
                  :type="field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text'"
                  :value="submissionDrafts[draw.id]?.fields?.[field.id] || ''"
                  :maxlength="field.maxLength || 200"
                  :disabled="joiningId === draw.id"
                  @input="setSurveyField(draw.id, field.id, ($event.target as HTMLInputElement).value)"
                />
              </label>
            </template>
          </div>
          <div v-if="flashSaleMerchCard(draw)" class="lottery-flash-merch">
            <div class="lottery-flash-merch-media" :class="{ 'lottery-flash-merch-media--empty': !flashSaleMerchCard(draw)?.imageUrl }">
              <img
                v-if="flashSaleMerchCard(draw)?.imageUrl"
                :src="flashSaleMerchCard(draw)?.imageUrl"
                :alt="flashSaleMerchCard(draw)?.title || $t('lottery.flashSaleProduct')"
              />
              <span v-else>SALE</span>
            </div>
            <div class="lottery-flash-merch-body">
              <div class="lottery-flash-merch-tags">
                <span v-if="flashSaleMerchCard(draw)?.sessionLabel" class="lottery-flash-merch-tag is-session">{{ flashSaleMerchCard(draw)?.sessionLabel }}</span>
                <span class="lottery-flash-merch-tag">{{ flashSaleMerchCard(draw)?.isDirectPayment ? $t('lottery.flashDirectPayment') : $t('lottery.flashExternalCheckout') }}</span>
                <span v-if="flashSaleMerchCard(draw)?.effectiveStockLimit" class="lottery-flash-merch-tag">{{ $t('lottery.flashQuota', { n: flashSaleMerchCard(draw)?.effectiveStockLimit }) }}</span>
              </div>
              <h4 class="lottery-flash-merch-title">{{ flashSaleMerchCard(draw)?.title || $t('lottery.flashSaleProduct') }}</h4>
              <div class="lottery-flash-merch-bottom">
                <strong v-if="flashSaleMerchCard(draw)?.priceText" class="lottery-flash-merch-price">{{ flashSaleMerchCard(draw)?.priceText }}</strong>
                <span v-else class="lottery-flash-merch-price lottery-flash-merch-price--missing">{{ $t('lottery.flashPriceMissing') }}</span>
                <span v-if="flashSaleMerchCard(draw)?.remaining != null" class="lottery-flash-merch-stock">{{ $t('lottery.flashRemaining', { n: flashSaleMerchCard(draw)?.remaining }) }}</span>
              </div>
              <div v-if="shouldShowFlashSaleQuantityControl(draw)" class="lottery-flash-quantity" @click.stop>
                <span class="lottery-flash-quantity-label">{{ $t('lottery.flashPurchaseQuantity') }}</span>
                <div class="lottery-flash-quantity-control">
                  <button
                    type="button"
                    class="lottery-flash-qty-btn"
                    :disabled="flashSaleQuantityFor(draw) <= 1"
                    @click="onFlashSaleQuantityChange(draw, -1)"
                    :aria-label="$t('lottery.flashQuantityDecrease')"
                  >−</button>
                  <input
                    :value="flashSaleQuantityFor(draw)"
                    type="number"
                    step="1"
                    min="1"
                    :max="flashSalePurchaseLimit(draw)"
                    @input="onFlashSaleQuantityInput(draw, $event)"
                  />
                  <button
                    type="button"
                    class="lottery-flash-qty-btn"
                    :disabled="flashSaleQuantityFor(draw) >= flashSalePurchaseLimit(draw)"
                    @click="onFlashSaleQuantityChange(draw, 1)"
                    :aria-label="$t('lottery.flashQuantityIncrease')"
                  >+</button>
                </div>
                <small class="lottery-flash-quantity-hint">{{ $t('lottery.flashPurchaseQuantityHint', { max: flashSalePurchaseLimit(draw) }) }}</small>
              </div>
              <p
                v-if="flashSalePurchaseAvailability(draw)"
                class="lottery-flash-purchase-availability"
              >{{ $t('lottery.flashPurchaseAvailability', flashSalePurchaseAvailability(draw)!) }}</p>
              <div v-if="flashSalePurchaseSummary(draw)" class="lottery-flash-pricing" aria-live="polite">
                <div class="lottery-flash-pricing-total">
                  <span>{{ $t('lottery.flashPurchaseTotalPrice') }}</span>
                  <strong>{{ flashSalePurchaseSummary(draw)?.totalPriceText }}</strong>
                </div>
                <div class="lottery-flash-pricing-meta">
                  <span>{{ $t('lottery.flashPurchaseUnitPrice') }}{{ flashSalePurchaseSummary(draw)?.unitPriceText }}</span>
                  <span
                    v-if="flashSalePurchaseSummary(draw)?.tierLabel"
                    class="lottery-flash-pricing-line--tier"
                  >
                    {{ $t('lottery.flashPurchaseTierApplied', { label: flashSalePurchaseSummary(draw)?.tierLabel }) }}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div
            class="lottery-game-area"
            :class="{ 'lottery-game-area--flash-sale': draw.experienceType === 'flash_sale' }"
          >
            <component
              :is="getGameComponent(draw.experienceType || defaultExperienceForParticipation(draw.participationMode || 'open'))"
              :key="draw.id"
              :prizes="gamePrizesFor(draw)"
              :disabled="gameDisabled(draw)"
              :loading="joiningId === draw.id || spinningId === draw.id"
              :celebrate-key="celebrateKeyById[draw.id] || 0"
              :target-sector-index="targetSectorById[draw.id] ?? null"
              :flash-sale="draw.flashSale || null"
              :start-at="draw.startAt || draw.startTime || null"
              :end-at="draw.endAt || draw.endTime || null"
              @play="handleGamePlay(draw)"
              @animation-complete="handleGameAnimationComplete(draw)"
            />
          </div>
          <!--
            055a P1：有游戏壳时，游戏区即主 CTA（@play → handleJoin），底部不再放第二颗「参与」避免双入口。
            无游戏组件（list/queue 等）时仍用底部按钮。已参与/非 open 仍用底部状态条。
          -->
          <div class="lottery-join-bar">
            <!--
              后端允许 paused 状态下恢复已有的 pending 订单，不能因为通用的非 open
              状态条提前短路支付入口。暂停只禁止新订单和追加购买，不影响已发起支付的续付。
            -->
            <template v-if="draw.status !== 'open' && !(draw.status === 'paused' && isDrawJoined(draw) && isDirectPaymentDraw(draw))">
              <span class="lottery-join-hint">{{ statusPathHint(draw) || statusText(draw) }}</span>
              <div class="lottery-status-actions">
                <button
                  v-if="nonOpenPrimaryCta(draw) === 'refresh'"
                  type="button"
                  class="lottery-join-btn primary"
                  :disabled="loading"
                  @click="fetchDraws"
                >{{ loading ? $t('lottery.loadingText') : $t('lottery.refreshStatus') }}</button>
                <button
                  v-else-if="nonOpenPrimaryCta(draw) === 'query_result'"
                  type="button"
                  class="lottery-result-btn lottery-result-btn--primary"
                  @click="openMyResult(draw)"
                >{{ $t('lottery.queryResult') }}</button>
                <button
                  v-else-if="nonOpenPrimaryCta(draw) === 'login_to_check'"
                  type="button"
                  class="lottery-join-btn primary"
                  @click="openLogin()"
                >{{ $t('lottery.loginToCheck') }}</button>
                <button
                  v-if="nonOpenSecondaryCta(draw) === 'copy_link'"
                  type="button"
                  class="lottery-result-btn"
                  @click="handleCopyPublicLink(draw.id)"
                >{{ $t('lottery.copyShareLink') }}</button>
              </div>
            </template>
            <template v-else-if="!isDrawJoinable(draw) && !isDrawJoined(draw)">
              <span class="lottery-join-hint">{{ joinDisabledText(draw) }}</span>
              <div class="lottery-status-actions">
                <button
                  type="button"
                  class="lottery-join-btn primary"
                  :disabled="loading"
                  @click="fetchDraws"
                >{{ loading ? $t('lottery.loadingText') : $t('lottery.refreshStatus') }}</button>
              </div>
            </template>
            <template v-else-if="isDrawJoined(draw) && isDirectPaymentDraw(draw)">
              <span class="lottery-join-hint">✅ {{ $t('lottery.paymentSlotLocked') }} · {{ joinedTimeText(draw) }}</span>
              <div class="lottery-status-actions">
                <button
                  type="button"
                  class="lottery-result-btn lottery-result-btn--primary"
                  :disabled="paymentLoading"
                  @click="handleDirectPaymentAction(draw)"
                >{{ paymentLoading ? $t('lottery.loadingText') : $t('lottery.paymentManagePurchase') }}</button>
                <button
                  type="button"
                  class="lottery-result-btn"
                  @click="openLogin(draw.id, 'join')"
                >{{ $t('lottery.paymentRecoverOrder') }}</button>
              </div>
            </template>
            <template v-else-if="isDrawJoined(draw)">
              <span class="lottery-join-hint">✅ {{ $t('lottery.joined') }} · {{ joinedTimeText(draw) }}</span>
              <!--
                instant 且仍有次数：主 CTA 再抽一次；否则查结果（docs/116）。
                delayed：查结果为主按钮（docs/115）。
              -->
              <button
                v-if="joinedPrimaryCta({ isInstant: isInstantLottery(draw), spinsLeft: spinsLeftById[draw.id] }) === 'spin_again'"
                type="button"
                class="lottery-result-btn lottery-result-btn--primary"
                :disabled="spinningId === draw.id || joiningId === draw.id"
                @click="handleInstantSpin(draw)"
              >{{ spinningId === draw.id ? $t('lottery.loadingText') : $t('lottery.spinAgain') }}</button>
              <button
                type="button"
                class="lottery-result-btn"
                :class="{ 'lottery-result-btn--primary': isQueryResultPrimaryCta({ isInstant: isInstantLottery(draw), spinsLeft: spinsLeftById[draw.id] }) }"
                @click="openMyResult(draw)"
              >{{ $t('lottery.queryResult') }}</button>
            </template>
            <template v-else-if="hasInteractiveGame(draw)">
              <span class="lottery-join-hint">{{
                $t('lottery.' + gamePrimaryCtaHintKey(draw.experienceType, draw.participationMode))
              }}</span>
            </template>
            <template v-else-if="!sessionEmail && !registeredUsername">
              <button type="button" class="lottery-join-btn primary" @click="openLogin(draw.id)">{{ $t('lottery.join') }}</button>
            </template>
            <template v-else>
              <button type="button" class="lottery-join-btn primary" :disabled="joiningId === draw.id" @click="handleJoin(draw.id)">
                {{ joiningId === draw.id ? $t('lottery.loadingText') : $t('lottery.join') }}
              </button>
            </template>
          </div>
          <!--
            同场裂变：自我裂变主入口（docs/041 / 108 / 109）。
            viral.enabled 时挂载；leaderboard 独立；终态弱化邀请但可看历史。
            entryId：参与快照 / myEntryList / hints；无 entry 时诚实提示。
          -->
          <ViralLeaderboard
            v-if="getDrawViral(draw)?.enabled && (draw.publicSlug || draw.id)"
            :draw-slug="String(draw.publicSlug || draw.id)"
            :entry-id="resolveViralEntryId(draw)"
            :is-joined="isDrawJoined(draw)"
            :draw-status="draw.status"
            :viral-config="getDrawViral(draw)"
            @query-result="openMyResult(draw)"
          />
        </div>
      </div>
    </div>

    <!-- 我的参与记录：点行可查结果，避免只展示标签无下一步（docs/096） -->
    <section v-if="(sessionEmail || registeredUsername) && sortedMyEntries.length > 0" class="lottery-records">
      <h2 class="lottery-section-title">{{ $t('lottery.myRecords') }}</h2>
      <div v-if="recordsLoading" class="lottery-center">{{ $t('lottery.loadingText') }}</div>
      <div v-else class="lottery-records-list">
        <button
          v-for="row in sortedMyEntries"
          :key="row.drawId"
          type="button"
          class="lottery-record lottery-record--action"
          @click="openMyResultFromRecord(row)"
        >
          <span class="lottery-record-name">{{ row.drawName || row.drawId }}</span>
          <span v-if="myWonById[row.drawId]" class="lottery-tag won">🎉 {{ $t('lottery.wonTag') }}</span>
          <!-- 仅抽奖族 + drawn 才标「未中奖」；接龙等勿因 status 误伤（docs/104） -->
          <span
            v-else-if="shouldShowNotWonRecordTag({ drawStatus: row.drawStatus, activityKind: row.activityKind, won: false })"
            class="lottery-tag muted"
          >{{ $t('lottery.notWonTag') }}</span>
          <span v-else class="lottery-tag joined">{{ $t('lottery.joined') }}</span>
          <span class="lottery-record-cta">{{ $t('lottery.queryResult') }}</span>
        </button>
      </div>
    </section>

    <div v-if="showLoginModal" class="modal-overlay" @click.self="closeLogin" @keydown.escape="closeLogin">
      <div class="modal-content" role="dialog" aria-modal="true" tabindex="-1" ref="loginModalRef" :aria-label="$t('lottery.emailVerify')">
        <h3 class="modal-title">{{ loginModalTitle }}</h3>
        <p class="modal-hint">{{ loginModalHint }}</p>

        <!--
          仅登录（无具体活动）：优先本页 cf-auth / 邮箱会话，避免硬跳 /admin/login 打断参与心智（docs/096）。
          后台密码登录仍可作次要入口。
        -->
        <div v-if="isLoginOnly" class="modal-form">
          <p class="field-hint" style="text-align:center;margin-bottom:12px">{{ $t('lottery.loginOnlyHint') }}</p>
          <button
            v-if="cfAuthEnabled"
            type="button"
            class="btn btn-primary"
            style="width:100%"
            :disabled="cfAuthLoading"
            @click="handleCfAuthLoginOnly"
          >{{ $t('adminLogin.cfAuthLogin') }}</button>
          <a
            href="/admin/login"
            class="btn"
            :class="cfAuthEnabled ? 'btn-ghost' : 'btn-primary'"
            style="width:100%;text-align:center;text-decoration:none;margin-top:8px;display:inline-block;box-sizing:border-box"
          >{{ $t('lottery.loginViaAdmin') }}</a>
          <button type="button" class="btn btn-ghost btn-sm" style="width:100%;margin-top:8px" @click="closeLogin">{{ $t('confirm.cancel') }}</button>
        </div>

        <!-- registered 模式：用户名密码登录 -->
        <div v-else-if="isRegisteredJoin" class="modal-form">
          <div v-if="cfAuthEnabled" class="auth-choice auth-choice--primary">
            <button
              type="button"
              class="auth-choice-btn auth-choice-btn--primary"
              :disabled="cfAuthLoading"
              @click="handleCfAuthJoin"
            >
              <span class="auth-choice-title">{{ $t('adminLogin.cfAuthLogin') }}</span>
              <span class="auth-choice-subtitle">{{ $t('lottery.unifiedLoginRecommended') }}</span>
            </button>
          </div>
          <div v-if="cfAuthEnabled" class="auth-divider"><span>{{ $t('adminLogin.or') }}</span></div>
          <label>
            <span>{{ $t('adminLogin.username') }}</span>
            <input v-model="regLoginUsername" type="text" autocomplete="username" @keyup.enter="handleRegisteredLogin" />
          </label>
          <label>
            <span>{{ $t('adminLogin.password') }}</span>
            <input v-model="regLoginPassword" type="password" autocomplete="current-password" @keyup.enter="handleRegisteredLogin" />
          </label>
          <p v-if="loginError" class="field-hint" style="color:var(--tg-danger)">{{ loginError }}</p>
          <button class="btn btn-primary" style="width:100%" :disabled="regLoginLoading" @click="handleRegisteredLogin">
            {{ regLoginLoading ? $t('adminLogin.loggingIn') : $t('lottery.loginAndJoin') }}
          </button>
          <p class="field-hint" style="text-align:center;margin-top:8px">
            {{ $t('adminLogin.noAccount') }}
            <a href="/admin/register" target="_blank" class="btn btn-ghost btn-xs">{{ $t('adminLogin.switchToRegister') }}</a>
          </p>
        </div>

        <!-- open / roster / password / invite_code：邮箱验证码 + 模式附加凭证 -->
        <div v-else class="modal-form">
          <!--
            docs/096：已登录（有业务 JWT）仅缺活动密码/邀请码 → 只补凭证，不重复邮箱 OTP。
          -->
          <template v-if="pendingJoinCredentialOnly">
            <p class="field-hint" style="margin-bottom:8px">{{ $t('lottery.credentialOnlyHint') }}</p>
            <label v-if="pendingJoinNeedsPassword">
              <span>{{ $t('lottery.accessPasswordLabel') }}</span>
              <input
                v-model="joinAccessPassword"
                type="password"
                autocomplete="current-password"
                maxlength="64"
                :placeholder="$t('lottery.accessPasswordPlaceholder')"
                @keyup.enter="handleCredentialJoinWithBearer"
              />
            </label>
            <label v-if="pendingJoinNeedsInvite">
              <span>{{ $t('lottery.inviteCodeLabel') }}</span>
              <input
                v-model="joinInviteCode"
                type="text"
                autocomplete="one-time-code"
                maxlength="64"
                :placeholder="$t('lottery.inviteCodePlaceholder')"
                @keyup.enter="handleCredentialJoinWithBearer"
              />
            </label>
            <div class="modal-actions join-modal-actions">
              <button
                type="button"
                class="btn btn-primary join-modal-primary"
                :disabled="verifyingCode || Boolean(joiningId)"
                @click="handleCredentialJoinWithBearer"
              >
                {{ verifyingCode || joiningId ? $t('lottery.loadingText') : $t('lottery.verifyAndJoin') }}
              </button>
              <button type="button" class="btn btn-ghost" @click="closeLogin">
                {{ $t('confirm.cancel') }}
              </button>
            </div>
            <p v-if="loginError" class="form-error">{{ loginError }}</p>
          </template>
          <template v-else>
            <div v-if="cfAuthEnabled && !codeSent" class="auth-choice auth-choice--primary">
              <button
                type="button"
                class="auth-choice-btn auth-choice-btn--primary"
                :disabled="cfAuthLoading"
                @click="handleCfAuthJoin"
              >
                <span class="auth-choice-title">{{ $t('adminLogin.cfAuthLogin') }}</span>
                <span class="auth-choice-subtitle">{{ $t('lottery.unifiedLoginRecommended') }}</span>
              </button>
            </div>
            <div v-if="cfAuthEnabled && !codeSent" class="auth-divider"><span>{{ $t('lottery.emailCodeFallback') }}</span></div>
            <label>
              <span>{{ $t('lottery.emailPlaceholder') }}</span>
              <input
                v-model="loginEmail"
                type="email"
                autocomplete="email"
                inputmode="email"
                @keyup.enter="codeSent ? handleVerifyCode() : handleSendCode()"
              />
            </label>
            <!--
              密码 / 邀请码：后端 joinDraw 强制校验；与邮箱码分离：活动访问凭证 ≠ 邮箱 OTP。
            -->
            <label v-if="pendingJoinNeedsPassword">
              <span>{{ $t('lottery.accessPasswordLabel') }}</span>
              <input
                v-model="joinAccessPassword"
                type="password"
                autocomplete="current-password"
                maxlength="64"
                :placeholder="$t('lottery.accessPasswordPlaceholder')"
                @keyup.enter="codeSent ? handleVerifyCode() : handleSendCode()"
              />
            </label>
            <label v-if="pendingJoinNeedsInvite">
              <span>{{ $t('lottery.inviteCodeLabel') }}</span>
              <input
                v-model="joinInviteCode"
                type="text"
                autocomplete="one-time-code"
                maxlength="64"
                :placeholder="$t('lottery.inviteCodePlaceholder')"
                @keyup.enter="codeSent ? handleVerifyCode() : handleSendCode()"
              />
            </label>
            <div v-if="codeSent" class="verified-email-row">
              <span>{{ $t('lottery.emailVerified', { email: loginEmail }) }}</span>
              <button type="button" class="btn btn-primary btn-sm" :disabled="verifyingCode" @click="handleVerifyCode">
                {{ $t('lottery.oneClickContinue') }}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" @click="loginEmail=''; loginCode=''; codeSent=false">
                {{ $t('lottery.switchEmail') }}
              </button>
            </div>
            <div v-if="codeSent" class="code-row">
              <label class="code-label">
                <span>{{ $t('lottery.codePlaceholder') }}</span>
                <input
                  ref="loginCodeInputRef"
                  v-model="loginCode"
                  type="text"
                  name="one-time-code"
                  inputmode="numeric"
                  pattern="[0-9]*"
                  maxlength="6"
                  class="code-input"
                  autocomplete="one-time-code"
                  enterkeyhint="done"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck="false"
                  :aria-label="$t('lottery.codePlaceholder')"
                  @keyup.enter="handleVerifyCode"
                />
              </label>
              <span class="code-timer">{{ codeCooldown > 0 ? codeCooldown + 's' : '' }}</span>
            </div>
            <div class="modal-actions join-modal-actions">
              <button
                v-if="!codeSent"
                type="button"
                class="btn btn-primary join-modal-primary"
                :disabled="sendingCode"
                @click="handleSendCode"
              >
                {{ sendingCode ? $t('lottery.loadingText') : $t('lottery.sendCode') }}
              </button>
              <template v-else>
                <button
                  type="button"
                  class="btn btn-primary join-modal-primary"
                  :disabled="verifyingCode || Boolean(spinningId)"
                  @click="handleVerifyCode"
                >
                  {{ verifyingCode || spinningId ? $t('lottery.loadingText') : (isSpinAuth ? $t('lottery.spinVerifyAndGo') : $t('lottery.verifyAndJoin')) }}
                </button>
                <button
                  type="button"
                  class="btn btn-ghost"
                  :disabled="sendingCode || codeCooldown > 0"
                  @click="handleSendCode"
                >
                  {{ codeCooldown > 0 ? $t('lottery.resendIn', { s: codeCooldown }) : $t('lottery.sendCode') }}
                </button>
              </template>
              <button type="button" class="btn btn-ghost" @click="closeLogin">
                {{ $t('confirm.cancel') }}
              </button>
            </div>
            <p v-if="loginError" class="form-error">{{ loginError }}</p>
          </template>
        </div>
      </div>
    </div>
  </div>

  <GameResultModal
    :show="showResult"
    :draw-slug="lastJoinDrawSlug"
    :entry-id="lastJoinResult?.entryId"
    :result-mode="lastJoinResultMode"
    :outcome-label="lastJoinOutcomeLabel"
    :draw-status="lastJoinDrawStatus"
    :viral-config="lastJoinViralConfig"
    @close="showResult = false"
    @query-result="onResultModalQuery"
  />

  <!-- 直付秒杀支付弹窗 -->
  <Teleport to="body">
    <div v-if="showPaymentModal" class="game-result-overlay" @click.self="handlePaymentOverlayClick">
      <div class="game-result-modal lottery-payment-modal">
        <button class="result-close" @click="handlePaymentCloseClick">✕</button>
        <div class="result-icon" aria-hidden="true">💳</div>
        <h2 class="result-title">{{ paymentTitle }}</h2>
        <p class="result-hint">{{ paymentHint }}</p>

        <div class="lottery-payment-summary">
          <div class="lottery-payment-row">
            <span class="lottery-payment-label">{{ $t('lottery.paymentAmount') }}</span>
            <strong class="lottery-payment-value">{{ paymentAmountText }}</strong>
          </div>
          <div v-if="paymentState?.quantity && paymentState.quantity > 1" class="lottery-payment-row">
            <span class="lottery-payment-label">{{ $t('lottery.paymentQuantity') }}</span>
            <strong class="lottery-payment-value">{{ paymentState.quantity }}</strong>
          </div>
          <div class="lottery-payment-row">
            <span class="lottery-payment-label">{{ $t('lottery.paymentOrderNo') }}</span>
            <code class="lottery-payment-code" @click="copyPaymentOrderNo">{{ paymentState?.orderNo }}</code>
          </div>
          <div class="lottery-payment-row">
            <span class="lottery-payment-label">{{ $t('lottery.paymentStatusLabel') }}</span>
            <strong class="lottery-payment-value">{{ paymentStatusText }}</strong>
          </div>
        </div>

        <div v-if="paymentQrDataUrl" class="lottery-payment-qr">
          <img :src="paymentQrDataUrl" :alt="$t('lottery.paymentQrAlt')" />
          <p class="result-hint">{{ $t('lottery.paymentQrHint') }}</p>
        </div>
        <div v-else-if="paymentQrLoading" class="lottery-payment-qr">
          <p class="lottery-payment-qr-loading">{{ $t('lottery.paymentQrGenerating') }}</p>
        </div>

        <div v-if="paymentCodes.length && paymentStatusIsPaid" class="result-code-block">
          <span class="result-code-label">{{ $t('lottery.prizeCodeLabel') }}</span>
          <code v-for="(code, idx) in paymentCodes" :key="idx" class="result-code" @click="copyPaymentCode">
            {{ composePaymentCode(code) }}
          </code>
          <small class="result-hint">{{ $t('lottery.clickToCopy') }}</small>
        </div>

        <!-- ★ P0-3: 支付成功二次转化 —— 引导用户回到首页/店铺（docs/211） -->
        <div v-if="paymentStatusIsPaid" class="payment-success-cta">
          <a href="/" class="btn btn-ghost btn-sm">{{ $t('lottery.viewMoreActivities') }}</a>
        </div>

        <div v-if="paymentState?.status === 'paid_fulfillment_failed' || paymentState?.status === 'paid_late_needs_refund'" class="lottery-payment-support" role="alert">
          <p class="result-error">{{ paymentState?.status === 'paid_late_needs_refund' ? $t('lottery.paymentLatePaid') : $t('lottery.paymentFulfillmentFailed') }}</p>
          <p class="result-hint">{{ paymentState?.status === 'paid_late_needs_refund' ? $t('lottery.paymentLatePaidSupportHint') : $t('lottery.paymentFulfillmentSupportHint') }}</p>
          <a v-if="publicSupportEmail" class="lottery-payment-support-link" :href="`mailto:${publicSupportEmail}?subject=${encodeURIComponent(paymentSupportSubject)}`">
            {{ $t('lottery.paymentContactSupport', { email: publicSupportEmail }) }}
          </a>
        </div>
        <p v-if="paymentError" class="result-error">{{ paymentError }}</p>

        <div class="result-actions">
          <a
            v-if="paymentRedirectUrl"
            :href="paymentRedirectUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn-primary"
            @click="handleOpenPaymentLink"
          >{{ $t('lottery.paymentOpen') }}</a>
          <a
            v-if="paymentQrFallbackUrl && paymentQrFallbackUrl !== paymentRedirectUrl"
            :href="paymentQrFallbackUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn-ghost"
            @click="handleOpenPaymentLink"
          >{{ $t('lottery.paymentOpenQrUrl') }}</a>
          <button
            v-if="paymentCanRetry"
            type="button"
            class="btn btn-ghost"
            :disabled="paymentLoading"
            @click="restartPaymentOrder"
          >{{ paymentLoading ? $t('lottery.loadingText') : $t('lottery.paymentRetry') }}</button>
          <button
            v-if="paymentCanRefresh"
            type="button"
            class="btn btn-ghost"
            :disabled="paymentLoading"
            @click="handleRefreshPaymentStatus"
          >{{ paymentLoading ? $t('lottery.loadingText') : $t('lottery.paymentRefresh') }}</button>
          <button type="button" class="btn" :class="paymentRedirectUrl ? 'btn-ghost' : 'btn-primary'" @click="closePaymentModal">
            {{ $t('lottery.gotIt') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 支付中关闭确认弹窗：防止误关闭导致丢失支付入口（docs/202 3.1） -->
    <div v-if="confirmPaymentClose" class="game-result-overlay" @click.self="confirmPaymentClose = false">
      <div class="game-result-modal lottery-payment-confirm">
        <h3 class="result-title">{{ $t('lottery.paymentCloseConfirmTitle') }}</h3>
        <p class="result-hint">{{ $t('lottery.paymentCloseConfirmHint') }}</p>
        <div class="result-actions">
          <button type="button" class="btn btn-primary" @click="hardClosePaymentModal">{{ $t('lottery.paymentCloseConfirmLeave') }}</button>
          <button type="button" class="btn btn-ghost" @click="confirmPaymentClose = false">{{ $t('lottery.paymentCloseConfirmStay') }}</button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 查询我的结果弹窗 -->
  <Teleport to="body">
    <div v-if="showMyResultModal" class="game-result-overlay" @click.self="showMyResultModal = false">
      <div class="game-result-modal">
        <button class="result-close" @click="showMyResultModal = false">✕</button>
        <h2 class="result-title">{{ $t('lottery.myResultTitle') }}</h2>

        <!--
          查询表单（docs/084 / docs/106）：
          - 强会话 JWT：一键查询（后端免 OTP）
          - 弱会话仅 sessionEmail：预填邮箱 + OTP（无码请求必 400，禁止假一键）
          - 无会话：空表单 + OTP
        -->
        <div v-if="!myResultData" class="result-form">
          <template v-if="myResultHasStrongSession">
            <p class="result-hint">
              {{
                $t('lottery.loggedInQueryHint', {
                  name: registeredUsername || sessionEmail || myResultEmail || '…',
                })
              }}
            </p>
            <p v-if="myResultError" class="result-error">{{ myResultError }}</p>
            <button
              type="button"
              class="btn btn-primary result-primary-btn"
              :disabled="myResultLoading"
              @click="queryMyResult"
            >
              {{ myResultLoading ? $t('lottery.queryingText') : $t('lottery.queryText') }}
            </button>
          </template>
          <template v-else>
            <p
              v-if="myResultEmailPrefillHint"
              class="result-hint"
            >{{ $t('lottery.sessionEmailQueryHint', { email: myResultEmailPrefillHint }) }}</p>
            <input
              v-model="myResultEmail"
              type="email"
              autocomplete="email"
              inputmode="email"
              enterkeyhint="next"
              :placeholder="$t('lottery.resultEmailPlaceholder')"
              maxlength="120"
              :disabled="myResultLoading || myResultSendingCode"
            />
            <div class="result-code-row">
              <input
                v-model="myResultCode"
                type="text"
                name="one-time-code"
                inputmode="numeric"
                pattern="[0-9]*"
                autocomplete="one-time-code"
                enterkeyhint="done"
                autocapitalize="off"
                spellcheck="false"
                class="result-code-input"
                :placeholder="$t('lottery.resultCodePlaceholder')"
                maxlength="6"
                :disabled="myResultLoading || myResultSendingCode"
                @keyup.enter="myResultCode.trim() ? queryMyResult() : sendMyResultCode()"
              />
              <button
                type="button"
                class="btn btn-ghost result-send-code-btn"
                :disabled="myResultLoading || myResultSendingCode || myResultCodeCooldown > 0"
                @click="sendMyResultCode"
              >
                {{
                  myResultSendingCode
                    ? $t('lottery.loadingText')
                    : myResultCodeCooldown > 0
                      ? $t('lottery.resendIn', { s: myResultCodeCooldown })
                      : $t('lottery.sendCode')
                }}
              </button>
            </div>
            <p class="result-hint">{{ $t('lottery.resultCodeHintShort') }}</p>
            <p v-if="myResultError" class="result-error">{{ myResultError }}</p>
            <button
              v-if="!myResultCode.trim()"
              type="button"
              class="btn btn-primary result-primary-btn"
              :disabled="myResultLoading || myResultSendingCode || myResultCodeCooldown > 0 || !myResultEmail.trim()"
              @click="sendMyResultCode"
            >
              {{ myResultSendingCode ? $t('lottery.loadingText') : $t('lottery.sendCode') }}
            </button>
            <button
              v-else
              type="button"
              class="btn btn-primary result-primary-btn"
              :disabled="myResultLoading || myResultSendingCode"
              @click="queryMyResult"
            >
              {{ myResultLoading ? $t('lottery.queryingText') : $t('lottery.viewMyResultCta') }}
            </button>
            <button
              v-if="cfAuthEnabled"
              type="button"
              class="btn btn-ghost result-secondary-btn"
              :disabled="myResultLoading || cfAuthLoading"
              @click="handleCfAuthForMyResult"
            >
              {{ $t('lottery.cfAuthQueryFaster') }}
            </button>
          </template>
        </div>

        <!-- 查询结果：按 resultFamily / joined / outcome / won 诚实分支（docs/100、docs/101） -->
        <div v-else class="result-detail">
          <!-- 身份通过但未参与 -->
          <template v-if="myResultData.joined === false">
            <div class="result-line">{{ $t('lottery.resultNotJoined') }}</div>
          </template>

          <!-- 接龙 / 候补 / 预约：占位或候补，绝不是「未抽中奖品」 -->
          <template v-else-if="myResultFamily === 'assignment'">
            <template v-if="myResultData.outcome">
              <div class="result-line">
                <strong v-if="myResultData.outcome.status === 'assigned'">✅ {{ $t('lottery.signupAssigned') }}</strong>
                <strong v-else-if="myResultData.outcome.status === 'waitlisted'">⏳ {{ $t('lottery.signupWaitlisted') }}</strong>
                <strong v-else>📋 {{ $t('lottery.signupStatus') }}</strong>
              </div>
              <div v-if="myResultData.outcome.resultLabel" class="result-line result-outcome-label">
                {{ myResultData.outcome.resultLabel }}
              </div>
              <p v-if="myResultData.outcome.status === 'assigned'" class="result-hint">
                {{ $t('lottery.signupAssignedHint') }}
              </p>
              <p v-else-if="myResultData.outcome.status === 'waitlisted'" class="result-hint">
                {{ $t('lottery.signupWaitlistedHint') }}
              </p>
            </template>
            <template v-else>
              <div class="result-line">✅ {{ $t('lottery.resultJoinedNoLottery') }}</div>
              <p class="result-hint">{{ $t('lottery.signupMissingOutcomeHint') }}</p>
            </template>
          </template>

          <!-- 审批：待审 / 通过 / 拒绝 -->
          <template v-else-if="myResultFamily === 'review'">
            <template v-if="myResultData.outcome">
              <div class="result-line">
                <strong v-if="myResultData.outcome.status === 'approved'">✅ {{ $t('lottery.reviewApproved') }}</strong>
                <strong v-else-if="myResultData.outcome.status === 'rejected'">❌ {{ $t('lottery.reviewRejected') }}</strong>
                <strong v-else>⏳ {{ $t('lottery.reviewPending') }}</strong>
              </div>
              <div v-if="myResultData.outcome.resultLabel" class="result-hint">{{ myResultData.outcome.resultLabel }}</div>
            </template>
            <template v-else>
              <div class="result-line">⏳ {{ $t('lottery.reviewPending') }}</div>
              <p class="result-hint">{{ $t('lottery.reviewPendingHint') }}</p>
            </template>
          </template>

          <!-- 问卷 / 投票 / 签到：参与即完成，无中奖语义 -->
          <template v-else-if="myResultFamily === 'participation'">
            <div class="result-line">✅ {{ $t('lottery.resultJoinedNoLottery') }}</div>
            <p class="result-hint">{{ $t('lottery.resultParticipationHint') }}</p>
          </template>

          <!-- instant：次数用完前未中 → 可再抽；非终态 delayed 等开奖 -->
          <template v-else-if="!myResultData.won && isMyResultInstant && (myResultData.spinsLeft ?? 0) > 0">
            <div class="result-line">🎯 {{ $t('lottery.resultInstantCanSpin') }}</div>
            <p class="result-hint">{{ $t('lottery.spinsLeftHint', {
              left: myResultData.spinsLeft,
              max: myResultData.maxSpinsPerEntry || myResultData.spinsLeft,
            }) }}</p>
          </template>
          <template v-else-if="!myResultData.won && !isMyResultDrawFinal && !isMyResultInstant">
            <div class="result-line">⏳ {{ $t('lottery.resultPendingDraw') }}</div>
            <p class="result-hint">{{ $t('lottery.resultPendingDrawHint') }}</p>
          </template>
          <template v-else-if="myResultData.won">
            <div class="result-line">🎉 <strong>{{ $t('lottery.won') }}</strong></div>
            <!-- instant 多奖：wins[] 全量展示（docs/116） -->
            <template v-if="myResultData.wins && myResultData.wins.length > 1">
              <div
                v-for="(w, wi) in myResultData.wins"
                :key="w.winnerId || wi"
                class="result-prize-meta"
              >
                <div class="result-line">
                  {{ $t('lottery.wonPrizeLabel') }}
                  <strong>{{ w.prizeName || w.tierName || '—' }}</strong>
                </div>
                <div v-if="w.prizeCode" class="result-code-block">
                  <span class="result-code-label">{{ $t('lottery.prizeCodeLabel') }}</span>
                  <code class="result-code" @click="copyMyResult(w.prizeCode!)">{{ w.prizeCode }}</code>
                  <small class="result-hint">{{ $t('lottery.clickToCopy') }}</small>
                </div>
              </div>
            </template>
            <template v-else>
              <div v-if="myResultData.prizeName || myResultData.tierName" class="result-prize-meta">
                <div class="result-line">
                  {{ $t('lottery.wonPrizeLabel') }}
                  <strong>{{ myResultData.prizeName || myResultData.tierName }}</strong>
                </div>
                <div v-if="myResultData.tierName && myResultData.prizeName && myResultData.tierName !== myResultData.prizeName" class="result-hint">
                  {{ $t('lottery.wonTierLabel') }}{{ myResultData.tierName }}
                </div>
                <div v-if="myResultData.prizeValueText" class="result-hint">{{ myResultData.prizeValueText }}</div>
              </div>
              <div v-if="myResultData.prizeCode" class="result-code-block">
                <span class="result-code-label">{{ $t('lottery.prizeCodeLabel') }}</span>
                <code class="result-code" @click="copyMyResult(myResultData.prizeCode)">{{ myResultData.prizeCode }}</code>
                <small class="result-hint">{{ $t('lottery.clickToCopy') }}</small>
              </div>
              <template v-else-if="isManualFulfillmentPrize(myResultData.prizeType)">
                <p class="result-hint result-fulfill-hint">{{ $t('lottery.wonManualFulfillmentHint') }}</p>
                <p v-if="myResultData.fulfillmentNote" class="result-hint">{{ myResultData.fulfillmentNote }}</p>
              </template>
              <template v-else-if="!myResultData.prizeCode">
                <p class="result-hint">{{ $t('lottery.wonNoCodeHint') }}</p>
              </template>
            </template>
            <p
              v-if="isMyResultInstant && myResultData.spinsLeft != null"
              class="result-hint"
            >{{ $t('lottery.spinsLeftHint', {
              left: myResultData.spinsLeft,
              max: myResultData.maxSpinsPerEntry || myResultData.spinsLeft,
            }) }}</p>
            <!-- 仅活动未终态时推邀请；已开奖再「让更多人参与」无意义（docs/103） -->
            <div v-if="showMyResultInviteShare" class="result-share-win">
              <p class="result-share-hint">🎁 {{ $t('lottery.shareYourLuck') }}</p>
              <button class="btn btn-primary btn-sm" @click="shareMyWin">📤 {{ $t('lottery.shareActivityBtn') }}</button>
            </div>
            <div v-if="getResultCta(myResultDraw, 'after_win')" class="result-cta-card">
              <a :href="getResultCta(myResultDraw, 'after_win')!.url" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm">
                {{ getResultCta(myResultDraw, 'after_win')!.title || $t('lottery.viewDetail') }}
              </a>
            </div>
          </template>
          <template v-else-if="myResultData.consolationCoupon">
            <div class="result-line">🎁 <strong>{{ $t('lottery.gotConsolation') }}</strong></div>
            <div class="result-code-block">
              <span class="result-code-label">{{ $t('lottery.couponLabel') }}</span>
              <code class="result-code" @click="copyMyResult(myResultData.consolationCoupon)">{{ myResultData.consolationCoupon }}</code>
              <small class="result-hint">{{ $t('lottery.clickToCopy') }}</small>
            </div>
          </template>
          <!-- 仅抽奖族 + 已开奖 + 未中奖 -->
          <template v-else>
            <div class="result-line">😊 {{ $t('lottery.thanksForParticipating') }}</div>
            <!-- 模式四（docs/218）：未中奖后分享引导，活动未终态时推邀请（与中奖分支同门禁） -->
            <div v-if="showMyResultInviteShare" class="result-share-win">
              <p class="result-share-hint">⭐ {{ $t('lottery.shareAfterMiss') }}</p>
              <button class="btn btn-primary btn-sm" @click="shareMyWin">📤 {{ $t('lottery.shareActivityBtn') }}</button>
            </div>
          </template>

          <div
            v-if="myResultFamily === 'lottery' && myResultData.joined !== false && !myResultData.won && isMyResultDrawFinal && getResultCta(myResultDraw, 'after_loss')"
            class="result-cta-card"
          >
            <a :href="getResultCta(myResultDraw, 'after_loss')!.url" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm">
              {{ getResultCta(myResultDraw, 'after_loss')!.title || $t('lottery.viewDetail') }}
            </a>
          </div>
          <button class="btn btn-ghost" @click="showMyResultModal = false">{{ $t('lottery.gotIt') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * 用户端公开活动页（抽奖是默认玩法，非唯一）。
 *
 * 体验要点：
 * - 顶栏会话 +「我的记录」汇总参与/结果（/lottery/my）
 * - 卡片折叠态即可参与、查结果，减少二次点击
 * - 登录后可选自动加入 pendingDrawId
 * - 个人状态用普通对象（非 Map.set 原地修改）保证 Vue 响应式
 */
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import { switchLanguage } from '@/i18n'
import { useToast } from '@usethink/cf-admin-fe/composables'
import { writeClipboardText } from '@usethink/cf-admin-fe/composables'
import { getGameComponent, hasRegisteredGameExperience } from '@/components/games/GameRegistry'
import GameResultModal from '@/components/games/GameResultModal.vue'
import ViralLeaderboard from '@/components/ViralLeaderboard.vue'
import { useCfAuthLogin } from '@/composables/useCfAuthLogin'
import {
  lockBodyScroll,
  unlockBodyScroll,
  forceUnlockBodyScroll,
} from '@/composables/body-scroll-lock'
import {
  consumeCfAuthPendingJoin,
  readCfAuthPendingJoin,
  saveCfAuthPendingJoin,
  LOTTERY_REGISTERED_TOKEN_KEY,
  LOTTERY_REGISTERED_USERNAME_KEY,
  LOTTERY_SESSION_EMAIL_KEY,
  persistLotterySessionEmail,
  buildCfAuthVerifyJoinBody,
  missingJoinCredentialForMode,
  shouldResumeCfAuthJoin,
  hydrateLotterySessionFromAdminToken,
  resolveOpenJoinEmail,
} from '@/composables/cf-auth-session'
import { clearLotteryBrowserSessionOnly } from '@/composables/business-session'
import { readAdminToken } from '@/composables/useAdminAuth'
import { isOtpComplete, normalizeOtpDigits } from '@/composables/otp-input'
import {
  publicNonOpenPrimaryCta,
  publicNonOpenSecondaryCta,
  publicStatusBannerTone,
} from '@/composables/lottery-public-ux'
import {
  asHttpPaymentUrl,
  buildPaymentSessionSnapshot,
  canRetryPaymentOrder,
  composePaymentCode,
  formatPaymentAmount,
  isDirectPaymentDraw,
  parsePaymentSessionSnapshot,
  type PaymentSessionState,
  paymentStatusI18nKey,
  shouldPollPaymentStatus,
} from './lottery/payment-ux'
import {
  defaultExperienceForParticipation,
  ambienceMsForExperience,
  buildPublicDrawRequestInit,
  gamePrimaryCtaHintKey,
  requiresActivitySubmission,
  normalizePublicDraw,
  getResultCta,
  shouldShowInviteShareCta,
  shouldShowNotWonRecordTag,
  statusHintDrawnI18nKey,
  statusHintDrawingI18nKey,
  publicStatusTagI18nKey,
  resultModeTagI18nKey,
} from './lottery/public-helpers'
import {
  buildPublicPrizeShellPayload,
  withInstantWheelMissSector,
} from './lottery/prize-shell-display'
import {
  buildFlashSaleMerchCard,
  buildFlashSalePurchaseSummary,
  type FlashSaleMerchCard,
  type FlashSalePurchaseSummary,
} from './lottery/flash-sale-merchandising'
import {
  entryIdFromAlreadyJoined,
  isAlreadyJoinedResponse,
  isCheckinSignedToday,
  isSilentFetchOption,
  joinedOpenStatusHintKey,
  readJoinedHints,
  removeJoinedHintsForKeys,
  resolvePublicDrawPathKey,
  upsertJoinedHint,
} from './lottery/joined-session'
import {
  accessCodePurposeForIntent,
  isInstantLottery as isInstantLotteryDraw,
  isPublicGameDisabled,
  isQueryResultPrimaryCta,
  isSpinAuthModal,
  joinedPrimaryCta,
  resolveInstantSpinClientGate,
  shouldVerifyCodeGoToSpin,
  type LoginModalIntent,
} from './lottery/instant-spin-ux'
import type { ActivityEventType, ActivityOutcome, LotteryDraw, MyEntry } from './lottery/types'
import './lottery/lottery-page.css'

const { t, locale } = useI18n()
const { showToast } = useToast()

/** 语言切换：避免模板内 $event.target 在 vue-tsc 下可能为 null */
function onLanguageChange(event: Event) {
  const value = (event.target as HTMLSelectElement | null)?.value
  if (value === 'zh-CN' || value === 'en') switchLanguage(value)
}

const cfAuth = useCfAuthLogin()
const cfAuthEnabled = cfAuth.enabled
const cfAuthLoading = cfAuth.loading

/**
 * 跳转 cf-auth 前持久化 pendingJoin（OAuth 卸掉 Vue 状态）。
 * 回调页写入 lottery_registered_token 后回到本页，onMounted 自动 verify-join。
 * 跳转前校验 password/invite：空凭证跨 OAuth 回来仍会 400，浪费往返。
 */
async function handleCfAuthJoin() {
  try {
    const ret = window.location.pathname + window.location.search
    const drawId = pendingJoinDrawId.value || props.id || ''
    const draw =
      draws.value.find((d) => d.id === drawId || d.publicSlug === drawId) || null
    if (draw && !isDrawJoinable(draw)) {
      const msg = joinDisabledText(draw)
      loginError.value = msg
      showToast(msg, 'error')
      return
    }
    const missing = missingJoinCredentialForMode({
      participationMode: draw?.participationMode,
      accessPassword: joinAccessPassword.value,
      inviteCode: joinInviteCode.value,
    })
    if (missing === 'password') {
      const msg = t('lottery.accessPasswordRequired')
      loginError.value = msg
      showToast(msg, 'error')
      return
    }
    if (missing === 'invite') {
      const msg = t('lottery.inviteCodeRequired')
      loginError.value = msg
      showToast(msg, 'error')
      return
    }
    await cfAuth.login({
      returnTo: ret || '/lottery',
      pendingJoin: drawId
        ? {
            drawId,
            accessPassword: joinAccessPassword.value || undefined,
            inviteCode: joinInviteCode.value || undefined,
            refCode: routeParam('ref') || undefined,
            returnPath: ret || undefined,
          }
        : undefined,
    })
  } catch (err) {
    showToast(err instanceof Error ? err.message : t('lottery.joinFailed'), 'error')
  }
}

const props = defineProps<{ id?: string }>()
const route = useRoute()

/** 深链 /lottery/:id 时只展示单活动 */
const isDeepLinked = computed(() => Boolean(props.id && String(props.id).trim()))

const API_BASE = '/api'
const LOTTERY_PAYMENT_SESSION_KEY = 'lottery_payment_session_v1'

const loading = ref(true)
const fetchError = ref('')
const recordsLoading = ref(false)
const draws = ref<LotteryDraw[]>([])
const expandedId = ref<string | null>(null)
const flashSaleMerchByDrawId = computed<Record<string, FlashSaleMerchCard>>(() => {
  const map: Record<string, FlashSaleMerchCard> = {}
  for (const draw of draws.value) {
    const card = buildFlashSaleMerchCard(draw, formatPaymentAmount)
    if (card) map[draw.id] = card
  }
  return map
})
const flashSalePurchaseSummaryByDrawId = computed<Record<string, FlashSalePurchaseSummary>>(() => {
  const map: Record<string, FlashSalePurchaseSummary> = {}
  for (const draw of draws.value) {
    const summary = buildFlashSalePurchaseSummary(draw, flashSaleQuantityFor(draw), formatPaymentAmount)
    if (summary) map[draw.id] = summary
  }
  return map
})
/** 参与会话邮箱：刷新后仍可查结果（sessionStorage，非 localStorage，避免长期污染） */
const sessionEmail = ref(
  typeof sessionStorage !== 'undefined'
    ? sessionStorage.getItem(LOTTERY_SESSION_EMAIL_KEY) || ''
    : '',
)
/**
 * registered 模式：已登录用户的 JWT token。
 * 存 sessionStorage（会话级）：刷新页面不丢、关闭标签页自动清除；
 * 与后台 admin_token（localStorage）隔离，避免参与登录态污染管理后台入口。
 */
const registeredToken = ref(
  typeof sessionStorage !== 'undefined'
    ? sessionStorage.getItem(LOTTERY_REGISTERED_TOKEN_KEY) || ''
    : '',
)
/** registered 模式：已登录用户名（展示用，随 token 一起会话级持久化） */
const registeredUsername = ref(
  typeof sessionStorage !== 'undefined'
    ? sessionStorage.getItem(LOTTERY_REGISTERED_USERNAME_KEY) || ''
    : '',
)
/** registered 模式登录表单 */
const regLoginUsername = ref('')
const regLoginPassword = ref('')
const regLoginLoading = ref(false)
/** 密码模式：活动访问密码（与登录密码无关） */
const joinAccessPassword = ref('')
/** 邀请码模式：活动邀请码 */
const joinInviteCode = ref('')
/**
 * 登录弹窗意图：
 * - join：参与发码 / verify-join
 * - spin：已参与 instant 弱会话补 OTP，验证后直接 spin（不走 join）
 * - login：仅登录看记录
 */
const loginModalIntent = ref<LoginModalIntent>('join')

/** 当前登录弹窗对应的活动是否是 registered 模式 */
const isRegisteredJoin = computed(() => {
  if (!pendingJoinDrawId.value || loginModalIntent.value === 'spin') return false
  const draw = draws.value.find(d => d.id === pendingJoinDrawId.value)
  return draw?.participationMode === 'registered'
})
/** instant 弱会话补码：标题/主按钮与 join 分流 */
const isSpinAuth = computed(() => isSpinAuthModal(loginModalIntent.value, Boolean(pendingJoinDrawId.value)))
const pendingJoinDraw = computed(() => {
  if (!pendingJoinDrawId.value) return null
  return draws.value.find(d => d.id === pendingJoinDrawId.value) || null
})
const pendingJoinNeedsPassword = computed(() =>
  loginModalIntent.value === 'join' && pendingJoinDraw.value?.participationMode === 'password',
)
const pendingJoinNeedsInvite = computed(() =>
  loginModalIntent.value === 'join' && pendingJoinDraw.value?.participationMode === 'invite_code',
)
/**
 * 已有参与 JWT，只差活动密码/邀请码：弹窗不走邮箱 OTP（docs/096）。
 * roster/open 有 JWT 时通常不会进弹窗（直参）。
 */
const pendingJoinCredentialOnly = computed(() => {
  if (loginModalIntent.value !== 'join') return false
  if (!pendingJoinDrawId.value || !registeredToken.value) return false
  return pendingJoinNeedsPassword.value || pendingJoinNeedsInvite.value
})
/** 仅登录查看记录（无具体活动，不需要验证码） */
const isLoginOnly = computed(() => !pendingJoinDrawId.value || loginModalIntent.value === 'login')

const loginModalTitle = computed(() => {
  if (isRegisteredJoin.value) return t('lottery.loginAndJoin')
  if (isSpinAuth.value) return t('lottery.spinVerifyTitle')
  return t('lottery.emailVerify')
})
const loginModalHint = computed(() => {
  if (isRegisteredJoin.value) return t('lottery.registeredRequired')
  if (isSpinAuth.value) return t('lottery.spinVerifyHint')
  if (isLoginOnly.value) return t('lottery.loginToViewRecords')
  return t('lottery.emailVerifyHint')
})

function persistSessionEmail(email: string) {
  sessionEmail.value = persistLotterySessionEmail(sessionStorage, email)
}

/**
 * 参与成功后氛围动画时长（ms）：先让用户看见游戏反馈，再出结果弹窗，避免遮罩盖住转盘/滚轮。
 * 时长与组件内 celebrate 动画大致对齐；无长动画的体验立即弹窗。动画仍不表示开奖结果。
 */
function ambienceMsForDraw(drawId: string): number {
  const draw = draws.value.find((d) => d.id === drawId)
  return ambienceMsForExperience(draw?.experienceType, draw?.participationMode)
}

function usesWheelAnimation(draw: LotteryDraw | null | undefined): boolean {
  return (draw?.experienceType || defaultExperienceForParticipation(draw?.participationMode || 'open')) === 'wheel'
}

/** 清除待展示的结果弹窗定时器（新成功 / 卸载） */
function clearResultModalTimer() {
  if (resultModalTimer != null) {
    clearTimeout(resultModalTimer)
    resultModalTimer = null
  }
}

/**
 * 统一参与成功收尾：写已参与态、结果弹窗、事件；避免 access-code 直通 / verify-join / registered 三处行为不一致。
 */
/**
 * 标记本活动已参与，并写入「当次会话」记录行 + sessionStorage 提示（docs/097/098）。
 * 无 JWT 的 open OTP 路径刷新后依赖 hints 回填 myJoinedById，避免再点参与变 409。
 */
function markDrawJoined(
  joinedDrawId: string,
  extra?: {
    joinedAt?: string
    drawName?: string
    drawStatus?: string
    entryId?: string
    won?: boolean
    activityKind?: string
  },
) {
  const draw =
    draws.value.find((d) => d.id === joinedDrawId || d.publicSlug === joinedDrawId) || null
  const key = draw?.id || joinedDrawId
  // id / slug / 入参三键，模板多看 draw.id（docs/098）
  const joinedMap: Record<string, true> = { ...myJoinedById.value, [joinedDrawId]: true, [key]: true }
  if (draw?.publicSlug) joinedMap[draw.publicSlug] = true
  myJoinedById.value = joinedMap
  const activityKind =
    extra?.activityKind || draw?.activityKind || undefined
  // 再次 mark（如 409 已参与）时保留已有 entryId，避免裂变面板丢失归因身份
  const prev = myEntryList.value.find((r) => r.drawId === key || r.drawId === joinedDrawId)
  const entryId = extra?.entryId || prev?.entryId
  const row: MyEntry = {
    drawId: key,
    joinedAt: extra?.joinedAt || prev?.joinedAt || new Date().toISOString(),
    drawName: extra?.drawName || prev?.drawName || draw?.name || draw?.title || key,
    drawStatus: extra?.drawStatus || prev?.drawStatus || draw?.status,
    activityKind: activityKind || prev?.activityKind,
    entryId,
  }
  const rest = myEntryList.value.filter((r) => r.drawId !== key && r.drawId !== joinedDrawId)
  myEntryList.value = [row, ...rest]
  // 本机提示：无密码学意义；退出登录时 clearJoinedHints（business-session）
  upsertJoinedHint(
    sessionStorage,
    [key, joinedDrawId, draw?.publicSlug || '', props.id || ''],
    {
      drawId: key,
      entryId: row.entryId,
      joinedAt: row.joinedAt,
      drawName: row.drawName,
      drawStatus: row.drawStatus,
      activityKind: row.activityKind,
      won: extra?.won,
    },
  )
}

/**
 * 后端「已参与」/409：标 joined + 友好提示，可选打开查结果（勿当 joinFailed）。
 * 若响应带 entryId（docs/110），立即写入 hints，公开卡可生成 ?ref= 专属链接。
 */
function handleAlreadyJoined(
  joinedDrawId: string,
  opts?: { openResult?: boolean; entryId?: string },
) {
  const draw =
    draws.value.find((d) => d.id === joinedDrawId || d.publicSlug === joinedDrawId) || null
  markDrawJoined(joinedDrawId, { entryId: opts?.entryId })
  refreshDrawDetailFor(joinedDrawId)
  if (opts?.entryId) {
    rememberJoinSuccess(joinedDrawId, opts.entryId)
  }
  closeLogin()
  showToast(t('lottery.alreadyJoinedHint'), 'success')
  if (draw && isDirectPaymentDraw(draw)) {
    if (opts?.entryId) {
      const email = String(sessionEmail.value || '').trim().toLowerCase()
      if (email) {
        void showPaymentOrder(draw, opts.entryId, email)
      } else {
        showPaymentResumeError(draw, opts.entryId, email)
      }
      return
    }
    resumePaymentFromDraw(draw)
    return
  }
  if (opts?.openResult !== false) {
    if (draw) openMyResult(draw)
  }
}

/**
 * 公开 API 路径用 slug：优先 publicSlug，否则 id（深链 props 多为 slug）。
 * 纯函数在 joined-session；此处闭包 draws。
 */
function publicDrawPathKey(drawId: string): string {
  return resolvePublicDrawPathKey(drawId, draws.value)
}

function isDrawAlreadyMarkedJoined(drawId: string): boolean {
  const draw = draws.value.find((d) => d.id === drawId || d.publicSlug === drawId)
  return Boolean(
    myJoinedById.value[drawId] ||
    myJoinedById.value[draw?.id || ''] ||
    myJoinedById.value[draw?.publicSlug || ''],
  )
}

function completeJoinSuccess(
  joinedDrawId: string,
  data: {
    entryId?: string
    outcome?: ActivityOutcome
    activityKind?: string
    resultMode?: string
    spinsLeft?: number
    maxSpinsPerEntry?: number
  },
  opts?: { email?: string },
) {
  if (opts?.email) persistSessionEmail(opts.email)
  const wasJoined = isDrawAlreadyMarkedJoined(joinedDrawId)
  markDrawJoined(joinedDrawId, {
    entryId: data.entryId,
    activityKind: data.activityKind,
    // 抽奖中奖靠 my-result.won；outcome.status 多为 assigned/waitlisted，勿当「已中奖」
    won: data.outcome?.status === 'won',
  })
  if (!wasJoined) bumpParticipantCount(joinedDrawId)
  refreshDrawDetailFor(joinedDrawId)
  if (data.outcome) {
    myOutcomeById.value = { ...myOutcomeById.value, [joinedDrawId]: data.outcome }
  }
  // instant：join 只发次数，不抽奖；记录 left 供再抽 CTA
  const draw = draws.value.find((d) => d.id === joinedDrawId || d.publicSlug === joinedDrawId)
  if (isInstantLottery({ activityKind: data.activityKind || draw?.activityKind, resultMode: data.resultMode || draw?.resultMode })) {
    const left =
      data.spinsLeft != null
        ? Number(data.spinsLeft)
        : Math.max(1, Number(data.maxSpinsPerEntry || draw?.maxSpinsPerEntry || 1))
    // 产品默认 initial=1：join 后至少 1 次可 spin（若后端未回传 spinsLeft）
    spinsLeftById.value = { ...spinsLeftById.value, [joinedDrawId]: left }
    // instant：join 成功不播随机氛围（避免「转完却没结果」）；直接 toast 引导 spin
    showToast(t('lottery.joinSuccessInstant'), 'success')
    closeLogin()
    joinAccessPassword.value = ''
    joinInviteCode.value = ''
    void recordActivityEvent(joinedDrawId, 'participation_completed', {
      activityKind: data.activityKind || '',
      outcomeStatus: data.outcome?.status || '',
    })
    rememberJoinSuccess(joinedDrawId, data.entryId, {
      outcomeLabel: data.outcome?.resultLabel,
      resultMode: data.resultMode || 'instant',
    })
    return
  }
  void recordActivityEvent(joinedDrawId, 'participation_completed', {
    activityKind: data.activityKind || '',
    outcomeStatus: data.outcome?.status || '',
  })
  rememberJoinSuccess(joinedDrawId, data.entryId, {
    outcomeLabel: data.outcome?.resultLabel,
    resultMode: data.resultMode,
  })
  if (draw && isDirectPaymentDraw(draw)) {
    const entryId = data.entryId || resolveViralEntryId(draw)
    const email = String(opts?.email || sessionEmail.value || '').trim().toLowerCase()
    if (entryId && email) {
      void showPaymentOrder(draw, entryId, email)
      return
    }
    showPaymentResumeError(draw, entryId, email)
    return
  }
  // delayed：先触发氛围（转盘/老虎机等），再延迟结果弹窗；动画不表示开奖结果
  targetSectorById.value = { ...targetSectorById.value, [joinedDrawId]: null }
  celebrateKeyById.value = {
    ...celebrateKeyById.value,
    [joinedDrawId]: (celebrateKeyById.value[joinedDrawId] || 0) + 1,
  }
  closeLogin()
  joinAccessPassword.value = ''
  joinInviteCode.value = ''
  const isWheel = usesWheelAnimation(draw)
  if (isWheel) {
    pendingAnimationById.value = {
      ...pendingAnimationById.value,
      [joinedDrawId]: { kind: 'join', outcomeLabel: data.outcome?.resultLabel },
    }
  }
  // 延迟出弹窗：让 celebrate 动效可见；短路径（submit/form）仍立即展示
  clearResultModalTimer()
  const delayMs = ambienceMsForDraw(joinedDrawId)
  if (isWheel) {
    // WheelGame 在动画结束时回调，避免提示早于视觉反馈。
    return
  }
  if (delayMs <= 0) {
    showResult.value = true
  } else {
    showToast(
      data.outcome?.resultLabel
        ? t('lottery.joinSuccessWithOutcome', { outcome: data.outcome.resultLabel })
        : t('lottery.joinSuccess'),
    )
    resultModalTimer = setTimeout(() => {
      resultModalTimer = null
      showResult.value = true
    }, delayMs)
  }
}

/**
 * instant spin：先请求服务端，成功后再 celebrate + 停扇（docs/116）。
 * 身份：业务 JWT 免 OTP；弱会话需 email+OTP（intent=spin 弹窗，不走 join）。
 * 门禁纯函数：resolveInstantSpinClientGate（禁止假一键）。
 */
async function handleInstantSpin(draw: LotteryDraw, opts?: { codeOverride?: string }) {
  if (spinningId.value || joiningId.value) return

  const token = registeredToken.value
  const email = String(sessionEmail.value || loginEmail.value || '').trim().toLowerCase()
  const codeOverride = String(opts?.codeOverride || '').trim()
  const otpCode =
    codeOverride ||
    (!token && draw.participationMode !== 'registered' ? loginCode.value.trim() : '')

  const gate = resolveInstantSpinClientGate({
    isInstant: isInstantLottery(draw),
    status: draw.status,
    spinsLeft: spinsLeftById.value[draw.id],
    participationMode: draw.participationMode,
    hasBearer: Boolean(token),
    sessionEmail: email,
    otpCode,
  })
  if (gate.action === 'noop') return
  if (gate.action === 'exhausted') {
    showToast(t('lottery.spinsExhausted'), 'error')
    openMyResult(draw)
    return
  }
  if (gate.action === 'open_login') {
    openLogin(draw.id, gate.intent)
    if (gate.reason === 'no_session') showToast(t('lottery.spinNeedSession'), 'error')
    if (gate.reason === 'need_otp') showToast(t('lottery.spinNeedCode'), 'error')
    return
  }

  const slug = publicDrawPathKey(draw.id)
  if (!slug) {
    showToast(t('lottery.drawNotLoaded'), 'error')
    return
  }

  spinningId.value = draw.id
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    }
    if (gate.withBearer && token) headers.Authorization = `Bearer ${token}`

    const body: Record<string, string> = { ...gate.body }

    const res = await fetch(`${API_BASE}/public/draws/${encodeURIComponent(slug)}/spin`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const data = (await res.json()) as any
    if (!data.ok) {
      showToast(data.message || t('lottery.spinFailed'), 'error')
      if (res.status === 409) {
        spinsLeftById.value = { ...spinsLeftById.value, [draw.id]: 0 }
      }
      // 验证码失效：保持 spin 弹窗，让用户重发
      if (res.status === 400 && !token) {
        loginError.value = data.message || t('lottery.spinFailed')
        if (!showLoginModal.value) openLogin(draw.id, 'spin')
      }
      return
    }

    // spin 成功：清 OTP、关弹窗，保留邮箱会话
    if (otpCode) {
      loginCode.value = ''
      codeSent.value = false
    }
    if (email && email.includes('@')) persistSessionEmail(email)
    if (showLoginModal.value && loginModalIntent.value === 'spin') closeLogin()

    const prizeIndex = Number(data.prizeIndex)
    const won = Boolean(data.won)
    const left = Number(data.spinsLeft)
    if (Number.isFinite(left)) {
      spinsLeftById.value = { ...spinsLeftById.value, [draw.id]: left }
    }
    if (won) {
      myWonById.value = { ...myWonById.value, [draw.id]: true }
    }

    // 先 spin 成功 → 再停扇：中奖对准服务端 prizeIndex；未中奖固定停“谢谢参与”。
    const targetSector = won && Number.isFinite(prizeIndex) && prizeIndex >= 0
      ? prizeIndex
      : usesWheelAnimation(draw)
        ? gamePrizesFor(draw).length - 1
        : null
    targetSectorById.value = {
      ...targetSectorById.value,
      [draw.id]: targetSector,
    }
    celebrateKeyById.value = {
      ...celebrateKeyById.value,
      [draw.id]: (celebrateKeyById.value[draw.id] || 0) + 1,
    }

    rememberJoinSuccess(draw.id, data.entryId, {
      resultMode: 'instant',
      outcomeLabel: won ? (data.prizeName || data.tierName || t('lottery.won')) : t('lottery.thanksForParticipating'),
    })

    const isWheel = usesWheelAnimation(draw)
    if (isWheel) {
      pendingAnimationById.value = {
        ...pendingAnimationById.value,
        [draw.id]: { kind: 'spin', won, prizeName: data.prizeName || data.tierName || '' },
      }
    } else {
      showToast(
        won
          ? t('lottery.spinWon', { prize: data.prizeName || data.tierName || '' })
          : t('lottery.spinMiss'),
        won ? 'success' : 'info',
      )
    }

    // 延迟打开查结果弹窗（带 spins/wins）
    clearResultModalTimer()
    if (isWheel) return
    resultModalTimer = setTimeout(() => {
      resultModalTimer = null
      openMyResult(draw)
      if (registeredToken.value || sessionEmail.value) {
        void queryMyResult()
      }
    }, 2800)
  } catch {
    showToast(t('lottery.networkError'), 'error')
  } finally {
    if (spinningId.value === draw.id) spinningId.value = ''
  }
}

function handleGameAnimationComplete(draw: LotteryDraw) {
  const pending = pendingAnimationById.value[draw.id]
  if (!pending) return

  const next = { ...pendingAnimationById.value }
  delete next[draw.id]
  pendingAnimationById.value = next

  if (pending.kind === 'join') {
    showToast(
      pending.outcomeLabel
        ? t('lottery.joinSuccessWithOutcome', { outcome: pending.outcomeLabel })
        : t('lottery.joinSuccess'),
    )
    showResult.value = true
    return
  }

  showToast(
    pending.won
      ? t('lottery.spinWon', { prize: pending.prizeName || '' })
      : t('lottery.spinMiss'),
    pending.won ? 'success' : 'info',
  )
  openMyResult(draw)
  if (registeredToken.value || sessionEmail.value) void queryMyResult()
}
/**
 * docs/084：业务 JWT = 强会话（registered / open+JWT 免 OTP，可一键查）。
 * docs/106：仅 sessionEmail = 弱会话——只能预填邮箱 + 发码，禁止无码一键（后端必 400）。
 */
const myResultHasStrongSession = computed(() => Boolean(registeredToken.value))
/** OTP 表单上：邮箱已由会话预填时展示说明（非一键查询） */
const myResultEmailPrefillHint = computed(() => {
  if (myResultHasStrongSession.value) return ''
  const email = String(myResultEmail.value || sessionEmail.value || '')
    .trim()
    .toLowerCase()
  return email.includes('@') ? email : ''
})

/** 头部标题：单活动模式用活动名，多活动模式用默认标题 */
const drawTitle = computed(() => {
  const d = draws.value[0]
  if (d && (draws.value.length === 1 || isDeepLinked.value)) {
    return d.name || d.title || t('lottery.title')
  }
  return t('lottery.title')
})
/**
 * 状态精简文案（角标）。
 * drawing 按 activityKind 中性化，避免接龙/问卷显示「开奖中」（docs/106）。
 */
function statusText(draw: LotteryDraw | string) {
  if (typeof draw === 'string') {
    const key = publicStatusTagI18nKey(draw)
    return key ? t(`lottery.${key}`) : draw
  }
  const key = publicStatusTagI18nKey(draw.status, draw.activityKind)
  return key ? t(`lottery.${key}`) : draw.status
}

/** 深链始终展开；非深链按 expandedId */
function isCardExpanded(drawId: string) {
  if (isDeepLinked.value) return true
  return expandedId.value === drawId
}

/** 活动说明（公开接口可能给 description） */
function drawDescription(draw: LotteryDraw) {
  return String(draw.description || '').trim()
}

/**
 * 结果模式短标签：让用户知道「参与后是否马上出结果」。
 * 不推导 experience / participation；scheduled/manual 用中性「出结果」（docs/106）。
 */
function resultModeLabel(draw: LotteryDraw) {
  const key = resultModeTagI18nKey(draw.resultMode)
  return key ? t(`lottery.${key}`) : ''
}

function joinWindowReason(draw: LotteryDraw): '' | 'not_started' | 'ended' | 'status' {
  const serverReason = String(draw.joinDisabledReason || '').trim()
  if (serverReason === 'not_started' || serverReason === 'ended' || serverReason === 'status') {
    return serverReason
  }
  if (draw.status !== 'open') return 'status'
  const now = nowMs.value
  const start = new Date(draw.startAt || draw.startTime || '').getTime()
  const end = new Date(draw.endAt || draw.endTime || '').getTime()
  if (Number.isFinite(start) && now < start) return 'not_started'
  if (Number.isFinite(end) && now > end) return 'ended'
  return ''
}

function isDrawJoinable(draw: LotteryDraw): boolean {
  if (draw.canJoin === false) return false
  return joinWindowReason(draw) === ''
}

function joinDisabledText(draw: LotteryDraw): string {
  const reason = joinWindowReason(draw)
  if (reason === 'not_started') {
    // 未开始时优先展示实时倒计时，提升秒杀转化（docs/202 3.4）
    const countdown = notStartedCountdownText(draw)
    return countdown
      ? t('lottery.statusHintNotStartedCountdown', { countdown })
      : t('lottery.statusHintNotStarted', { time: formatTime(draw.startAt || draw.startTime || '') })
  }
  if (reason === 'ended') {
    return t('lottery.statusHintEndedByTime', { time: formatTime(draw.endAt || draw.endTime || '') })
  }
  if (String(draw.joinDisabledMessage || '').trim()) return String(draw.joinDisabledMessage).trim()
  // 兜底只返回状态短文案，避免异常 joinDisabledReason 与 status=open 组合时
  // joinDisabledText() 和 statusPathHint() 相互调用形成递归。
  return statusText(draw)
}

/** 未开始活动的实时倒计时文案（docs/202 3.4）；nowMs 每秒刷新驱动重渲染 */
function notStartedCountdownText(draw: LotteryDraw): string {
  const start = new Date(draw.startAt || draw.startTime || '').getTime()
  if (!Number.isFinite(start) || start <= nowMs.value) return ''
  const totalSec = Math.max(0, Math.floor((start - nowMs.value) / 1000))
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  const secs = totalSec % 60
  if (days > 0) return t('lottery.countdownDays', { days, hours, mins })
  if (hours > 0) return t('lottery.countdownHours', { hours, mins, secs })
  if (mins > 0) return t('lottery.countdownMinSec', { mins, secs })
  return t('lottery.countdownSeconds', { secs })
}

/**
 * 状态路径提示：主 CTA 旁用完整句子，避免只显示「已结束」等单词。
 * docs/076：draft/paused 说明「为何不能参与 + 下一步」。
 */
function statusPathHint(draw: LotteryDraw) {
  // 已参与 + open：按 result_mode 诚实分支（非抽奖勿写「等开奖」）
  if (isDrawJoined(draw) && draw.status === 'open') {
    return t(`lottery.${joinedOpenStatusHintKey(draw.resultMode)}`)
  }
  // drawn / drawing：抽奖族可说开奖；其它玩法中性（docs/104 / docs/105）
  if (draw.status === 'drawn') {
    return t(`lottery.${statusHintDrawnI18nKey(draw.activityKind)}`)
  }
  if (draw.status === 'drawing') {
    return t(`lottery.${statusHintDrawingI18nKey(draw.activityKind)}`)
  }
  const joinReason = joinWindowReason(draw)
  if (draw.status === 'open' && joinReason) return joinDisabledText(draw)
  const key = ({
    draft: 'lottery.statusHintDraft',
    open: '',
    paused: 'lottery.statusHintPaused',
    cancelled: 'lottery.statusHintCancelled',
  } as Record<string, string>)[draw.status]
  return key ? t(key) : ''
}

function isDrawJoined(draw: LotteryDraw): boolean {
  const joined = Boolean(myJoinedById.value[draw.id] || myJoinedById.value[draw.publicSlug || ''])
  if (!joined) return false
  // checkin 活动（每日签到）：joined 状态按「今天是否已签」判断——
  // 昨天/更早签过今天仍可再签（后端 identity 带日期后缀，每日一签），
  // 若沿用布尔快照会把「可再签」误显示为「已参与」导致无法再次签到。
  if (draw.activityKind === 'checkin') {
    const entry = myEntryList.value.find((r) => r.drawId === draw.id || r.drawId === draw.publicSlug)
    if (!isCheckinSignedToday(draw.activityKind, entry?.joinedAt)) return false
  }
  return joined
}

function nonOpenPrimaryCta(draw: LotteryDraw) {
  return publicNonOpenPrimaryCta({
    status: draw.status,
    joined: isDrawJoined(draw),
    hasSession: Boolean(sessionEmail.value || registeredUsername.value),
  })
}

function nonOpenSecondaryCta(draw: LotteryDraw) {
  return publicNonOpenSecondaryCta(draw.status)
}

/** 参与时间 */
const joinedTimeText = (draw: any): string => {
  const e = sortedMyEntries.value.find((r: any) => r.drawId === draw.id)
  return e?.joinedAt ? formatTime(e.joinedAt) : ''
}

const myJoinedById = ref<Record<string, true>>({})
const myWonById = ref<Record<string, any>>({})
const myOutcomeById = ref<Record<string, ActivityOutcome>>({})
const myEntryList = ref<MyEntry[]>([])
const submissionDrafts = ref<Record<string, { optionId: string; fields: Record<string, any> }>>({})

/** 中奖优先，再按参与时间新→旧 */
const sortedMyEntries = computed(() => {
  const won = new Set(Object.keys(myWonById.value));
  return [...myEntryList.value].sort((a, b) => {
    const aWon = won.has(a.drawId) ? 1 : 0;
    const bWon = won.has(b.drawId) ? 1 : 0;
    if (aWon !== bWon) return bWon - aWon;
    return (b.joinedAt || '').localeCompare(a.joinedAt || '');
  });
});

const joiningId = ref('')
/** instant spin 请求中（与 join 锁分离，避免互相覆盖） */
const spinningId = ref('')
/**
 * 游戏氛围触发器：参与/spin 成功后对该 drawId 递增。
 * Wheel/Slot/Grid 等 watch celebrateKey 再播动画，避免「未验证先转盘」。
 */
const celebrateKeyById = ref<Record<string, number>>({})
type PendingAnimation =
  | { kind: 'join'; outcomeLabel?: string }
  | { kind: 'spin'; won: boolean; prizeName?: string }
/** 大转盘在动画结束前暂存反馈，避免 toast/弹窗早于转盘停稳。 */
const pendingAnimationById = ref<Record<string, PendingAnimation>>({})
/** instant：spin 成功后的停扇索引（与 celebrateKey 同步） */
const targetSectorById = ref<Record<string, number | null>>({})
/** instant：各活动剩余可抽次数（join/spin/my-result 回填） */
const spinsLeftById = ref<Record<string, number>>({})
/** 结果弹窗延迟展示定时器（先氛围后遮罩） */
let resultModalTimer: ReturnType<typeof setTimeout> | null = null
const showResult = ref(false)
/** 参与成功后暂存，供 GameResultModal：分享链接 + 结果语义分支 */
const lastJoinResult = ref<{
  drawId: string
  entryId: string
  resultMode?: string
  outcomeLabel?: string
  /** 参与时活动 status，用于开奖后隐藏邀请（docs/103） */
  drawStatus?: string
} | null>(null)
/** 直付秒杀支付弹窗状态 */
type PaymentState = PaymentSessionState & {
  prizeCode?: { code?: string | null; secret?: string | null } | null
  prizeCodes?: Array<{ code?: string | null; secret?: string | null }>
}

const showPaymentModal = ref(false)
const paymentLoading = ref(false)
const paymentError = ref('')
const paymentQrDataUrl = ref('')
const paymentQrSeq = ref(0)
/** 支付轮询最长持续时长：5 分钟未支付则停止轮询（docs/202 3.3） */
const PAYMENT_POLL_TIMEOUT_MS = 5 * 60 * 1000
let paymentPollTimer: ReturnType<typeof setInterval> | null = null
/** 支付轮询绝对截止时间戳：超过后停止轮询，避免无限请求（docs/202 3.3） */
let paymentPollDeadline = 0
const paymentState = ref<PaymentState | null>(null)
const paymentQrLoading = ref(false)
/** 支付中误关闭弹窗的二次确认开关（docs/202 3.1） */
const confirmPaymentClose = ref(false)
const flashSaleQuantityByDrawId = ref<Record<string, number>>({})
const publicSupportEmail = ref('')

/** lottery + resultMode=instant（实现见 instant-spin-ux） */
function isInstantLottery(draw: { activityKind?: string; resultMode?: string } | null | undefined): boolean {
  return isInstantLotteryDraw(draw)
}

/** 游戏区禁用：instant 已参与仍可 spin（有次数时） */
function gameDisabled(draw: LotteryDraw): boolean {
  if (!isDrawJoinable(draw)) return true
  // 直付批发的同一 entry 可在累计限购内追加新订单；单件直付仍保持已参与即禁用。
  if (isDirectPaymentDraw(draw) && isDrawJoined(draw)) {
    const purchaseState = flashSalePurchaseState(draw)
    if (
      purchaseState &&
      (
        purchaseState.remainingQuantity <= 0 ||
        purchaseState.latestOrderStatus === 'pending' ||
        purchaseState.latestOrderStatus === 'expired' ||
        purchaseState.latestOrderStatus === 'cancelled' ||
        purchaseState.latestOrderStatus === 'paid_fulfillment_failed' ||
        purchaseState.latestOrderStatus === 'paid_late_needs_refund'
      )
    ) {
      return true
    }
    return Number(draw.flashSale?.maxPerUser || 1) <= 1
  }
  return isPublicGameDisabled({
    status: draw.status,
    joined: isDrawJoined(draw),
    isInstant: isInstantLottery(draw),
    spinsLeft: spinsLeftById.value[draw.id],
    busy: joiningId.value === draw.id || spinningId.value === draw.id,
  })
}

function handleGamePlay(draw: LotteryDraw) {
  if (!isDrawJoinable(draw)) {
    showToast(joinDisabledText(draw), 'error')
    return
  }
  if (isDrawJoined(draw) && isDirectPaymentDraw(draw)) {
    void handleDirectPaymentAction(draw)
    return
  }
  if (isDrawJoined(draw) && isInstantLottery(draw)) {
    void handleInstantSpin(draw)
    return
  }
  void handleJoin(draw.id)
}

function flashSaleMerchCard(draw: LotteryDraw) {
  return flashSaleMerchByDrawId.value[draw.id] || null
}

function flashSalePurchaseSummary(draw: LotteryDraw) {
  return flashSalePurchaseSummaryByDrawId.value[draw.id] || null
}

type FlashSalePurchaseState = {
  purchasedQuantity: number
  remainingQuantity: number
  maxPerUser: number
  latestOrderStatus: string | null
}

const flashSalePurchaseStateByDrawId = ref<Record<string, FlashSalePurchaseState>>({})

function flashSalePurchaseState(draw: LotteryDraw): FlashSalePurchaseState | null {
  return flashSalePurchaseStateByDrawId.value[draw.id] || null
}

function flashSalePurchaseLimit(draw: LotteryDraw): number {
  const configuredMax = Math.max(1, Math.floor(Number(draw.flashSale?.maxPerUser || 1)))
  const summary = flashSalePurchaseState(draw)
  if (!isDrawJoined(draw) || !summary) return configuredMax
  return Math.min(configuredMax, Math.max(0, summary.remainingQuantity))
}

function flashSalePurchaseAvailability(draw: LotteryDraw): { purchased: number; remaining: number } | null {
  const summary = flashSalePurchaseState(draw)
  if (!summary) return null
  return { purchased: summary.purchasedQuantity, remaining: summary.remainingQuantity }
}

function shouldShowFlashSaleQuantityControl(draw: LotteryDraw): boolean {
  const purchaseState = flashSalePurchaseState(draw)
  const mustResumeExistingOrder =
    purchaseState?.latestOrderStatus === 'pending' ||
    purchaseState?.latestOrderStatus === 'expired' ||
    purchaseState?.latestOrderStatus === 'cancelled'
  return isDirectPaymentDraw(draw)
    && isDrawJoinable(draw)
    && !mustResumeExistingOrder
    && flashSalePurchaseLimit(draw) > 1
}

// ── 查询我的结果（中奖卡密/安慰奖券） ──
const showMyResultModal = ref(false)
const myResultDraw = ref<LotteryDraw | null>(null)
const myResultEmail = ref('')
const myResultCode = ref('')
const myResultLoading = ref(false)
const myResultSendingCode = ref(false)
const myResultCodeCooldown = ref(0)
let myResultCooldownTimer: ReturnType<typeof setInterval> | null = null
/** my-result 载荷：抽奖奖品 + 接龙 outcome + resultFamily（docs/100、docs/101） */
type MyResultPayload = {
  joined: boolean
  joinedAt?: string | null
  won: boolean
  activityKind?: string | null
  /** lottery | assignment | review | participation */
  resultFamily?: string | null
  drawStatus?: string | null
  resultMode?: string | null
  prizeCode: string | null
  prizeName?: string | null
  prizeType?: string | null
  prizeValueText?: string | null
  fulfillmentNote?: string | null
  tierName?: string | null
  consolationCoupon: string | null
  /** instant 多奖 */
  wins?: Array<{
    winnerId?: string
    spinId?: string | null
    tierName?: string | null
    prizeName?: string | null
    prizeCode?: string | null
    prizeType?: string | null
    prizeValueText?: string | null
    fulfillmentNote?: string | null
  }>
  spinsLeft?: number | null
  spinsUsed?: number | null
  maxSpinsPerEntry?: number | null
  outcome?: {
    id?: string
    outcomeType?: string
    status?: string
    sequenceNo?: number | null
    assignmentNo?: number | null
    resultLabel?: string
    decidedAt?: string | null
  } | null
}
const myResultData = ref<MyResultPayload | null>(null)
const myResultError = ref('')
/** my-result 当前是否 instant 活动 */
const isMyResultInstant = computed(() =>
  isInstantLottery({
    activityKind: myResultData.value?.activityKind || myResultDraw.value?.activityKind,
    resultMode: myResultData.value?.resultMode || myResultDraw.value?.resultMode,
  }),
)

/**
 * 结果族：优先 API resultFamily；缺省时用活动 activityKind 推断（兼容旧后端）。
 * 接龙绝不能落到 lottery 的「未抽中」分支。
 */
const myResultFamily = computed(() => {
  const fromApi = String(myResultData.value?.resultFamily || '').trim()
  if (fromApi) return fromApi
  const kind = String(
    myResultData.value?.activityKind || myResultDraw.value?.activityKind || 'lottery',
  ).trim()
  if (kind === 'lottery' || kind === 'claim') return 'lottery'
  if (kind === 'signup_chain' || kind === 'waitlist' || kind === 'reservation') return 'assignment'
  if (kind === 'approval') return 'review'
  return 'participation'
})

/** 仅抽奖族：活动是否已终态（可诚实说「未中奖」） */
const isMyResultDrawFinal = computed(() => {
  if (myResultFamily.value !== 'lottery') return false
  const st = String(myResultData.value?.drawStatus || myResultDraw.value?.status || '')
  return st === 'drawn' || st === 'cancelled'
})

/** 中奖结果里的「分享邀请」：开奖后隐藏（docs/103） */
const showMyResultInviteShare = computed(() => {
  const st = String(myResultData.value?.drawStatus || myResultDraw.value?.status || '')
  return shouldShowInviteShareCta(st)
})

function isManualFulfillmentPrize(prizeType: string | null | undefined): boolean {
  const t = String(prizeType || '').trim().toLowerCase()
  return t === 'manual_fulfillment' || t === 'manual'
}

/** 从最近参与的活动数据中提取 publicSlug，供 GameResultModal 调用 /share API */
const lastJoinDrawSlug = computed(() => {
  if (!lastJoinResult.value) return undefined
  const draw = draws.value.find(d => d.id === lastJoinResult.value!.drawId)
  // docs/097：publicSlug 空时回退 drawId / 路由 slug，避免 /share 打到 undefined
  return draw?.publicSlug || draw?.id || lastJoinResult.value.drawId || undefined
})

/** 公开活动 promotionConfig.viral（API 已解析对象） */
function getDrawViral(draw: LotteryDraw | null | undefined) {
  if (!draw?.promotionConfig) return undefined
  return draw.promotionConfig.viral
}

/**
 * 解析本场 entryId：优先当次参与成功快照，再 myEntryList / hints。
 * 无 entryId 时 ViralLeaderboard 仍可展示公开排行榜。
 */
function resolveViralEntryId(draw: LotteryDraw): string | undefined {
  if (
    lastJoinResult.value &&
    (lastJoinResult.value.drawId === draw.id || lastJoinResult.value.drawId === draw.publicSlug)
  ) {
    return lastJoinResult.value.entryId
  }
  const fromList = myEntryList.value.find(
    (r) => r.drawId === draw.id || r.drawId === draw.publicSlug,
  )
  if (fromList?.entryId) return fromList.entryId
  try {
    const hints = readJoinedHints(sessionStorage)
    const keys = [draw.id, draw.publicSlug || ''].filter(Boolean)
    for (const k of keys) {
      const h = hints[String(k).trim().toLowerCase()]
      if (h?.entryId) return h.entryId
    }
  } catch { /* ignore */ }
  return undefined
}

/** 从最近参与的活动数据中提取裂变配置 */
const lastJoinViralConfig = computed(() => {
  if (!lastJoinResult.value) return undefined
  const draw = draws.value.find(d => d.id === lastJoinResult.value!.drawId)
  return getDrawViral(draw)
})

/** 结果模式：优先用参与时快照，否则读当前活动（弹窗语义用） */
const lastJoinResultMode = computed(() => {
  if (!lastJoinResult.value) return undefined
  if (lastJoinResult.value.resultMode) return lastJoinResult.value.resultMode
  const draw = draws.value.find(d => d.id === lastJoinResult.value!.drawId)
  return draw?.resultMode
})

const lastJoinOutcomeLabel = computed(() => lastJoinResult.value?.outcomeLabel)

/** 参与时活动状态：供参与成功弹窗决定是否展示邀请（docs/103） */
const lastJoinDrawStatus = computed(() => {
  if (!lastJoinResult.value) return undefined
  if (lastJoinResult.value.drawStatus) return lastJoinResult.value.drawStatus
  const draw = draws.value.find(d => d.id === lastJoinResult.value!.drawId)
  return draw?.status
})

const paymentStatusText = computed(() => t(`lottery.${paymentStatusI18nKey(paymentState.value?.status)}`))
const paymentStatusIsPaid = computed(() => paymentState.value?.status === 'paid')
const paymentCanRetry = computed(() =>
  canRetryPaymentOrder(paymentState.value?.status) || paymentState.value?.status === 'unknown' || Boolean(paymentError.value),
)
const paymentCanRefresh = computed(() => shouldPollPaymentStatus(paymentState.value?.status))
const paymentAmountText = computed(() =>
  formatPaymentAmount(paymentState.value?.amountCents, paymentState.value?.currency),
)
const paymentCodeText = computed(() =>
  composePaymentCode(paymentState.value?.prizeCode || null),
)
const paymentCodes = computed(() => paymentState.value?.prizeCodes?.length
  ? paymentState.value.prizeCodes
  : (paymentState.value?.prizeCode ? [paymentState.value.prizeCode] : []))
// Provider 返回值仍经过前端白名单过滤，避免异常网关响应进入 href。
const paymentRedirectUrl = computed(() => asHttpPaymentUrl(paymentState.value?.redirectUrl))
const paymentQrFallbackUrl = computed(() => asHttpPaymentUrl(paymentState.value?.qrCode))
const paymentSupportSubject = computed(() => {
  const orderNo = paymentState.value?.orderNo || ''
  return orderNo ? `支付订单补发协助 ${orderNo}` : '支付订单补发协助'
})

function flashSaleQuantityFor(draw: LotteryDraw): number {
  const max = flashSalePurchaseLimit(draw)
  if (max < 1) return 1
  const current = Math.floor(Number(flashSaleQuantityByDrawId.value[draw.id] || 1))
  return Math.min(max, Math.max(1, current))
}

function onFlashSaleQuantityInput(draw: LotteryDraw, event: Event) {
  const raw = Number((event.target as HTMLInputElement | null)?.value || 1)
  const max = Math.max(1, flashSalePurchaseLimit(draw))
  const quantity = Number.isFinite(raw) ? Math.floor(raw) : 1
  flashSaleQuantityByDrawId.value = {
    ...flashSaleQuantityByDrawId.value,
    [draw.id]: Math.min(max, Math.max(1, quantity)),
  }
}

/** 批量购买 +/- 步进：夹在 [1, maxPerUser] 内（docs/202 3.5） */
function onFlashSaleQuantityChange(draw: LotteryDraw, change: number) {
  const max = Math.max(1, flashSalePurchaseLimit(draw))
  const next = Math.min(max, Math.max(1, flashSaleQuantityFor(draw) + change))
  flashSaleQuantityByDrawId.value = {
    ...flashSaleQuantityByDrawId.value,
    [draw.id]: next,
  }
}
const paymentTitle = computed(() => {
  if (paymentState.value?.status === 'paid_fulfillment_failed') return t('lottery.paymentFulfillmentFailedTitle')
  if (paymentState.value?.status === 'paid_late_needs_refund') return t('lottery.paymentLatePaidTitle')
  if (paymentState.value?.status === 'paid') return t('lottery.paymentPaidTitle')
  return t('lottery.paymentPendingTitle')
})
const paymentHint = computed(() => {
  if (!paymentState.value) return ''
  if (paymentState.value.status === 'paid') return t('lottery.paymentPaidHint')
  if (paymentState.value.status === 'paid_fulfillment_failed') return t('lottery.paymentFulfillmentFailedHint')
  if (paymentState.value.status === 'paid_late_needs_refund') return t('lottery.paymentLatePaidHint')
  if (paymentState.value.status === 'expired' || paymentState.value.status === 'cancelled') return t('lottery.paymentRetryHint')
  return t('lottery.paymentPendingHint')
})

function readPaymentSessionRaw(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage.getItem(LOTTERY_PAYMENT_SESSION_KEY)
  } catch {
    return null
  }
}

function writePaymentSessionRaw(raw: string | null) {
  if (typeof window === 'undefined') return
  try {
    if (raw) {
      window.sessionStorage.setItem(LOTTERY_PAYMENT_SESSION_KEY, raw)
    } else {
      window.sessionStorage.removeItem(LOTTERY_PAYMENT_SESSION_KEY)
    }
  } catch {
    // 浏览器禁用存储时不影响支付主链路；用户仍可通过订单号和后台查询完成补发。
  }
}

function persistPaymentSession(state: PaymentState | null = paymentState.value) {
  const snapshot = buildPaymentSessionSnapshot(state)
  writePaymentSessionRaw(snapshot ? JSON.stringify(snapshot) : null)
}

function clearPaymentSession() {
  writePaymentSessionRaw(null)
}

async function restorePaymentSession() {
  const snapshot = parsePaymentSessionSnapshot(readPaymentSessionRaw())
  if (!snapshot) {
    clearPaymentSession()
    return
  }
  const draw = draws.value.find((item) => item.id === snapshot.drawId || item.publicSlug === snapshot.drawId)
  if (!draw || !isDirectPaymentDraw(draw)) {
    clearPaymentSession()
    return
  }
  paymentState.value = {
    ...snapshot,
    prizeCode: null,
    prizeCodes: [],
  }
  showPaymentModal.value = true
  await syncPaymentQrCode(snapshot.qrCode)
  await refreshPaymentOrderStatus({ silent: true })
  if (shouldPollPaymentStatus(paymentState.value?.status)) {
    startPaymentPolling()
  }
}

async function loadPublicSupportConfig() {
  try {
    const res = await fetch(`${API_BASE}/system-config/system-config`, {
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (!res.ok) return
    const data = await res.json().catch(() => null) as { ok?: boolean; config?: Record<string, string> } | null
    const email = String(data?.config?.support_email || '').trim()
    publicSupportEmail.value = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
  } catch {
    publicSupportEmail.value = ''
  }
}

/** 参与成功后写入弹窗所需快照（语义字段可选，缺省由 computed 回退到 draw） */
function rememberJoinSuccess(
  drawId: string,
  entryId: string | undefined,
  extra?: { outcomeLabel?: string; resultMode?: string },
) {
  if (!entryId) return
  const draw = draws.value.find(d => d.id === drawId)
  lastJoinResult.value = {
    drawId,
    entryId,
    resultMode: extra?.resultMode || draw?.resultMode,
    outcomeLabel: extra?.outcomeLabel || undefined,
    drawStatus: draw?.status,
  }
}

function clearPaymentPollTimer() {
  if (paymentPollTimer) {
    clearInterval(paymentPollTimer)
    paymentPollTimer = null
  }
}

/** 支付中（pending）点击遮罩：弹出二次确认，防止误关丢支付入口（docs/202 3.1） */
function handlePaymentOverlayClick() {
  if (paymentState.value?.status === 'pending') {
    confirmPaymentClose.value = true
    return
  }
  hardClosePaymentModal()
}

/** 支付中（pending）点 ✕：弹出二次确认，防止误关丢支付入口（docs/202 3.1） */
function handlePaymentCloseClick() {
  if (paymentState.value?.status === 'pending') {
    confirmPaymentClose.value = true
    return
  }
  hardClosePaymentModal()
}

function hardClosePaymentModal() {
  showPaymentModal.value = false
  confirmPaymentClose.value = false
  clearPaymentPollTimer()
}

function closePaymentModal() {
  hardClosePaymentModal()
}

async function syncPaymentQrCode(qrCode?: string) {
  const raw = String(qrCode || '').trim()
  const seq = ++paymentQrSeq.value
  if (!raw) {
    paymentQrDataUrl.value = ''
    paymentQrLoading.value = false
    return
  }
  // 二维码异步生成期间显示加载态，避免空白区域（docs/202 3.6）
  paymentQrLoading.value = true
  try {
    const dataUrl = await QRCode.toDataURL(raw, {
      width: 240,
      margin: 1,
      errorCorrectionLevel: 'M',
    })
    if (seq === paymentQrSeq.value) {
      paymentQrDataUrl.value = dataUrl
      paymentQrLoading.value = false
    }
  } catch {
    if (seq === paymentQrSeq.value) {
      paymentQrDataUrl.value = ''
      paymentQrLoading.value = false
    }
  }
}

function buildPaymentEntryId(draw: LotteryDraw): string | undefined {
  return resolveViralEntryId(draw)
}

function showPaymentResumeError(draw: LotteryDraw, entryId: string | undefined, email: string) {
  paymentError.value = entryId ? t('lottery.paymentEmailMissing') : t('lottery.paymentEntryMissing')
  paymentState.value = {
    drawId: draw.id,
    entryId: entryId || '',
    email,
    orderNo: '',
    status: 'unknown',
    amountCents: Number(draw.flashSale?.priceCents || 0),
    quantity: flashSaleQuantityFor(draw),
    unitPriceCents: Number(draw.flashSale?.priceCents || 0),
    currency: String(draw.flashSale?.currency || 'cny'),
    provider: '',
    accessToken: '',
    prizeCode: null,
    prizeCodes: [],
  }
  showPaymentModal.value = true
}

function resumePaymentFromDraw(draw: LotteryDraw) {
  const entryId = buildPaymentEntryId(draw)
  const email = String(sessionEmail.value || '').trim().toLowerCase()
  if (!entryId || !email) {
    showPaymentResumeError(draw, entryId, email)
    return
  }
  void handleDirectPaymentAction(draw)
}

async function loadFlashSalePurchaseState(
  draw: LotteryDraw,
  entryId: string,
  email: string,
): Promise<FlashSalePurchaseState> {
  const slug = publicDrawPathKey(draw.id)
  if (!slug) throw new Error(t('lottery.drawNotLoaded'))

  const res = await fetch(`${API_BASE}/public/draws/${encodeURIComponent(slug)}/payment-orders/summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryId, email }),
  })
  const data = await res.json().catch(() => null) as {
    ok?: boolean
    message?: string
    purchasedQuantity?: number
    remainingQuantity?: number
    maxPerUser?: number
    latestOrderStatus?: string | null
  } | null
  if (!res.ok || !data?.ok) {
    throw new Error(data?.message || t('lottery.paymentQueryFailed'))
  }

  const state: FlashSalePurchaseState = {
    purchasedQuantity: Math.max(0, Math.floor(Number(data.purchasedQuantity || 0))),
    remainingQuantity: Math.max(0, Math.floor(Number(data.remainingQuantity || 0))),
    maxPerUser: Math.max(1, Math.floor(Number(data.maxPerUser || draw.flashSale?.maxPerUser || 1))),
    latestOrderStatus: data.latestOrderStatus ? String(data.latestOrderStatus) : null,
  }
  flashSalePurchaseStateByDrawId.value = {
    ...flashSalePurchaseStateByDrawId.value,
    [draw.id]: state,
  }
  const selectedQuantity = Math.floor(Number(flashSaleQuantityByDrawId.value[draw.id] || 1))
  if (state.remainingQuantity > 0 && selectedQuantity > state.remainingQuantity) {
    flashSaleQuantityByDrawId.value = {
      ...flashSaleQuantityByDrawId.value,
      [draw.id]: state.remainingQuantity,
    }
  }
  return state
}

async function handleDirectPaymentAction(draw: LotteryDraw) {
  const entryId = buildPaymentEntryId(draw)
  const email = String(sessionEmail.value || '').trim().toLowerCase()
  if (!entryId || !email) {
    showPaymentResumeError(draw, entryId, email)
    return
  }

  paymentLoading.value = true
  try {
    const summary = await loadFlashSalePurchaseState(draw, entryId, email)
    if (summary.latestOrderStatus === 'pending') {
      await showPaymentOrder(draw, entryId, email)
      return
    }
    if (summary.latestOrderStatus === 'paid_fulfillment_failed') {
      showToast(t('lottery.paymentFulfillmentFailed'), 'error')
      return
    }
    if (summary.latestOrderStatus === 'paid_late_needs_refund') {
      showToast(t('lottery.paymentLatePaid'), 'error')
      return
    }
    if (summary.remainingQuantity <= 0) {
      showToast(t('lottery.paymentPurchaseLimitReached'), 'error')
      return
    }
    await showPaymentOrder(draw, entryId, email)
  } catch (err) {
    showToast(err instanceof Error ? err.message : t('lottery.paymentQueryFailed'), 'error')
  } finally {
    paymentLoading.value = false
  }
}

async function refreshPaymentOrderStatus(opts?: { silent?: boolean }) {
  const state = paymentState.value
  if (!state) return
  const slug = publicDrawPathKey(state.drawId)
  if (!slug) return
  try {
    const requestInit = buildPublicDrawRequestInit()
    const res = await fetch(
      `${API_BASE}/public/draws/${encodeURIComponent(slug)}/payment-orders/${encodeURIComponent(state.orderNo)}`,
      {
        ...requestInit,
        headers: {
          ...(requestInit.headers || {}),
          Authorization: `Bearer ${state.accessToken}`,
        },
      },
    )
    const data = await res.json().catch(() => null) as {
      ok?: boolean
      message?: string
      order?: {
        orderNo?: string
        status?: string
        quantity?: number
        unitPriceCents?: number
        amountCents?: number
        currency?: string
        provider?: string
        paidAt?: string
        prizeCode?: { code?: string | null; secret?: string | null } | null
        prizeCodes?: Array<{ code?: string | null; secret?: string | null }>
      } | null
    } | null
    if (!data?.ok || !data.order) {
      if (!opts?.silent) {
        paymentError.value = data?.message || t('lottery.paymentQueryFailed')
      }
      return
    }

    paymentState.value = {
      ...state,
      status: String(data.order.status || state.status),
      quantity: Number(data.order.quantity || state.quantity || 1),
      unitPriceCents: Number(data.order.unitPriceCents || state.unitPriceCents || 0),
      amountCents: Number(data.order.amountCents || state.amountCents),
      currency: String(data.order.currency || state.currency),
      provider: String(data.order.provider || state.provider),
      prizeCode: data.order.prizeCode || state.prizeCode || null,
      prizeCodes: data.order.prizeCodes || state.prizeCodes || [],
    }
    persistPaymentSession(paymentState.value)

    if (data.order.status === 'paid') {
      clearPaymentPollTimer()
      showToast(t('lottery.paymentOrderPaid'), 'success')
    } else if (data.order.status === 'paid_fulfillment_failed') {
      clearPaymentPollTimer()
      showToast(t('lottery.paymentFulfillmentFailed'), 'error')
    } else if (data.order.status === 'paid_late_needs_refund') {
      clearPaymentPollTimer()
      showToast(t('lottery.paymentLatePaid'), 'error')
    } else if (!shouldPollPaymentStatus(data.order.status)) {
      clearPaymentPollTimer()
    }

    // 订单状态变化后，主页面的“是否可追加 / 还可购买多少”必须以服务端累计值为准。
    // 否则已创建订单时写入的 pending 本地状态会滞留，继续错误禁用批发追加入口。
    const paymentDraw = draws.value.find((draw) => draw.id === state.drawId)
    if (paymentDraw && state.entryId && state.email && data.order.status !== 'pending') {
      try {
        await loadFlashSalePurchaseState(paymentDraw, state.entryId, state.email)
      } catch {
        // 订单详情已成功刷新；摘要失败不覆盖用户当前可见的支付结果。
      }
    }

    await syncPaymentQrCode(state.qrCode)
    paymentError.value = ''
  } catch {
    if (!opts?.silent) {
      paymentError.value = t('lottery.networkError')
    }
  }
}

function handleRefreshPaymentStatus() {
  void refreshPaymentOrderStatus()
}

function startPaymentPolling() {
  clearPaymentPollTimer()
  if (!paymentState.value || !shouldPollPaymentStatus(paymentState.value.status)) return
  // 设置 5 分钟超时，避免无限轮询（docs/202 3.3）
  paymentPollDeadline = Date.now() + PAYMENT_POLL_TIMEOUT_MS
  paymentPollTimer = setInterval(() => {
    if (Date.now() > paymentPollDeadline) {
      clearPaymentPollTimer()
      return
    }
    void refreshPaymentOrderStatus({ silent: true })
  }, 3500)
}

async function showPaymentOrder(draw: LotteryDraw, entryId: string, email: string) {
  if (!isDirectPaymentDraw(draw) || !draw.flashSale) return
  const flashSale = draw.flashSale
  if (!entryId) {
    paymentError.value = t('lottery.paymentEntryMissing')
    showPaymentModal.value = true
    return
  }

  paymentLoading.value = true
  paymentError.value = ''
  const quantity = flashSaleQuantityFor(draw)
  try {
    const slug = publicDrawPathKey(draw.id)
    if (!slug) {
      throw new Error(t('lottery.drawNotLoaded'))
    }
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(slug) + '/payment-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 后端必须把支付请求邮箱与 entry 身份绑定，不能只凭前端可恢复的 entryId 下单。
      body: JSON.stringify({ entryId, email, quantity }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      message?: string
      orderNo?: string
      status?: string
      quantity?: number
      unitPriceCents?: number
      amountCents?: number
      currency?: string
      provider?: string
      accessToken?: string
      redirectUrl?: string
      qrCode?: string
    }
    if (!data.ok || !data.orderNo) {
      throw new Error(data.message || t('lottery.paymentCreateFailed'))
    }

    paymentState.value = {
      drawId: draw.id,
      entryId,
      email,
      orderNo: data.orderNo,
      status: String(data.status || 'pending'),
      quantity: Number(data.quantity || quantity),
      unitPriceCents: Number(data.unitPriceCents || flashSale.priceCents || 0),
      amountCents: Number(data.amountCents || flashSale.priceCents || 0),
      currency: String(data.currency || flashSale.currency || 'cny'),
      provider: String(data.provider || ''),
      accessToken: String(data.accessToken || ''),
      redirectUrl: data.redirectUrl || undefined,
      qrCode: data.qrCode || undefined,
      prizeCode: null,
      prizeCodes: [],
    }
    // 新单创建后立刻标记为在途，避免用户在轮询/支付回跳前再次触发一笔订单。
    flashSalePurchaseStateByDrawId.value = {
      ...flashSalePurchaseStateByDrawId.value,
      [draw.id]: {
        purchasedQuantity: flashSalePurchaseState(draw)?.purchasedQuantity || 0,
        remainingQuantity: flashSalePurchaseState(draw)?.remainingQuantity ??
          Math.max(0, Math.floor(Number(draw.flashSale?.maxPerUser || 1))),
        maxPerUser: flashSalePurchaseState(draw)?.maxPerUser ??
          Math.max(1, Math.floor(Number(draw.flashSale?.maxPerUser || 1))),
        latestOrderStatus: String(data.status || 'pending'),
      },
    }
    persistPaymentSession(paymentState.value)
    showPaymentModal.value = true
    await syncPaymentQrCode(data.qrCode)

    if (shouldPollPaymentStatus(paymentState.value.status)) {
      startPaymentPolling()
    } else {
      clearPaymentPollTimer()
      await refreshPaymentOrderStatus({ silent: true })
    }
  } catch (err) {
    paymentState.value = {
      drawId: draw.id,
      entryId,
      email,
      orderNo: '',
      status: 'unknown',
      quantity,
      unitPriceCents: Number(flashSale.priceCents || 0),
      amountCents: Number(flashSale.priceCents || 0),
      currency: String(flashSale.currency || 'cny'),
      provider: '',
      accessToken: '',
      prizeCode: null,
      prizeCodes: [],
    }
    clearPaymentSession()
    paymentError.value = err instanceof Error ? err.message : t('lottery.paymentCreateFailed')
    showPaymentModal.value = true
    clearPaymentPollTimer()
    paymentQrDataUrl.value = ''
  } finally {
    paymentLoading.value = false
  }
}

/**
 * 查结果成功后的直付订单恢复。
 *
 * 订单列表不能按裸邮箱公开查询。邮箱 OTP 已在 my-result 中验证后，再调用
 * OTP 保护的恢复接口；已支付订单直接展示卡密，待支付/可重试订单继续复用
 * payment-orders POST，由后端签发新的订单访问令牌并恢复支付入口。
 */
async function recoverPaymentOrderFromResult(
  draw: LotteryDraw,
  entryId: string,
  email: string,
  code: string,
) {
  if (!isDirectPaymentDraw(draw) || !entryId || !email) return

  // 登录态已由 my-result Bearer 证明邮箱身份，不需要重复输入 OTP。
  if (!code) {
    await showPaymentOrder(draw, entryId, email)
    return
  }

  try {
    const slug = publicDrawPathKey(draw.id)
    if (!slug) return
    const res = await fetch(
      `${API_BASE}/public/draws/${encodeURIComponent(slug)}/payment-orders/recover`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      },
    )
    const data = await res.json().catch(() => null) as {
      ok?: boolean
      message?: string
      orders?: Array<{
        orderNo?: string
        entryId?: string
        status?: string
        quantity?: number
        unitPriceCents?: number
        amountCents?: number
        currency?: string
        provider?: string
        paidAt?: string
        prizeCode?: { code?: string | null; secret?: string | null } | null
        prizeCodes?: Array<{ code?: string | null; secret?: string | null }>
      }>
    } | null
    if (!data?.ok || !data.orders?.length) return

    const order = data.orders[0]
    const orderEntryId = String(order.entryId || entryId)
    const status = String(order.status || 'unknown')
    if (status === 'paid' || status === 'paid_fulfillment_failed' || status === 'paid_late_needs_refund') {
      clearPaymentPollTimer()
      paymentError.value = ''
      paymentState.value = {
        drawId: draw.id,
        entryId: orderEntryId,
        email,
        orderNo: String(order.orderNo || ''),
        status,
        quantity: Number(order.quantity || 1),
        unitPriceCents: Number(order.unitPriceCents || draw.flashSale?.priceCents || 0),
        amountCents: Number(order.amountCents || draw.flashSale?.priceCents || 0),
        currency: String(order.currency || draw.flashSale?.currency || 'cny'),
        provider: String(order.provider || ''),
        accessToken: '',
        prizeCode: order.prizeCode || null,
        prizeCodes: order.prizeCodes || (order.prizeCode ? [order.prizeCode] : []),
      }
      paymentQrDataUrl.value = ''
      showPaymentModal.value = true
      try {
        await loadFlashSalePurchaseState(draw, orderEntryId, email)
      } catch {
        // 订单找回已成功，摘要仅用于主页面的追加购买提示，不影响卡密展示。
      }
      return
    }

    // pending / expired / cancelled：继续走统一的支付入口恢复状态机。
    await showPaymentOrder(draw, orderEntryId, email)
  } catch {
    // 查结果已经成功；订单恢复失败只提示支付侧，不覆盖用户刚查到的结果。
    showToast(t('lottery.paymentQueryFailed'), 'error')
  }
}

async function restartPaymentOrder() {
  const draw = draws.value.find((d) => d.id === paymentState.value?.drawId)
  if (!draw || !paymentState.value) return
  const entryId = paymentState.value.entryId || buildPaymentEntryId(draw)
  const email = paymentState.value.email || sessionEmail.value || ''
  if (!email) {
    paymentError.value = t('lottery.paymentEmailMissing')
    return
  }
  await showPaymentOrder(draw, entryId || '', email)
}

async function handleOpenPaymentLink() {
  if (!paymentRedirectUrl.value) return
  showToast(t('lottery.paymentLinkOpened'), 'success')
}

function copyPaymentOrderNo() {
  if (!paymentState.value?.orderNo) return
  void writeClipboardText(paymentState.value.orderNo)
  showToast(t('lottery.copied'), 'success')
}

function copyPaymentCode() {
  if (!paymentCodeText.value) return
  void writeClipboardText(paymentCodeText.value)
  showToast(t('lottery.copied'), 'success')
}

function stopMyResultCooldown() {
  if (myResultCooldownTimer) {
    clearInterval(myResultCooldownTimer)
    myResultCooldownTimer = null
  }
  myResultCodeCooldown.value = 0
}

function startMyResultCooldown(seconds: number) {
  stopMyResultCooldown()
  myResultCodeCooldown.value = Math.max(0, Math.floor(seconds) || 60)
  if (myResultCodeCooldown.value <= 0) return
  myResultCooldownTimer = setInterval(() => {
    myResultCodeCooldown.value = Math.max(0, myResultCodeCooldown.value - 1)
    if (myResultCodeCooldown.value <= 0) stopMyResultCooldown()
  }, 1000)
}

function openMyResult(draw: LotteryDraw) {
  myResultDraw.value = draw
  // 弱会话：预填邮箱，用户只需发码（docs/106）；强会话邮箱仅展示用
  myResultEmail.value = sessionEmail.value || ''
  myResultCode.value = ''
  myResultData.value = null
  myResultError.value = ''
  myResultSendingCode.value = false
  stopMyResultCooldown()
  showMyResultModal.value = true
  // 仅 JWT 可一键查；无码请求后端必拒，禁止弱会话空跑（docs/106）
  if (registeredToken.value) {
    void queryMyResult()
  }
}

/**
 * 参与记录行 → 查结果：优先用列表里的活动对象（含 publicSlug），否则用记录里的 id/slug 拼最小 draw。
 */
function openMyResultFromRecord(row: MyEntry) {
  const draw =
    draws.value.find((d) => d.id === row.drawId || d.publicSlug === row.drawId) ||
    ({
      id: row.drawId,
      publicSlug: row.drawId,
      name: row.drawName || row.drawId,
      title: row.drawName || row.drawId,
      status: row.drawStatus || 'open',
      participationMode: 'open',
      activityKind: row.activityKind || 'lottery',
    } as LotteryDraw)
  openMyResult(draw)
}

/**
 * 为查结果发邮箱 OTP（purpose=query）。
 * 与参与发码分离：已参与/已开奖仍可发；不走 join 的 409。
 */
async function sendMyResultCode() {
  if (!myResultDraw.value) return
  const email = myResultEmail.value.trim()
  if (!email.includes('@')) {
    myResultError.value = t('lottery.invalidEmail')
    return
  }
  myResultSendingCode.value = true
  myResultError.value = ''
  try {
    const slug = myResultDraw.value.publicSlug || myResultDraw.value.id
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(slug) + '/access-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, purpose: 'query' }),
    })
    const data = await res.json() as any
    if (data.ok && data.sent) {
      startMyResultCooldown(data.expiresInSeconds ? Math.min(60, Number(data.expiresInSeconds) || 60) : 60)
      showToast(t('lottery.resultCodeSent'), 'success')
    } else if (data.ok && data.joined) {
      // 极端：误走 join 直参；查结果场景不应出现
      myResultError.value = data.message || t('lottery.sendFailed')
    } else {
      myResultError.value = data.message || t('lottery.sendFailed')
    }
  } catch {
    myResultError.value = t('lottery.networkError') || ''
  } finally {
    myResultSendingCode.value = false
  }
}

async function queryMyResult() {
  if (!myResultDraw.value) return
  const isReg = myResultDraw.value.participationMode === 'registered'
  const hasBearer = Boolean(registeredToken.value)
  // 弱会话：打开时已预填；查询前再兜底一次，避免用户清空后仍带空邮箱
  if (!isReg && !hasBearer && !myResultEmail.value.trim() && sessionEmail.value) {
    myResultEmail.value = sessionEmail.value
  }
  // registered：必须 JWT；open 系：Bearer 免 OTP，否则必须邮箱+码（docs/106，无假一键）
  if (isReg && !hasBearer) {
    myResultError.value = t('lottery.registeredRequired') || ''
    return
  }
  if (!isReg && !hasBearer && (!myResultEmail.value.trim() || !myResultCode.value.trim())) {
    myResultError.value = t('lottery.emailCodeRequired') || ''
    return
  }
  myResultLoading.value = true
  myResultError.value = ''
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    // registered：user_id；open+JWT：后端按 email 免 OTP（docs/084）
    if (hasBearer) headers['Authorization'] = 'Bearer ' + registeredToken.value
    // docs/097：slug 回退 + encode，禁止 `/draws/undefined/my-result`
    const slug =
      myResultDraw.value.publicSlug || myResultDraw.value.id || props.id || ''
    if (!slug) {
      myResultError.value = t('lottery.drawNotLoaded') || ''
      return
    }
    const res = await fetch(
      `${API_BASE}/public/draws/${encodeURIComponent(slug)}/my-result`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: isReg
            ? sessionEmail.value || registeredUsername.value
            : myResultEmail.value.trim().toLowerCase(),
          code: hasBearer && !isReg ? '' : isReg ? '' : myResultCode.value.trim(),
        }),
      },
    )
    const data = await res.json()
    if (data.ok) {
      myResultData.value = data
      if (!isReg && myResultEmail.value.trim()) {
        persistSessionEmail(myResultEmail.value.trim().toLowerCase())
      }
      // 查到已参与：回填 joined / entryId / 中奖标签（docs/097 / 105 / 110）
      // entryId 是裂变身份键：缺了公开卡只能诚实提示「去查结果」，无法生成 ?ref=
      const drawKey = myResultDraw.value.id
      if (data.joined) {
        const recoveredEntryId = data.entryId ? String(data.entryId).trim() : undefined
        markDrawJoined(drawKey, {
          drawStatus: data.drawStatus || myResultDraw.value.status,
          activityKind: data.activityKind || myResultDraw.value.activityKind,
          entryId: recoveredEntryId,
          won: Boolean(data.won),
        })
        if (recoveredEntryId) {
          rememberJoinSuccess(drawKey, recoveredEntryId, {
            resultMode: data.resultMode || myResultDraw.value.resultMode,
            outcomeLabel: data.outcome?.resultLabel,
          })
        }
        if (data.won) {
          myWonById.value = { ...myWonById.value, [drawKey]: true }
        }
        // instant 次数字段回填
        if (data.spinsLeft != null && Number.isFinite(Number(data.spinsLeft))) {
          spinsLeftById.value = {
            ...spinsLeftById.value,
            [drawKey]: Number(data.spinsLeft),
          }
        }
        if (recoveredEntryId && isDirectPaymentDraw(myResultDraw.value)) {
          await recoverPaymentOrderFromResult(
            myResultDraw.value,
            recoveredEntryId,
            myResultEmail.value.trim().toLowerCase() || sessionEmail.value,
            hasBearer ? '' : myResultCode.value.trim(),
          )
        }
      }
    } else {
      myResultError.value = data.message || t('lottery.queryFailed')
    }
  } catch {
    myResultError.value = t('lottery.networkError') || ''
  } finally {
    myResultLoading.value = false
  }
}

/**
 * 查结果场景 cf-auth：只登录回本页，不写 pendingJoin（避免 drawn 活动被 resume 成参与，docs/097 P0-6）。
 */
async function handleCfAuthForMyResult() {
  if (!cfAuthEnabled.value) return
  try {
    await cfAuth.login({
      returnTo: route.fullPath || '/lottery',
    })
  } catch (e: any) {
    showToast(e?.message || t('lottery.joinFailed'), 'error')
  }
}

function copyMyResult(text: string) {
  if (!text) return
  writeClipboardText(text)
  showToast(t('lottery.copied'), 'success')
}

/**
 * 中奖/查结果弹窗内分享（仅未终态）。
 * 优先用 resolveViralEntryId（含 my-result 回填的 entryId），POST /share 生成 ?ref=；
 * 无 entry 才降级裸链——避免刷新后只复制无归因链接（docs/110）。
 */
async function shareMyWin() {
  if (!showMyResultInviteShare.value) return
  const draw = myResultDraw.value
  if (!draw) return
  const slug = draw.publicSlug || draw.id
  const origin = window.location.origin
  const entryId = resolveViralEntryId(draw)
  if (entryId) {
    try {
      const res = await fetch(`${API_BASE}/public/draws/${encodeURIComponent(slug)}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId }),
      })
      const data = await res.json()
      if (data.ok && data.shareUrl) {
        const path = String(data.shareUrl)
        const full = path.startsWith('http') ? path : origin + path
        await writeClipboardText(full)
        showToast(t('lottery.shareLinkCopied'), 'success')
        return
      }
    } catch { /* 降级到基础链接 */ }
  }
  await writeClipboardText(`${origin}/lottery/${slug}`)
  showToast(t('lottery.shareLinkCopied'), 'success')
}

const pendingJoinDrawId = ref<string | null>(null)
const nowMs = ref(Date.now())

// Telegram Mini App BackButton 适配
const tg = typeof window !== 'undefined' ? (window as any).Telegram?.WebApp : undefined
function handleTelegramBackButton() {
  if (showResult.value) { showResult.value = false; return }
  // 深链单活动：不退回 /lottery 广场（与 ADR-055a-1 一致）；交给 TG 关闭或停留
  if (isDeepLinked.value) return
  if (expandedId.value) { expandedId.value = null }
}
if (tg?.BackButton) {
  tg.BackButton.onClick(handleTelegramBackButton)
  watch([isDeepLinked, expandedId, showResult], () => {
    if (isDeepLinked.value || expandedId.value || showResult.value) {
      tg.BackButton.show()
    } else {
      tg.BackButton.hide()
    }
  }, { immediate: true })
  onUnmounted(() => {
    tg.BackButton.offClick?.(handleTelegramBackButton)
    tg.BackButton.hide?.()
  })
}

const showLoginModal = ref(false)
const loginEmail = ref('')
const loginCode = ref('')
/** 验证码输入 DOM：发码成功后聚焦，便于 iOS/Android OTP 自动填充落点 */
const loginCodeInputRef = ref<HTMLInputElement | null>(null)
const codeSent = ref(false)
const sendingCode = ref(false)
const verifyingCode = ref(false)
const codeCooldown = ref(0)
const loginError = ref('')
/** 防止 OTP 自动填充触发重复 verify */
let otpAutoSubmitLock = false
let cooldownTimer: ReturnType<typeof setInterval> | null = null
let countdownTimer: ReturnType<typeof setInterval> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
const trackedPageViews = new Set<string>()

/** 公开详情承载实时参与人数/开奖状态；请求侧也禁缓存，避免移动端返回旧数据。 */
const PUBLIC_DRAW_FETCH_INIT = buildPublicDrawRequestInit()

// 055a P1：只保留数字；满 6 位自动提交（短信/邮件 OTP 自动填充常见路径；规范化见 otp-input）
watch(loginCode, (raw) => {
  const digits = normalizeOtpDigits(String(raw || ''))
  if (digits !== raw) {
    loginCode.value = digits
    return
  }
  if (
    codeSent.value
    && isOtpComplete(digits)
    && !verifyingCode.value
    && !otpAutoSubmitLock
    && showLoginModal.value
  ) {
    otpAutoSubmitLock = true
    void handleVerifyCode().finally(() => {
      otpAutoSubmitLock = false
    })
  }
})

watch(codeSent, async (sent) => {
  if (!sent) return
  await nextTick()
  loginCodeInputRef.value?.focus({ preventScroll: true })
})

// docs/202 3.4：倒计时归零时自动刷新状态，免手动点击「刷新状态」
watch(nowMs, (now) => {
  if (draws.value.some((d) => {
    const start = new Date(d.startAt || d.startTime || '').getTime()
    return Number.isFinite(start) && now >= start && now - start < 1100
  })) {
    void fetchDraws({ silent: true })
  }
})

function ensureSubmissionDraft(draw: LotteryDraw) {
  if (!requiresActivitySubmission(draw) || submissionDrafts.value[draw.id]) return
  const fields: Record<string, any> = {}
  // 防御：activityConfig.fields 可能未配置（如投票活动没有字段），遍历前兜底为空数组
  if (draw.activityConfig?.kind === 'survey' && Array.isArray(draw.activityConfig.fields)) {
    for (const field of draw.activityConfig.fields) {
      fields[field.id] = field.type === 'checkbox' ? [] : ''
    }
  }
  submissionDrafts.value = {
    ...submissionDrafts.value,
    [draw.id]: { optionId: '', fields },
  }
}

function setVoteOption(drawId: string, optionId: string) {
  const draw = draws.value.find(d => d.id === drawId)
  if (draw) ensureSubmissionDraft(draw)
  const prev = submissionDrafts.value[drawId] || { optionId: '', fields: {} }
  submissionDrafts.value = {
    ...submissionDrafts.value,
    [drawId]: { ...prev, optionId },
  }
}

function setSurveyField(drawId: string, fieldId: string, value: string) {
  const draw = draws.value.find(d => d.id === drawId)
  if (draw) ensureSubmissionDraft(draw)
  const prev = submissionDrafts.value[drawId] || { optionId: '', fields: {} }
  submissionDrafts.value = {
    ...submissionDrafts.value,
    [drawId]: { ...prev, fields: { ...prev.fields, [fieldId]: value } },
  }
}

function toggleSurveyCheckbox(drawId: string, fieldId: string, optionId: string, checked: boolean) {
  const draw = draws.value.find(d => d.id === drawId)
  if (draw) ensureSubmissionDraft(draw)
  const prev = submissionDrafts.value[drawId] || { optionId: '', fields: {} }
  const cur = Array.isArray(prev.fields[fieldId]) ? [...prev.fields[fieldId]] : []
  const next = checked ? (cur.includes(optionId) ? cur : [...cur, optionId]) : cur.filter((id: string) => id !== optionId)
  submissionDrafts.value = {
    ...submissionDrafts.value,
    [drawId]: { ...prev, fields: { ...prev.fields, [fieldId]: next } },
  }
}function buildSubmissionPayload(draw: LotteryDraw): Record<string, unknown> | undefined {
  if (!requiresActivitySubmission(draw)) return undefined
  ensureSubmissionDraft(draw)
  const draft = submissionDrafts.value[draw.id]
  if (draw.activityConfig?.kind === 'vote') return { optionId: draft.optionId }
  return { fields: draft.fields }
}

function validateSubmissionDraft(draw: LotteryDraw): string {
  if (!requiresActivitySubmission(draw)) return ''
  ensureSubmissionDraft(draw)
  const draft = submissionDrafts.value[draw.id]
  if (draw.activityConfig?.kind === 'vote') {
    return draft.optionId ? '' : t('lottery.voteRequired')
  }
  if (draw.activityConfig?.kind === 'survey') {
    // 防御：fields 未配置时跳过校验
    const fields = Array.isArray(draw.activityConfig.fields) ? draw.activityConfig.fields : []
    for (const field of fields) {
      const value = draft.fields[field.id]
      const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
      if (field.required && empty) return t('lottery.requiredField', { label: field.label })
    }
  }
  return ''
}
/**
 * 是否已挂载可交互游戏壳（与 GameRegistry 对齐，含 list/queue 等别名与未知→Submit 回退）。
 * 有则游戏区即主 CTA，底部不再放第二颗参与按钮。
 */
function hasInteractiveGame(draw: { experienceType?: string; participationMode?: string }): boolean {
  const exp = draw.experienceType || defaultExperienceForParticipation(draw.participationMode || 'open')
  // getGameComponent 对未知类型也回退 Submit，故几乎总有壳；用注册表/回退语义即可
  return hasRegisteredGameExperience(exp) || getGameComponent(exp) != null
}

/**
 * 公开页壳/奖池展示（docs/128）：
 * - 优先用公开 API 已算好的 prizePanelMode / shellLabels / prizePoolDisplay
 * - delayed：壳=仪式短语（无奖品图）；instant：壳=真奖名+图
 * - 奖池条与壳解耦：默认可 full 公示目录，不暗示「你已中」
 *
 * 按 draw 引用弱缓存，避免模板多次调用 prizePoolStripFor/shellPrizesFor 重复计算。
 */
const prizeShellCache = new WeakMap<LotteryDraw, ReturnType<typeof buildPublicPrizeShellPayload>>()

function resolvePrizeShell(draw: LotteryDraw) {
  const hit = prizeShellCache.get(draw)
  if (hit) return hit
  const built = buildPublicPrizeShellPayload({
    resultMode: draw.resultMode,
    promotionConfig: draw.promotionConfig,
    serverShell: {
      prizePanelMode: draw.prizePanelMode,
      shellLabels: draw.shellLabels,
      shellUsesRealPrizes: draw.shellUsesRealPrizes,
      prizePoolDisplay: draw.prizePoolDisplay,
    },
    prizes: draw.prizes || [],
  })
  prizeShellCache.set(draw, built)
  return built
}

/** 传给 Wheel/Slot 等：扇面/卷轴格文案 */
function shellPrizesFor(draw: LotteryDraw) {
  const shell = resolvePrizeShell(draw)
  if (shell.shellPrizeItems.length > 0) return shell.shellPrizeItems
  // 无 prizes 的非 lottery 壳：中性占位，避免空盘与「奖品」硬编码
  return [{ name: t('lottery.shellPlaceholder'), color: '', imageUrl: '', valueText: '' }]
}

/**
 * 即时大转盘追加固定“谢谢参与”扇区。
 * 真实中奖 prizeIndex 仍对应原奖品索引；未中奖只允许停到追加项。
 */
function gamePrizesFor(draw: LotteryDraw) {
  const items = shellPrizesFor(draw)
  if (!isInstantLottery(draw) || !usesWheelAnimation(draw)) return items
  return withInstantWheelMissSector(items, t('lottery.thanksForParticipating'))
}

/** 奖池条条目；hidden 返回 [] */
function prizePoolStripFor(draw: LotteryDraw) {
  return resolvePrizeShell(draw).poolStripItems.filter((p) => Boolean(p.name || p.tierName))
}

/**
 * 是否展示「扇面=氛围非中奖」提示。
 * 仅 lottery + 壳未用真奖（delayed 默认）+ 有可交互转盘/老虎机类体验时，避免对 form/submit 噪音。
 */
function showPrizeShellRitualHint(draw: LotteryDraw): boolean {
  if (String(draw.activityKind || 'lottery') !== 'lottery') return false
  const shell = resolvePrizeShell(draw)
  if (shell.shellUsesRealPrizes) return false
  const exp = String(
    draw.experienceType || defaultExperienceForParticipation(draw.participationMode || 'open'),
  )
    .trim()
    .toLowerCase()
  return exp === 'wheel' || exp === 'slot' || exp === 'grid'
}

function formatTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  try {
    return d.toLocaleString(locale.value || undefined)
  } catch {
    return d.toLocaleString()
  }
}

function clearSession() {
  // 仅清参与会话 + OAuth 临时键；保留 admin_token（运营预览活动页退出不应踢后台）
  myEntryList.value = []
  persistSessionEmail('')
  clearPaymentSession()
  paymentState.value = null
  paymentError.value = ''
  paymentQrDataUrl.value = ''
  showPaymentModal.value = false
  clearPaymentPollTimer()
  registeredToken.value = ''
  registeredUsername.value = ''
  clearLotteryBrowserSessionOnly(sessionStorage)
  myJoinedById.value = {}
  myWonById.value = {}
  myOutcomeById.value = {}
}

function drawSlug(drawId: string): string {
  const draw = draws.value.find((d) => d.id === drawId)
  return draw?.publicSlug || drawId
}

function routeParam(name: string): string {
  const value = route.query[name]
  return Array.isArray(value) ? String(value[0] || '') : String(value || '')
}

function activityEventContext() {
  return {
    source: routeParam('utm_source') || 'direct',
    medium: routeParam('utm_medium'),
    campaign: routeParam('utm_campaign'),
    refCode: routeParam('ref'),
  }
}

async function recordActivityEvent(drawId: string, eventType: ActivityEventType, metadata?: Record<string, unknown>) {
  const slug = drawSlug(drawId)
  if (!slug) return
  try {
    await fetch(API_BASE + '/public/draws/' + encodeURIComponent(slug) + '/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType,
        ...activityEventContext(),
        metadata,
      }),
    })
  } catch (error) {
    console.debug('[lottery] activity event ignored:', eventType, error)
  }
}

function trackPageView(draw: LotteryDraw) {
  const key = draw.publicSlug || draw.id
  if (!key || trackedPageViews.has(key)) return
  trackedPageViews.add(key)
  void recordActivityEvent(draw.id, 'page_view', {
    activityKind: draw.activityKind || 'lottery',
    experienceType: draw.experienceType || '',
    status: draw.status,
  })
}

const loginModalRef = ref<HTMLElement | null>(null)

function openLogin(drawId?: string, intent: LoginModalIntent = 'join') {
  if (drawId && intent === 'join') {
    const draw = draws.value.find((d) => d.id === drawId || d.publicSlug === drawId)
    if (draw && !isDrawJoinable(draw)) {
      showToast(joinDisabledText(draw), 'error')
      return
    }
  }
  pendingJoinDrawId.value = drawId || null
  loginModalIntent.value = drawId ? intent : 'login'
  // 仅参与意图记 participation_started；spin 补码不算新参与
  if (drawId && intent === 'join') void recordActivityEvent(drawId, 'participation_started')
  loginError.value = ''
  codeSent.value = false
  loginCode.value = ''
  // 预填会话邮箱，减少二次参与 / spin 摩擦
  if (sessionEmail.value && !loginEmail.value) loginEmail.value = sessionEmail.value
  showLoginModal.value = true
  nextTick(() => loginModalRef.value?.focus())
}

/**
 * 结果弹窗 → 查结果：关成功弹窗后打开 my-result，
 * 有 JWT 时 openMyResult 会自动 query（docs/084/096 闭环）。
 */
function onResultModalQuery() {
  showResult.value = false
  const drawId = lastJoinResult.value?.drawId
  const draw =
    (drawId ? draws.value.find((d) => d.id === drawId) : null) ||
    draws.value[0] ||
    null
  if (draw) openMyResult(draw)
}

/** 仅登录：cf-auth 回当前活动页（不带 pendingJoin 自动参与） */
async function handleCfAuthLoginOnly() {
  try {
    await cfAuth.login({
      returnTo: route.fullPath || '/lottery',
    })
  } catch (e: any) {
    showToast(e?.message || t('lottery.joinFailed'), 'error')
  }
}

/**
 * 已登录 + 仅补活动凭证后直参（不发邮箱 OTP）。
 */
async function handleCredentialJoinWithBearer() {
  const drawId = pendingJoinDrawId.value
  if (!drawId) return
  const credErr = validateJoinCredentials()
  if (credErr) {
    loginError.value = credErr
    return
  }
  const session = await ensureParticipationSessionFromAdmin()
  const token = session?.token || registeredToken.value
  const email = resolveOpenJoinEmail({
    token: token || '',
    emailHint: session?.email,
    sessionEmail: sessionEmail.value,
  })
  if (!token || !email) {
    // 会话丢失：降级完整 OTP 路径
    loginError.value = t('lottery.registeredRequired')
    return
  }
  verifyingCode.value = true
  loginError.value = ''
  try {
    closeLogin()
    await joinOpenWithBearer(drawId, token, email)
  } finally {
    verifyingCode.value = false
  }
}

function closeLogin() {
  showLoginModal.value = false
  pendingJoinDrawId.value = null
  loginModalIntent.value = 'join'
  loginError.value = ''
  // 保留 loginEmail / 访问凭证不在关闭时强制清空，避免用户误关后重填；成功路径会清凭证
}

/**
 * 参与成功后的本地乐观计数：真实值仍以随后的 fetchDrawDetail 为准。
 * 这样用户点击完成后角标立即从 0 变 1，不需要等 30 秒轮询。
 */
function bumpParticipantCount(drawId: string) {
  const idx = draws.value.findIndex((d) => d.id === drawId || d.publicSlug === drawId)
  if (idx === -1) return
  const draw = draws.value[idx]!
  if (draw.entryCount == null && draw.participantCount == null) return
  const current = Number(draw.entryCount ?? draw.participantCount ?? 0)
  const nextCount = Number.isFinite(current) ? current + 1 : 1
  draws.value[idx] = { ...draw, entryCount: nextCount, participantCount: nextCount }
}

/** 重新读取指定活动详情，用服务端权威计数覆盖本地乐观值。 */
function refreshDrawDetailFor(drawId: string) {
  const draw = draws.value.find((d) => d.id === drawId || d.publicSlug === drawId)
  void fetchDrawDetail(draw?.publicSlug || draw?.id || drawId)
}

/**
 * docs/130：秒杀名额抢光。
 * - toast「已抢光」
 * - 刷新详情让 flashSale.remaining=0，按钮变灰
 * - 不打开登录（不是身份问题）
 */
function handleFlashSaleSoldOut(drawId: string, message?: string) {
  showToast(message || t('lottery.flashSoldOut'), 'error')
  refreshDrawDetailFor(drawId)
}

/** 仅登录（无需验证码）：存入邮箱后关闭弹窗，加载参与记录 */
function handleLogout() {
  clearSession()
  showToast(t('lottery.loggedOut'))
}

function toggleExpand(id: string) {
  // 深链单活动：禁止收起，保持沉浸主路径（docs/055a）
  if (isDeepLinked.value) {
    expandedId.value = id
    const draw = draws.value.find((item) => item.id === id)
    if (draw) ensureSubmissionDraft(draw)
    void fetchDrawDetail(id)
    return
  }
  expandedId.value = expandedId.value === id ? null : id
  // 展开详情时调用 GET 触发懒开奖 / 补全字段
  if (expandedId.value === id) {
    const draw = draws.value.find((item) => item.id === id)
    if (draw) ensureSubmissionDraft(draw)
    void fetchDrawDetail(id)
  }
}

/**
 * 顶栏/卡内「复制分享链接」。
 * 已参与且能解析 entryId 时走 POST /share，复制带 ?ref= 的专属链（裂变主转化入口）；
 * 否则复制裸活动链（路人传播仍有价值，只是无个人归因）。
 */
async function handleCopyPublicLink(drawId: string) {
  const draw = draws.value.find(d => d.id === drawId)
  const slug = draw?.publicSlug || drawId
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const entryId = draw ? resolveViralEntryId(draw) : undefined
  try {
    if (entryId && draw && shouldShowInviteShareCta(draw.status)) {
      const res = await fetch(`${API_BASE}/public/draws/${encodeURIComponent(slug)}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId }),
      })
      const data = await res.json()
      if (data.ok && data.shareUrl) {
        const path = String(data.shareUrl)
        const full = path.startsWith('http') ? path : origin + path
        await writeClipboardText(full)
        showToast(t('lottery.shareLinkCopied'))
        return
      }
    }
    await writeClipboardText(`${origin}/lottery/${slug}`)
    showToast(t('lottery.shareLinkCopied'))
  } catch {
    showToast(t('lottery.shareLinkCopyFailed'))
  }
}

async function fetchDrawDetail(id: string) {
  try {
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(id), PUBLIC_DRAW_FETCH_INIT)
    const data = await res.json() as any
    if (data.ok) {
      const normalized = normalizePublicDraw(data, id)
      const idx = draws.value.findIndex((d) => d.id === id || d.publicSlug === id || d.id === normalized.id)
      if (idx !== -1) {
        draws.value[idx] = { ...draws.value[idx], ...normalized, id: draws.value[idx]!.id || normalized.id }
        ensureSubmissionDraft(draws.value[idx]!)
      }
    }
  } catch (e) {
    console.error('[lottery] fetch draw detail failed:', e)
  }
}

/**
 * 拉取公开活动。
 * @param opts.silent 轮询/后台刷新：不置 loading、失败不擦掉已有 draws（docs/097 P0-3）
 * 注意：模板 @click 可能传入 PointerEvent，不可把 Event 当 opts；仅认显式 `{ silent }`。
 */
async function fetchDraws(opts?: { silent?: boolean } | Event) {
  const silent = isSilentFetchOption(opts)
  if (!silent) {
    loading.value = true
    fetchError.value = ''
  }
  try {
    // 公开页：只支持深链 /lottery/:slug（011 Option C）；无 slug 不做活动广场
    if (!props.id) {
      if (!silent) draws.value = []
      return
    }
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(props.id), PUBLIC_DRAW_FETCH_INIT)
    const data = await res.json() as any
    if (data.ok) {
      const draw = normalizePublicDraw(data, props.id)
      draws.value = [draw]
      ensureSubmissionDraft(draw)
      expandedId.value = draw.id
      if (!silent) trackPageView(draw)
      if (draw.title || draw.name) {
        document.title = (draw.name || draw.title) + ' - ' + t('lottery.title')
      }
      // 详情与列表同源；再拉一次以触发懒开奖等服务端副作用（静默轮询跳过，减请求）
      if (!silent) void fetchDrawDetail(draw.publicSlug || draw.id)
    } else if (!silent) {
      draws.value = []
      fetchError.value = data.message || t('lottery.noActivity')
    }
    // silent 失败：保留现有 draws，避免参与中闪空
  } catch (e) {
    console.error('[lottery] fetch draws failed:', e)
    if (!silent) {
      fetchError.value = t('lottery.networkError')
      draws.value = []
    }
  } finally {
    if (!silent) loading.value = false
  }
}

/**
 * 刷新后回填「已参与」UI（docs/097 P0-2 / docs/098）：
 * 1) 本机 session hints（无 JWT 的 open OTP 也能灰钮，非密码学证明）
 * 2) 有业务 JWT 时静默 my-result 权威确认
 * 不弹窗；网络失败忽略。
 */
async function hydrateJoinedStateFromSession() {
  const draw = draws.value[0]
  if (!draw) return

  // —— 1) 无 JWT 也能恢复：读 lottery_joined_hints ——
  const hints = readJoinedHints(sessionStorage)
  const hintKeys = [draw.id, draw.publicSlug || '', props.id || '']
  for (const k of hintKeys) {
    const h = hints[String(k || '').trim().toLowerCase()]
    if (!h) continue
    markDrawJoined(draw.id, {
      joinedAt: h.joinedAt,
      drawName: h.drawName,
      drawStatus: h.drawStatus || draw.status,
      entryId: h.entryId,
      activityKind: h.activityKind || draw.activityKind,
      won: h.won,
    })
    if (h.won) {
      myWonById.value = { ...myWonById.value, [draw.id]: true }
    }
    break
  }

  // —— 2) 有 JWT：服务端确认（可覆盖/补强 hints）——
  const token = registeredToken.value
  if (!token) return
  const slug = draw.publicSlug || draw.id
  if (!slug) return
  try {
    const res = await fetch(`${API_BASE}/public/draws/${encodeURIComponent(slug)}/my-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        email: sessionEmail.value || '',
        code: '',
      }),
    })
    const data = (await res.json()) as any
    if (data?.ok && data.joined) {
      markDrawJoined(draw.id, {
        drawStatus: draw.status,
        entryId: data.entryId ? String(data.entryId) : undefined,
        activityKind: data.activityKind || draw.activityKind,
        won: Boolean(data.won),
      })
      if (data.won) {
        myWonById.value = { ...myWonById.value, [draw.id]: true }
      } else {
        // 服务端未中奖：清掉本机可能误写的 won 标签
        const nextWon = { ...myWonById.value }
        delete nextWon[draw.id]
        if (draw.publicSlug) delete nextWon[draw.publicSlug]
        myWonById.value = nextWon
      }
    } else if (data?.ok && data.joined === false) {
      // 服务端明确未参与：清本活动 UI + 相关 hints（防脏数据假灰钮，docs/099）
      const dropKeys = [draw.id, draw.publicSlug || '', props.id || '']
      removeJoinedHintsForKeys(sessionStorage, dropKeys)
      const nextJoined = { ...myJoinedById.value }
      const nextWon = { ...myWonById.value }
      for (const k of dropKeys) {
        if (!k) continue
        delete nextJoined[k]
        delete nextWon[k]
      }
      myJoinedById.value = nextJoined
      myWonById.value = nextWon
      myEntryList.value = myEntryList.value.filter(
        (r) => r.drawId !== draw.id && r.drawId !== draw.publicSlug,
      )
    }
  } catch {
    /* 静默：不影响主路径；无 JWT 失败时 hints 仍可灰钮 */
  }
}

/** registered 模式：用户名密码登录后直接参与 */
async function handleRegisteredLogin() {
  if (!regLoginUsername.value || !regLoginPassword.value) {
    loginError.value = t('adminLogin.missingUsernamePassword')
    return
  }
  if (!pendingJoinDrawId.value) return

  regLoginLoading.value = true
  loginError.value = ''
  try {
    // 1. 登录获取 JWT（与后台同一认证体系，API_BASE 统一，支持子路径部署）
    const loginRes = await fetch(API_BASE + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: regLoginUsername.value, password: regLoginPassword.value }),
    })
    const loginData = await loginRes.json()
    if (!loginData.ok) { loginError.value = loginData.message || t('adminLogin.loginFailed'); return }

    const token = loginData.token
    registeredToken.value = token
    registeredUsername.value = regLoginUsername.value
    // 会话级持久化：刷新页面免重复登录；关闭标签页自动清除，不残留敏感信息
    sessionStorage.setItem(LOTTERY_REGISTERED_TOKEN_KEY, token)
    sessionStorage.setItem(LOTTERY_REGISTERED_USERNAME_KEY, regLoginUsername.value)

    // 2. 带 JWT 调 access-code（registered 模式后端以 JWT 中的 userId 为身份）
    await joinWithRegisteredToken(pendingJoinDrawId.value, token)
    regLoginPassword.value = ''
  } catch {
    loginError.value = t('lottery.networkError')
  } finally {
    regLoginLoading.value = false
  }
}

/**
 * registered 已持有 JWT：直接 access-code 参与，避免游戏壳二次弹登录。
 */
async function joinWithRegisteredToken(drawId: string, token: string) {
  const draw = draws.value.find(d => d.id === drawId)
  if (draw) {
    if (!isDrawJoinable(draw)) {
      const msg = joinDisabledText(draw)
      loginError.value = msg
      showToast(msg, 'error')
      return
    }
    const message = validateSubmissionDraft(draw)
    if (message) {
      loginError.value = message
      showToast(message, 'error')
      return
    }
  }
  joiningId.value = drawId
  try {
    const pathKey = publicDrawPathKey(drawId)
    // refCode：registered 经 access-code 也要归因（docs/112）
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(pathKey) + '/access-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        submission: draw ? buildSubmissionPayload(draw) : undefined,
        refCode: routeParam('ref') || undefined,
      }),
    })
    const data = await res.json()
    if (data.ok && data.joined) {
      completeJoinSuccess(drawId, data)
    } else if (isAlreadyJoinedResponse(data, res.status)) {
      handleAlreadyJoined(drawId, { entryId: entryIdFromAlreadyJoined(data) })
    } else if (data.soldOut || data.code === 'flash_sale.sold_out') {
      // docs/130：秒杀售罄 — 刷新进度，不弹登录
      handleFlashSaleSoldOut(drawId, data.message)
    } else {
      const msg = data.message || t('lottery.joinFailed')
      loginError.value = msg
      showToast(msg, 'error')
    }
  } catch {
    loginError.value = t('lottery.networkError')
    showToast(t('lottery.networkError'), 'error')
  } finally {
    joiningId.value = ''
  }
}

/**
 * open 系：已有业务 JWT + email → verify-join 免 OTP 直参（docs/093）。
 * password/invite 缺凭证时仍弹窗，只补凭证不强迫再发码。
 */
async function joinOpenWithBearer(drawId: string, token: string, email: string) {
  const draw = draws.value.find((d) => d.id === drawId)
  if (draw) {
    if (!isDrawJoinable(draw)) {
      showToast(joinDisabledText(draw), 'error')
      return
    }
    const message = validateSubmissionDraft(draw)
    if (message) {
      showToast(message, 'error')
      expandedId.value = drawId
      return
    }
  }
  const missing = missingJoinCredentialForMode({
    participationMode: draw?.participationMode,
    accessPassword: joinAccessPassword.value,
    inviteCode: joinInviteCode.value,
  })
  if (missing) {
    // 已登录仍可能缺活动密码/邀请码：只弹凭证，不走「邮箱验证」主路径
    openLogin(drawId)
    loginError.value =
      missing === 'password' ? t('lottery.accessPasswordRequired') : t('lottery.inviteCodeRequired')
    return
  }
  joiningId.value = drawId
  try {
    const pathKey = publicDrawPathKey(drawId)
    const res = await fetch(
      API_BASE + '/public/draws/' + encodeURIComponent(pathKey) + '/verify-join',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(
          buildCfAuthVerifyJoinBody({
            email,
            pending: {
              drawId,
              accessPassword: joinAccessPassword.value || undefined,
              inviteCode: joinInviteCode.value || undefined,
              refCode: routeParam('ref') || undefined,
            },
            submission: draw ? buildSubmissionPayload(draw) : undefined,
          }),
        ),
      },
    )
    const data = (await res.json()) as any
    if (data.ok && data.joined) {
      completeJoinSuccess(drawId, data, { email })
    } else if (isAlreadyJoinedResponse(data, res.status)) {
      handleAlreadyJoined(drawId, { entryId: entryIdFromAlreadyJoined(data) })
    } else if (data.soldOut || data.code === 'flash_sale.sold_out') {
      handleFlashSaleSoldOut(drawId, data.message)
    } else {
      showToast(data.message || t('lottery.joinFailed'), 'error')
      // 后端拒绝（如 JWT 无 email claim）时降级弹窗，仍可 OTP
      openLogin(drawId)
    }
  } catch {
    showToast(t('lottery.networkError'), 'error')
  } finally {
    joiningId.value = ''
  }
}

/**
 * 把管理端 admin_token 同步到参与会话（顶栏已登录 ≠ 参与轨有 JWT 的断层修复）。
 * 旧 JWT 无 email claim 时尝试 /api/admin/me 补邮箱。
 */
async function ensureParticipationSessionFromAdmin(): Promise<{
  token: string
  email: string
} | null> {
  const adminTok = readAdminToken()
  if (!adminTok && !registeredToken.value) return null

  // 邮箱优先 JWT claim（与 Bearer 同源）；sessionEmail 只作兜底，避免陈旧缓存压过 JWT
  const bearerProbe = registeredToken.value || adminTok
  let emailHint = resolveOpenJoinEmail({
    token: bearerProbe,
    sessionEmail: sessionEmail.value,
  })
  let nameHint = registeredUsername.value || ''

  // 旧 token 无 email：用管理端 /me 补（同一业务 JWT，requireAuth 可验）
  if (adminTok && !emailHint) {
    try {
      const meRes = await fetch(API_BASE + '/admin/me', {
        headers: { Authorization: `Bearer ${adminTok}` },
      })
      // ok() 展开为 { ok, user: { email, username }, ... }
      const me = (await meRes.json().catch(() => ({}))) as {
        ok?: boolean
        user?: { email?: string; username?: string }
      }
      if (me?.user?.email) emailHint = String(me.user.email).trim().toLowerCase()
      if (me?.user?.username && !nameHint) nameHint = String(me.user.username).trim()
    } catch {
      /* 忽略：后续可能仍能用 session 已有值 */
    }
  }

  const hydrated = hydrateLotterySessionFromAdminToken({
    sessionStore: sessionStorage,
    adminToken: adminTok || registeredToken.value,
    email: emailHint,
    displayName: nameHint,
  })
  if (!hydrated) return null

  registeredToken.value = hydrated.token
  // 最终邮箱仍以「实际 Bearer token」的 claim 为准
  const email = resolveOpenJoinEmail({
    token: hydrated.token,
    emailHint: hydrated.email,
    sessionEmail: sessionEmail.value,
  })
  if (email) persistSessionEmail(email)
  if (hydrated.displayName) {
    registeredUsername.value = hydrated.displayName
    sessionStorage.setItem(LOTTERY_REGISTERED_USERNAME_KEY, hydrated.displayName)
  }
  if (!email) return null
  return { token: hydrated.token, email }
}

/**
 * cf-auth OAuth 回调后自动参与（docs/059）。
 * 只 read pending，join **成功后** 才 consume——失败可补密码/再试，避免一次失败丢意图。
 */
async function resumeCfAuthJoinAfterCallback() {
  const pending = readCfAuthPendingJoin(sessionStorage)
  const token =
    sessionStorage.getItem(LOTTERY_REGISTERED_TOKEN_KEY) || registeredToken.value || ''
  if (!shouldResumeCfAuthJoin({ pending, token })) return
  if (!pending?.drawId) return

  registeredToken.value = token
  // 与 handleJoin 一致：JWT.email 优先于 session 缓存
  const email = resolveOpenJoinEmail({
    token,
    sessionEmail:
      sessionStorage.getItem(LOTTERY_SESSION_EMAIL_KEY) || sessionEmail.value || '',
  })
  if (email) persistSessionEmail(email)
  const uname = sessionStorage.getItem(LOTTERY_REGISTERED_USERNAME_KEY) || ''
  if (uname) registeredUsername.value = uname

  if (pending.accessPassword) joinAccessPassword.value = pending.accessPassword
  if (pending.inviteCode) joinInviteCode.value = pending.inviteCode

  pendingJoinDrawId.value = pending.drawId
  const draw =
    draws.value.find((d) => d.id === pending.drawId || d.publicSlug === pending.drawId) || null
  const joinKey = draw?.id || pending.drawId
  if (draw && !isDrawJoinable(draw)) {
    const msg = joinDisabledText(draw)
    consumeCfAuthPendingJoin(sessionStorage)
    pendingJoinDrawId.value = null
    showToast(msg, 'error')
    return
  }

  /** join 成功后清除 pending，防止刷新重复提交 */
  const finishPendingOk = () => {
    consumeCfAuthPendingJoin(sessionStorage)
  }

  // registered：access-code + Bearer（与用户名密码登录同路径）
  if (draw?.participationMode === 'registered') {
    closeLogin()
    joiningId.value = joinKey
    try {
      const pathKey = publicDrawPathKey(joinKey)
      // pending.refCode 优先（cf-auth 跳转前写入），否则当前 URL ?ref=
      const refFromPending = pending.refCode ? String(pending.refCode).trim() : ''
      const res = await fetch(
        API_BASE + '/public/draws/' + encodeURIComponent(pathKey) + '/access-code',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token,
          },
          body: JSON.stringify({
            submission: draw ? buildSubmissionPayload(draw) : undefined,
            refCode: refFromPending || routeParam('ref') || undefined,
          }),
        },
      )
      const data = (await res.json()) as any
      if (data.ok && data.joined) {
        finishPendingOk()
        completeJoinSuccess(joinKey, data)
      } else if (isAlreadyJoinedResponse(data, res.status)) {
        finishPendingOk()
        handleAlreadyJoined(joinKey, { entryId: entryIdFromAlreadyJoined(data) })
      } else if (data.soldOut || data.code === 'flash_sale.sold_out') {
        finishPendingOk()
        handleFlashSaleSoldOut(joinKey, data.message)
      } else {
        // 保留 pending；打开登录便于用户改凭证或看错误
        const msg = data.message || t('lottery.joinFailed')
        loginError.value = msg
        showToast(msg, 'error')
        openLogin(joinKey)
      }
    } catch {
      showToast(t('lottery.networkError'), 'error')
    } finally {
      joiningId.value = ''
    }
    return
  }

  // open / password / invite / roster：verify-join + Bearer 跳过验证码
  // 若 password/invite 仍缺字段：不发请求，打开弹窗让用户补全（pending 仍在）
  const missing = missingJoinCredentialForMode({
    participationMode: draw?.participationMode,
    accessPassword: pending.accessPassword || joinAccessPassword.value,
    inviteCode: pending.inviteCode || joinInviteCode.value,
  })
  if (missing) {
    openLogin(joinKey)
    loginError.value =
      missing === 'password' ? t('lottery.accessPasswordRequired') : t('lottery.inviteCodeRequired')
    return
  }

  if (!email) {
    showToast(t('lottery.joinFailed'), 'error')
    openLogin(joinKey)
    return
  }
  try {
    const pathKey = publicDrawPathKey(joinKey)
    const res = await fetch(
      API_BASE + '/public/draws/' + encodeURIComponent(pathKey) + '/verify-join',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(
          buildCfAuthVerifyJoinBody({
            email,
            pending: {
              ...pending,
              drawId: joinKey,
              accessPassword: pending.accessPassword || joinAccessPassword.value || undefined,
              inviteCode: pending.inviteCode || joinInviteCode.value || undefined,
            },
            submission: draw ? buildSubmissionPayload(draw) : undefined,
          }),
        ),
      },
    )
    const data = (await res.json()) as any
    if (data.ok && data.joined) {
      finishPendingOk()
      completeJoinSuccess(joinKey, data, { email })
    } else if (isAlreadyJoinedResponse(data, res.status)) {
      finishPendingOk()
      handleAlreadyJoined(joinKey, { entryId: entryIdFromAlreadyJoined(data) })
    } else if (data.soldOut || data.code === 'flash_sale.sold_out') {
      finishPendingOk()
      handleFlashSaleSoldOut(joinKey, data.message)
    } else {
      // 失败不 consume；若用户刚在弹窗改了密码，写回 pending 供下次自动/手动
      saveCfAuthPendingJoin(sessionStorage, {
        ...pending,
        accessPassword: joinAccessPassword.value || pending.accessPassword,
        inviteCode: joinInviteCode.value || pending.inviteCode,
      })
      showToast(data.message || t('lottery.joinFailed'), 'error')
      openLogin(joinKey)
    }
  } catch {
    showToast(t('lottery.networkError'), 'error')
  }
}

async function handleJoin(drawId: string) {
  // docs/097 P0-5：入口互斥（含 ensureSession 等待期），避免连点双请求
  if (joiningId.value) return
  const draw = draws.value.find((item) => item.id === drawId)
  if (!draw) return
  if (!isDrawJoinable(draw)) {
    showToast(joinDisabledText(draw), 'error')
    return
  }
  // id 与 publicSlug 任一命中即视为已参与（hints / mark 双键，docs/098）
  if (myJoinedById.value[drawId] || myJoinedById.value[draw.publicSlug || '']) {
    showToast(t('lottery.alreadyJoinedHint'), 'success')
    if (isDirectPaymentDraw(draw)) {
      resumePaymentFromDraw(draw)
      return
    }
    openMyResult(draw)
    return
  }
  ensureSubmissionDraft(draw)
  const message = validateSubmissionDraft(draw)
  if (message) {
    showToast(message, 'error')
    expandedId.value = drawId
    return
  }
  void recordActivityEvent(drawId, 'participation_started')

  // 在 await 会话同步前锁住；join* 复用同一 joiningId，结束时由其 finally 或下方 finally 清空
  joiningId.value = drawId
  try {
    const session = await ensureParticipationSessionFromAdmin()
    const token = session?.token || registeredToken.value
    const email = resolveOpenJoinEmail({
      token: token || '',
      emailHint: session?.email,
      sessionEmail: sessionEmail.value,
    })

    if (draw.participationMode === 'registered' && token) {
      pendingJoinDrawId.value = drawId
      await joinWithRegisteredToken(drawId, token)
      return
    }

    if (token && email && email.includes('@')) {
      pendingJoinDrawId.value = drawId
      await joinOpenWithBearer(drawId, token, email)
      return
    }

    openLogin(drawId)
  } finally {
    // join* 成功路径已在其 finally 清空；开弹窗 / 早退时若仍锁着本 draw 则释放
    if (joiningId.value === drawId) joiningId.value = ''
  }
}

function startCooldown(seconds: number) {
  if (cooldownTimer) {
    clearInterval(cooldownTimer)
    cooldownTimer = null
  }
  codeCooldown.value = seconds
  cooldownTimer = setInterval(() => {
    codeCooldown.value -= 1
    if (codeCooldown.value <= 0 && cooldownTimer) {
      clearInterval(cooldownTimer)
      cooldownTimer = null
      codeCooldown.value = 0
    }
  }, 1000)
}

function validateJoinCredentials(): string {
  if (pendingJoinNeedsPassword.value && !String(joinAccessPassword.value || '').trim()) {
    return t('lottery.accessPasswordRequired')
  }
  if (pendingJoinNeedsInvite.value && !String(joinInviteCode.value || '').trim()) {
    return t('lottery.inviteCodeRequired')
  }
  return ''
}

async function handleSendCode() {
  // 与后端 body.email toLowerCase 对齐，避免大小写漂移
  const email = loginEmail.value.trim().toLowerCase()
  if (!email.includes('@')) {
    loginError.value = t('lottery.invalidEmail')
    return
  }
  loginEmail.value = email
  if (!pendingJoinDrawId.value) {
    loginError.value = t('lottery.drawNotLoaded')
    return
  }
  const isSpin = accessCodePurposeForIntent(loginModalIntent.value) === 'query'
  // spin 补码不需要活动密码/问卷草稿；join 仍校验
  if (!isSpin) {
    const credErr = validateJoinCredentials()
    if (credErr) {
      loginError.value = credErr
      return
    }
  }
  const draw = draws.value.find((item) => item.id === pendingJoinDrawId.value)
  if (!isSpin && draw && !isDrawJoinable(draw)) {
    loginError.value = joinDisabledText(draw)
    return
  }
  if (!isSpin && draw) {
    const message = validateSubmissionDraft(draw)
    if (message) {
      loginError.value = message
      return
    }
  }
  sendingCode.value = true
  loginError.value = ''
  try {
    const pathKey = publicDrawPathKey(pendingJoinDrawId.value)
    // spin / my-result：purpose=query，已参与也可发码，不走 join 409
    const body: Record<string, unknown> = isSpin
      ? { email, purpose: 'query' }
      : {
          email,
          accessPassword: joinAccessPassword.value.trim() || undefined,
          inviteCode: joinInviteCode.value.trim() || undefined,
          refCode: routeParam('ref'),
          submission: draw ? buildSubmissionPayload(draw) : undefined,
        }
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(pathKey) + '/access-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json() as any
    if (data.ok && data.joined && !isSpin) {
      // 邮箱验证码关闭：直接参与成功（完整收尾 + celebrateKey 氛围）
      joiningId.value = pendingJoinDrawId.value!
      completeJoinSuccess(pendingJoinDrawId.value!, data, { email })
      loginCode.value = ''
      codeSent.value = false
      joiningId.value = ''
    } else if (data.ok && data.sent) {
      codeSent.value = true
      startCooldown(data.expiresInSeconds || 60)
      if (isSpin) showToast(t('lottery.spinCodeSent'), 'success')
    } else if (!isSpin && isAlreadyJoinedResponse(data, res.status)) {
      // join 路径已参与：标已参与；若是 instant 可引导再 spin
      persistSessionEmail(email)
      handleAlreadyJoined(pendingJoinDrawId.value!, { entryId: entryIdFromAlreadyJoined(data) })
    } else {
      loginError.value = data.message || t('lottery.sendFailed')
    }
  } catch {
    loginError.value = t('lottery.networkError')
  } finally {
    sendingCode.value = false
  }
}

async function handleVerifyCode() {
  if (!loginCode.value || loginCode.value.length !== 6) {
    loginError.value = t('lottery.invalidCode')
    return
  }
  if (!pendingJoinDrawId.value) return
  const email = loginEmail.value.trim().toLowerCase()
  if (!email.includes('@')) {
    loginError.value = t('lottery.invalidEmail')
    return
  }
  loginEmail.value = email

  // spin 意图：验证码留给 /spin，不走 verify-join（避免「已参与」与二次 join 纠缠）
  if (shouldVerifyCodeGoToSpin(loginModalIntent.value)) {
    const draw = draws.value.find((item) => item.id === pendingJoinDrawId.value)
    if (!draw || !isInstantLottery(draw)) {
      loginError.value = t('lottery.spinFailed')
      return
    }
    if (!isDrawJoinable(draw)) {
      loginError.value = joinDisabledText(draw)
      return
    }
    persistSessionEmail(email)
    verifyingCode.value = true
    loginError.value = ''
    try {
      const code = loginCode.value.trim()
      await handleInstantSpin(draw, { codeOverride: code })
    } finally {
      verifyingCode.value = false
    }
    return
  }

  const credErr = validateJoinCredentials()
  if (credErr) {
    loginError.value = credErr
    return
  }
  const draw = draws.value.find((item) => item.id === pendingJoinDrawId.value)
  if (draw && !isDrawJoinable(draw)) {
    loginError.value = joinDisabledText(draw)
    return
  }
  if (draw) {
    const message = validateSubmissionDraft(draw)
    if (message) {
      loginError.value = message
      return
    }
  }
  verifyingCode.value = true
  joiningId.value = pendingJoinDrawId.value
  loginError.value = ''
  try {
    const pathKey = publicDrawPathKey(pendingJoinDrawId.value)
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(pathKey) + '/verify-join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        code: loginCode.value.trim(),
        accessPassword: joinAccessPassword.value.trim() || undefined,
        inviteCode: joinInviteCode.value.trim() || undefined,
        refCode: routeParam('ref'),
        submission: draw ? buildSubmissionPayload(draw) : undefined,
      }),
    })
    const data = await res.json() as any
    if (data.ok && data.joined) {
      const joinedDrawId = pendingJoinDrawId.value
      completeJoinSuccess(joinedDrawId, data, { email })
      loginCode.value = ''
      codeSent.value = false
    } else if (isAlreadyJoinedResponse(data, res.status)) {
      // verify-join 可能在验证码成功后返回 409；此时也必须保留刚验证的邮箱，
      // 否则直付秒杀无法在刷新后恢复支付订单。
      persistSessionEmail(email)
      handleAlreadyJoined(pendingJoinDrawId.value!, { entryId: entryIdFromAlreadyJoined(data) })
    } else if (data.soldOut || data.code === 'flash_sale.sold_out') {
      handleFlashSaleSoldOut(pendingJoinDrawId.value!, data.message)
      closeLogin()
    } else {
      loginError.value = data.message || t('lottery.verifyFailed')
    }
  } catch {
    loginError.value = t('lottery.networkError')
  } finally {
    verifyingCode.value = false
    joiningId.value = ''
  }
}

/** 页面从后台回到前台、网络恢复时，立即同步一次动态详情。 */
function refreshWhenVisible() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  void fetchDraws({ silent: true })
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') {
    refreshWhenVisible()
    // 页面回到前台时恢复直付订单轮询（若仍在 pending 且未超时，docs/202 3.3）
    if (paymentState.value && shouldPollPaymentStatus(paymentState.value.status) && Date.now() < paymentPollDeadline) {
      startPaymentPolling()
    }
  } else if (document.visibilityState === 'hidden') {
    // 页面隐藏时暂停轮询，减少无效请求（docs/202 3.3）
    clearPaymentPollTimer()
  }
}

onMounted(async () => {
  void cfAuth.refresh()

  /**
   * docs/162 P2-4：弹窗 body 滚动锁定——多个弹窗叠加时计数器保证
   * 最后一个关闭才真正解锁，避免中间解锁造成穿透。
   */
  watch(
    () => showLoginModal.value || showResult.value || showPaymentModal.value || showMyResultModal.value,
    (anyOpen) => { if (anyOpen) lockBodyScroll(); else unlockBodyScroll() },
    { immediate: false },
  )
  // 回调页可能刚写入 registered_token：同步到 ref（深链首屏）
  const storedTok = sessionStorage.getItem(LOTTERY_REGISTERED_TOKEN_KEY)
  if (storedTok && !registeredToken.value) registeredToken.value = storedTok
  const storedUser = sessionStorage.getItem(LOTTERY_REGISTERED_USERNAME_KEY)
  if (storedUser && !registeredUsername.value) registeredUsername.value = storedUser
  const storedEmail = sessionStorage.getItem(LOTTERY_SESSION_EMAIL_KEY)
  if (storedEmail && !sessionEmail.value) persistSessionEmail(storedEmail)

  // 管理端已登录时同步参与轨，避免顶栏「已登录」与点转盘弹 OTP 矛盾（docs/093）
  await ensureParticipationSessionFromAdmin()

  countdownTimer = setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
  // 每 30 秒静默轮询：不闪 skeleton、不擦失败态（docs/097 P0-3）
  // 已参与该活动后停止自动轮询（避免挂页无限请求浪费资源）；
  // 用户需要看最新数据（开奖结果/参与人数）时点击「刷新状态」手动刷新。
  pollTimer = setInterval(() => {
    const d = draws.value[0]
    const joinedKeys = [d?.id, d?.publicSlug, props.id || ''].filter((k): k is string => Boolean(k))
    const joined = joinedKeys.some((k) => myJoinedById.value[k])
    if (joined) {
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = null
      return
    }
    void fetchDraws({ silent: true })
  }, 30000)
  window.addEventListener('focus', refreshWhenVisible)
  window.addEventListener('online', refreshWhenVisible)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  await Promise.all([fetchDraws(), loadPublicSupportConfig()])
  // 有业务 JWT 时静默回填已参与（刷新后恢复 UI）
  await hydrateJoinedStateFromSession()
  // cf-auth OAuth 往返后：有 pendingJoin + 业务 JWT 则自动参与（docs/059）
  await resumeCfAuthJoinAfterCallback()
  // 直付订单只保存非敏感快照；刷新后重新查状态并继续 pending 轮询，不在浏览器保存卡密明文。
  await restorePaymentSession()
})

onUnmounted(() => {
  if (cooldownTimer) {
    clearInterval(cooldownTimer)
    cooldownTimer = null
  }
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  clearPaymentPollTimer()
  window.removeEventListener('focus', refreshWhenVisible)
  window.removeEventListener('online', refreshWhenVisible)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  stopMyResultCooldown()
  clearResultModalTimer()
  // docs/162 P2-4：组件卸载时强制解锁滚动（计数器归零，防御异常残留）
  forceUnlockBodyScroll()
})
</script>
