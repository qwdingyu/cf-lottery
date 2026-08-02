<template>
  <div class="lottery-view">
    <header class="page-header">
      <div class="page-header-main">
        <h1>{{ $t('lottery.title') }}</h1>
        <p class="page-subtitle">{{ $t('lottery.pageHint') }}</p>
        <div v-if="isDeepLinked" class="deep-link-bar">
          <RouterLink class="btn btn-ghost btn-sm" to="/lottery">
            {{ $t('lottery.backToAllDraws') }}
          </RouterLink>
          <button
            v-if="draws[0]"
            type="button"
            class="btn btn-ghost btn-sm"
            @click="handleCopyPublicLink(draws[0].id)"
          >
            {{ $t('lottery.copyShareLink') }}
          </button>
        </div>
      </div>
      <div class="session-bar">
        <template v-if="sessionEmail || registeredUsername">
          <span class="session-email" :title="registeredUsername || sessionEmail">{{ registeredUsername || sessionEmail }}</span>
          <button type="button" class="btn btn-ghost btn-sm" @click="handleLogout">
            {{ $t('lottery.logout') }}
          </button>
        </template>
        <button
          v-else
          type="button"
          class="btn btn-primary btn-sm"
          @click="openLogin()"
        >
          {{ $t('lottery.loginFirst') }}
        </button>
      </div>
    </header>

    <!-- 我的记录：登录后汇总参与/中奖，不必逐卡展开 -->
    <section v-if="sessionEmail" class="my-records" aria-labelledby="lottery-my-records">
      <div class="section-head">
        <h2 id="lottery-my-records" class="section-title">{{ $t('lottery.myRecords') }}</h2>
      </div>

      <div v-if="recordsLoading && sortedMyEntries.length === 0" class="records-empty">
        {{ $t('lottery.loadingText') }}
      </div>
      <div v-else-if="sortedMyEntries.length === 0" class="records-empty">
        {{ $t('lottery.noMyRecords') }}
      </div>
      <ul v-else class="records-list">
        <li v-for="row in sortedMyEntries" :key="row.drawId" class="record-row">
          <div class="record-main">
            <span class="record-name">{{ row.drawName || row.drawId }}</span>
            <span class="chip" :class="'chip-' + (row.drawStatus || 'open')">
              {{ statusLabel(row.drawStatus || 'open') }}
            </span>
            <span
              v-if="myWonById[row.drawId]"
              class="chip chip-won"
            >{{ $t('lottery.won') }}</span>
            <span
              v-else-if="row.drawStatus === 'drawn'"
              class="chip chip-muted"
            >{{ $t('lottery.notWon') }}</span>
            <span
              v-else
              class="chip chip-muted"
            >{{ $t('lottery.joined') }}</span>
          </div>
          <div class="record-meta">
            <span v-if="row.joinedAt">{{ $t('lottery.joinedAt') }}: {{ formatTime(row.joinedAt) }}</span>
            <span v-if="row.drawTime">{{ $t('lottery.drawTime') }}: {{ formatTime(row.drawTime) }}</span>
            <RouterLink
              v-if="myWonById[row.drawId]?.orderToken"
              class="order-link"
              :to="{ path: '/order', query: { token: myWonById[row.drawId].orderToken } }"
              @click.stop
            >
              {{ $t('lottery.checkOrder') }}
            </RouterLink>
            <button
              v-else
              type="button"
              class="btn btn-ghost btn-xs"
              @click="focusDraw(row.drawId)"
            >
              {{ $t('lottery.viewDraw') }}
            </button>
          </div>
        </li>
      </ul>
    </section>

    <div v-else class="login-banner">
      <p>{{ $t('lottery.loginBanner') }}</p>
      <button type="button" class="btn btn-primary btn-sm" @click="openLogin()">
        {{ $t('lottery.loginFirst') }}
      </button>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="loading-state">{{ $t('lottery.loadingText') }}</div>

    <!-- 活动列表 -->
    <div v-else-if="draws.length === 0" class="empty-state">
      <p>{{ $t('lottery.noDraws') }}</p>
    </div>

    <div v-else class="draw-list">
      <div
        v-for="draw in draws"
        :key="draw.id"
        class="draw-card"
        :class="{ expanded: expandedId === draw.id }"
        :id="'draw-' + draw.id"
      >
        <div class="draw-card-header" @click="toggleExpand(draw.id)">
          <div class="draw-card-info">
            <h3 class="draw-name">{{ draw.name }}</h3>
            <span class="chip" :class="'chip-' + draw.status">
              {{ statusLabel(draw.status) }}
            </span>
            <span v-if="hasEnded(draw)" class="chip chip-muted">{{ $t('lottery.ended') }}</span>
            <!-- 已满员标记（参与人数达上限） -->
            <span v-else-if="draw.maxParticipants && (draw.entryCount ?? 0) >= draw.maxParticipants" class="chip chip-muted">{{ $t('lottery.full') }}</span>
            <!-- 折叠态也展示个人状态，减少二次点击 -->
            <span v-if="myWonById[draw.id]" class="chip chip-won">{{ $t('lottery.won') }}</span>
            <span v-else-if="myJoinedById[draw.id]" class="chip chip-joined">{{ $t('lottery.joined') }}</span>
          </div>
          <div class="draw-card-meta">
            <span
              v-if="draw.productTitle || draw.productId"
              class="draw-prize"
            >{{ $t('lottery.product') }}: {{ draw.productTitle || draw.productId }}</span>
            <span v-if="draw.showWinners" class="draw-count">{{ $t('lottery.drawCount', { count: draw.entryCount ?? 0 }) }}</span>
            <span class="draw-time">{{ $t('lottery.drawTime') }}: {{ formatTime(draw.drawTime || draw.drawAt || '') }}</span>
            <span
              v-if="countdownText(draw)"
              class="draw-countdown"
            >{{ $t('lottery.countdown') }}: {{ countdownText(draw) }}</span>
            <span
              v-if="draw.status === 'drawn' && draw.showWinners && draw.winnerCount !== undefined && draw.winnerCount > 0"
              class="draw-winners"
            >{{ $t('lottery.actualWinnerCount') }}: {{ draw.winnerCount }}</span>
          </div>
        </div>

        <!-- 折叠态快捷操作：不必展开即可参与/查单 -->
        <div class="draw-card-quick" @click.stop>
          <template v-if="draw.status === 'drawn'">
            <RouterLink
              v-if="myWonById[draw.id]?.orderToken"
              class="btn btn-primary btn-sm"
              :to="{ path: '/order', query: { token: myWonById[draw.id].orderToken } }"
            >
              {{ $t('lottery.checkOrder') }}
            </RouterLink>
            <span v-else-if="sessionEmail && myJoinedById[draw.id]" class="not-won">
              {{ $t('lottery.notWon') }}
            </span>
            <button
              v-else-if="!sessionEmail"
              type="button"
              class="btn btn-ghost btn-sm"
              @click="openLogin()"
            >
              {{ $t('lottery.loginToCheck') }}
            </button>
            <!-- 查询我的结果：输入邮箱+验证码查看中奖卡密/安慰奖券 -->
            <button
              v-if="draw.showWinners"
              type="button"
              class="btn btn-ghost btn-sm"
              @click="openMyResult(draw)"
            >
              查询结果
            </button>
          </template>
          <template v-else-if="draw.status === 'drawing'">
            <span class="drawing-state">{{ $t('lottery.statusDrawing') }}</span>
          </template>
          <template v-else-if="draw.status === 'open'">
            <span v-if="myJoinedById[draw.id]" class="joined-badge">{{ joinedStatusText(draw) }}</span>
            <button
              v-else-if="!sessionEmail"
              type="button"
              class="btn btn-primary btn-sm"
              @click="openLogin(draw.id)"
            >
              {{ $t('lottery.loginFirst') }}
            </button>
            <button
              v-else
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="joiningId === draw.id"
              @click="handleJoin(draw.id)"
            >
              {{ joiningId === draw.id ? '加载中…' : $t('lottery.join') }}
            </button>
          </template>
          <component
            :is="getGameComponent(draw.experienceType || defaultExperienceForParticipation(draw.participationMode || 'open'))"
            v-if="expandedId === draw.id && draw.status === 'open' && !requiresActivitySubmission(draw)"
            :prizes="(draw.prizes || []).map((p: any) => ({ name: p.name || p.tierName || '奖品', color: '', imageUrl: p.imageUrl || '', valueText: p.valueText || '' }))"
            :disabled="joiningId === draw.id"
            @play="handleJoin(draw.id)"
          />
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            @click="toggleExpand(draw.id)"
          >
            {{ expandedId === draw.id ? $t('lottery.collapse') : $t('lottery.expand') }}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :title="$t('lottery.copyShareLink')"
            @click="handleCopyPublicLink(draw.id)"
          >
            {{ $t('lottery.copyShareLink') }}
          </button>
        </div>

        <!-- 展开详情 -->
        <div v-if="expandedId === draw.id" class="draw-card-body">
          <p v-if="draw.description" class="draw-desc">{{ draw.description }}</p>
          <div v-if="draw.prizes && draw.prizes.length > 0" class="prize-showcase">
            <div v-for="prize in draw.prizes" :key="`${prize.tierName || ''}-${prize.name || ''}`" class="prize-card">
              <img :src="prizeImageUrl(prize.imageUrl)" :alt="prize.name || prize.tierName || '奖品'" class="prize-card-img" loading="lazy" />
              <div class="prize-card-body">
                <strong>{{ prize.name || prize.tierName || '奖品' }}</strong>
                <span v-if="prize.valueText" class="prize-value">{{ prize.valueText }}</span>
                <small v-if="prize.description">{{ prize.description }}</small>
                <small v-if="prize.winnerCount">名额 {{ prize.winnerCount }}</small>
              </div>
            </div>
          </div>
          <div class="draw-detail-grid">
            <div v-if="draw.productTitle || draw.productId" class="detail-item">
              <span class="detail-label">{{ $t('lottery.product') }}</span>
              <span class="detail-value">{{ draw.productTitle || draw.productId }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">{{ $t('lottery.joinTime') }}</span>
              <span class="detail-value">{{ formatTime(draw.startTime || draw.startAt || '') }} ~ {{ formatTime(draw.endTime || draw.endAt || '') }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">{{ $t('lottery.drawTime') }}</span>
              <span class="detail-value">{{ formatTime(draw.drawTime || draw.drawAt || '') }}</span>
            </div>
            <div v-if="draw.showWinners" class="detail-item">
              <span class="detail-label">{{ $t('lottery.winnerCount') }}</span>
              <span class="detail-value">
                <template v-if="draw.status === 'drawn' && draw.showWinners && draw.winnerCount !== undefined">
                  {{ $t('lottery.actualWinnerCount') }}: {{ draw.winnerCount }}
                </template>
                <template v-else-if="draw.status !== 'drawn'">
                  {{ $t('lottery.maxWinnerCount') }}: {{ draw.maxWinners }}
                </template>
              </span>
            </div>
            <div v-if="draw.showWinners && draw.maxParticipants" class="detail-item">
              <span class="detail-label">{{ $t('lottery.maxParticipants') }}</span>
              <span class="detail-value">{{ draw.entryCount ?? 0 }} / {{ draw.maxParticipants }}</span>
            </div>
          </div>

          <div class="draw-actions">
            <div v-if="draw.status === 'drawn'" class="result-section">
              <span class="chip chip-drawn">{{ $t('lottery.drawResult') }}</span>
              <template v-if="sessionEmail">
                <div v-if="myWonById[draw.id]" class="won-badge">
                  {{ $t('lottery.won') }}
                  <RouterLink
                    v-if="myWonById[draw.id].orderToken"
                    class="order-link"
                    :to="{ path: '/order', query: { token: myWonById[draw.id].orderToken } }"
                  >
                    {{ $t('lottery.checkOrder') }}
                  </RouterLink>
                </div>
                <div v-else class="not-won">{{ $t('lottery.notWon') }}</div>
              </template>
              <div v-else class="login-prompt">
                <button type="button" class="btn btn-primary btn-sm" @click="openLogin()">
                  {{ $t('lottery.loginToCheck') }}
                </button>
              </div>
            </div>

            <div v-else-if="draw.status === 'drawing'" class="drawing-state">
              {{ $t('lottery.statusDrawing') }}
            </div>

            <div v-else-if="draw.status === 'open'" class="join-section">
              <div v-if="myJoinedById[draw.id]" class="joined-badge">
                {{ joinedStatusText(draw) }}
              </div>
              <div
                v-else-if="requiresActivitySubmission(draw)"
                class="activity-submission"
              >
                <template v-if="draw.activityConfig?.kind === 'vote'">
                  <label
                    v-for="option in draw.activityConfig.options"
                    :key="option.id"
                    class="vote-option"
                  >
                    <input
                      v-model="submissionDrafts[draw.id].optionId"
                      type="radio"
                      :name="'vote-' + draw.id"
                      :value="option.id"
                    />
                    <span>
                      <strong>{{ option.label }}</strong>
                      <small v-if="option.description">{{ option.description }}</small>
                    </span>
                  </label>
                </template>
                <template v-else-if="draw.activityConfig?.kind === 'survey'">
                  <label
                    v-for="field in draw.activityConfig.fields"
                    :key="field.id"
                    class="survey-field"
                  >
                    <span>{{ field.label }}<em v-if="field.required">*</em></span>
                    <textarea
                      v-if="field.type === 'textarea'"
                      v-model="submissionDrafts[draw.id].fields[field.id]"
                      :maxlength="field.maxLength"
                      rows="3"
                    />
                    <select
                      v-else-if="field.type === 'select' || field.type === 'radio'"
                      v-model="submissionDrafts[draw.id].fields[field.id]"
                    >
                      <option value="">请选择</option>
                      <option v-for="option in field.options" :key="option.id" :value="option.id">{{ option.label }}</option>
                    </select>
                    <div v-else-if="field.type === 'checkbox'" class="checkbox-stack">
                      <label v-for="option in field.options" :key="option.id" class="checkbox-option">
                        <input
                          v-model="submissionDrafts[draw.id].fields[field.id]"
                          type="checkbox"
                          :value="option.id"
                        />
                        <span>{{ option.label }}</span>
                      </label>
                    </div>
                    <input
                      v-else
                      v-model="submissionDrafts[draw.id].fields[field.id]"
                      :type="field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text'"
                      :maxlength="field.maxLength"
                    />
                  </label>
                </template>
              </div>
              <!-- 导流：参与成功后展示商品卡片 -->
              <div v-if="myJoinedById[draw.id] && draw.productLink" class="product-card">
                <div class="product-card-inner">
                  <div v-if="draw.productLink.imageUrl" class="product-card-img">
                    <img :src="draw.productLink.imageUrl" :alt="draw.productLink.title" loading="lazy" />
                  </div>
                  <div class="product-card-body">
                    <h4 class="product-card-title">{{ draw.productLink.title }}</h4>
                    <p v-if="draw.productLink.price" class="product-card-price">{{ draw.productLink.price }}</p>
                    <a
                      :href="productUtmUrl(draw.productLink.url, draw.id, draw.publicSlug)"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="btn btn-primary btn-sm"
                      @click="handleCtaClick(draw, 'joined_product_card')"
                    >{{ $t('lottery.viewProduct') }}</a>
                  </div>
                </div>
              </div>
              <!-- 裂变排行榜（活动开启了 leaderboard 时展示） -->
              <ViralLeaderboard
                v-if="getDrawViral(draw)?.leaderboardEnabled"
                :draw-slug="draw.publicSlug || draw.id"
                :entry-id="lastJoinResult?.drawId === draw.id ? lastJoinResult.entryId : undefined"
                :viral-config="getDrawViral(draw)"
              />
              <div v-else-if="!sessionEmail" class="login-prompt">
                <button type="button" class="btn btn-primary" @click="openLogin(draw.id)">
                  {{ $t('lottery.loginFirst') }}
                </button>
              </div>
              <div v-else>
                <button
                  type="button"
                  class="btn btn-primary"
                  :disabled="joiningId === draw.id"
                  @click="handleJoin(draw.id)"
                >
                  {{ joiningId === draw.id ? '加载中…' : $t('lottery.join') }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 登录弹窗 -->
    <div v-if="showLoginModal" class="modal-overlay" @click.self="closeLogin">
      <div class="modal-content" role="dialog" aria-modal="true" :aria-label="$t('lottery.emailVerify')">
        <h3 class="modal-title">{{ isRegisteredJoin ? '登录参与' : $t('lottery.emailVerify') }}</h3>
        <p class="modal-hint">{{ isRegisteredJoin ? '此活动需要注册账号后才能参与' : $t('lottery.emailVerifyHint') }}</p>

        <!-- registered 模式：用户名密码登录 -->
        <div v-if="isRegisteredJoin" class="modal-form">
          <label>
            <span>用户名</span>
            <input v-model="regLoginUsername" type="text" autocomplete="username" @keyup.enter="handleRegisteredLogin" />
          </label>
          <label>
            <span>密码</span>
            <input v-model="regLoginPassword" type="password" autocomplete="current-password" @keyup.enter="handleRegisteredLogin" />
          </label>
          <p v-if="loginError" class="field-hint" style="color:var(--tg-danger)">{{ loginError }}</p>
          <button class="btn btn-primary" style="width:100%" :disabled="regLoginLoading" @click="handleRegisteredLogin">
            {{ regLoginLoading ? '登录中…' : '登录并参与' }}
          </button>
          <p class="field-hint" style="text-align:center;margin-top:8px">
            还没有账号？
            <a href="/admin/register" target="_blank" class="btn btn-ghost btn-xs">去注册</a>
          </p>
        </div>

        <!-- open 模式：邮箱验证码（保留原逻辑） -->
        <div v-else class="modal-form">
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
          <div v-if="codeSent" class="verified-email-row">
            <span>已验证邮箱 {{ loginEmail }}</span>
            <button type="button" class="btn btn-primary btn-sm" :disabled="verifyingCode" @click="handleVerifyCode">
              一键继续
            </button>
            <button type="button" class="btn btn-ghost btn-sm" @click="loginEmail=''; loginCode=''; codeSent=false">
              切换邮箱
            </button>
          </div>
          <div v-if="codeSent" class="code-row">
            <label class="code-label">
              <span>{{ $t('lottery.codePlaceholder') }}</span>
              <input
                v-model="loginCode"
                type="text"
                inputmode="numeric"
                maxlength="6"
                class="code-input"
                autocomplete="one-time-code"
                @keyup.enter="handleVerifyCode"
              />
            </label>
            <span class="code-timer">{{ codeCooldown > 0 ? codeCooldown + 's' : '' }}</span>
          </div>
          <div class="modal-actions">
            <button
              v-if="!codeSent"
              type="button"
              class="btn btn-primary"
              :disabled="sendingCode"
              @click="handleSendCode"
            >
              {{ sendingCode ? '加载中…' : $t('lottery.sendCode') }}
            </button>
            <template v-else>
              <button
                type="button"
                class="btn btn-primary"
                :disabled="verifyingCode"
                @click="handleVerifyCode"
              >
                {{ verifyingCode ? '加载中…' : $t('lottery.verifyAndJoin') }}
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
              {{ $t('app.cancel') }}
            </button>
          </div>
          <p v-if="loginError" class="form-error">{{ loginError }}</p>
        </div>
      </div>
    </div>
  </div>

  <GameResultModal
    :show="showResult"
    :draw-slug="lastJoinDrawSlug"
    :entry-id="lastJoinResult?.entryId"
    :viral-config="lastJoinViralConfig"
    @close="showResult = false"
  />

  <!-- 查询我的结果弹窗 -->
  <Teleport to="body">
    <div v-if="showMyResultModal" class="game-result-overlay" @click.self="showMyResultModal = false">
      <div class="game-result-modal">
        <button class="result-close" @click="showMyResultModal = false">✕</button>
        <div class="result-icon">🎫</div>
        <h2 class="result-title">查询我的结果</h2>

        <!-- 查询表单 -->
        <div v-if="!myResultData" class="result-form">
          <input
            v-model="myResultEmail"
            type="email"
            placeholder="参与时填写的邮箱"
            maxlength="120"
            :disabled="myResultLoading"
          />
          <input
            v-model="myResultCode"
            type="text"
            placeholder="邮箱验证码"
            maxlength="10"
            :disabled="myResultLoading"
          />
          <p class="result-hint">验证码需先在参与/登录时获取（或联系运营），用于验证邮箱归属</p>
          <p v-if="myResultError" class="result-error">{{ myResultError }}</p>
          <button class="btn btn-primary" :disabled="myResultLoading" @click="queryMyResult">
            {{ myResultLoading ? '查询中…' : '查询' }}
          </button>
        </div>

        <!-- 查询结果 -->
        <div v-else class="result-detail">
          <template v-if="myResultData.won">
            <div class="result-line">🎉 <strong>{{ $t('lottery.won') }}</strong></div>
            <div v-if="myResultData.prizeCode" class="result-code-block">
              <span class="result-code-label">{{ $t('lottery.prizeCodeLabel') }}</span>
              <code class="result-code" @click="copyMyResult(myResultData.prizeCode)">{{ myResultData.prizeCode }}</code>
              <small class="result-hint">{{ $t('lottery.clickToCopy') }}</small>
            </div>
            <div class="result-share-win">
              <p class="result-share-hint">🎁 {{ $t('lottery.shareYourLuck') }}</p>
              <button class="btn btn-primary btn-sm" @click="shareMyWin">📤 分享活动</button>
            </div>
            <!-- 中奖后 CTA：运营者配置的导流卡片 -->
            <div v-if="getResultCta(myResultDraw, 'after_win')" class="result-cta-card">
              <a :href="getResultCta(myResultDraw, 'after_win')!.url" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm">
                {{ getResultCta(myResultDraw, 'after_win')!.title || '查看详情' }}
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
          <template v-else>
            <div class="result-line">😊 {{ $t('lottery.thanksForParticipating') }}</div>
          </template>
          <!-- 未中奖 CTA：运营者配置的导流卡片（安慰奖和未中奖都展示） -->
          <div v-if="!myResultData.won && getResultCta(myResultDraw, 'after_loss')" class="result-cta-card">
            <a :href="getResultCta(myResultDraw, 'after_loss')!.url" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm">
              {{ getResultCta(myResultDraw, 'after_loss')!.title || '查看详情' }}
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
 * 用户端抽奖页。
 *
 * 体验要点：
 * - 顶栏会话 +「我的记录」汇总中奖/参与（/lottery/my）
 * - 卡片折叠态即可参与、查单，减少二次点击
 * - 登录后可选自动加入 pendingDrawId
 * - 订单链接使用 history 模式 /order?token=（禁止 hash 路由伪链接）
 * - 个人状态用普通对象（非 Map.set 原地修改）保证 Vue 响应式
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { writeClipboardText } from '@/composables/useClipboard'
import { getGameComponent } from '@/components/games/GameRegistry'
import GameResultModal from '@/components/games/GameResultModal.vue'
import ViralLeaderboard from '@/components/ViralLeaderboard.vue'

const { t, locale } = useI18n()
const { showToast } = useToast()

const props = defineProps<{ id?: string }>()
const router = useRouter()
const route = useRoute()

/** 深链 /lottery/:id 时只展示单活动 */
const isDeepLinked = computed(() => Boolean(props.id && String(props.id).trim()))

const API_BASE = '/api'

type LotteryDraw = {
  id: string; publicSlug?: string; title: string; name?: string; description?: string; status: string;
  activityKind?: string; participationMode: string; experienceType?: string; resultMode?: string; allocationPolicy?: string;
  startAt: string; startTime?: string; endAt: string; endTime?: string; drawAt: string | null; drawTime?: string | null;
  winnerCount: number; maxParticipants?: number | null;
  showParticipantCount: number; showWinnerCount: number; showWinnerList: number;
  showWinners?: boolean; maxWinners?: number;
  participantCount?: number; entryCount?: number; winners?: Array<{ identity: string }>;
  prizes?: Array<{ name?: string; tierName?: string; description?: string; imageUrl?: string; valueText?: string; winnerCount?: number }>;
  productId?: string; productTitle?: string;
  productLink?: { url: string; title: string; imageUrl?: string; price?: string };
  activityConfig?: ActivityConfig;
};

type ActivityConfig =
  | {
      version: 1;
      kind: 'survey';
      fields: Array<{
        id: string;
        label: string;
        type: 'text' | 'email' | 'phone' | 'textarea' | 'select' | 'radio' | 'checkbox';
        required: boolean;
        maxLength: number;
        options: Array<{ id: string; label: string }>;
      }>;
    }
  | {
      version: 1;
      kind: 'vote';
      selection: 'single';
      options: Array<{ id: string; label: string; description: string; imageUrl: string }>;
    };

const DEFAULT_PRIZE_IMAGE = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
  <rect width="160" height="160" rx="18" fill="#1f2937"/>
  <rect x="43" y="66" width="74" height="54" rx="8" fill="#f59e0b"/>
  <rect x="38" y="52" width="84" height="20" rx="7" fill="#fbbf24"/>
  <path d="M80 52c-18-18-38-8-24 12h24V52Zm0 0c18-18 38-8 24 12H80V52Z" fill="#fde68a"/>
  <path d="M77 52h6v68h-6z" fill="#92400e" opacity=".45"/>
</svg>
`)}`

function prizeImageUrl(url?: string) {
  const trimmed = String(url || '').trim()
  return trimmed || DEFAULT_PRIZE_IMAGE
}

type ActivityOutcome = {
  id?: string;
  outcomeType?: string;
  status: string;
  sequenceNo?: number;
  assignmentNo?: number | null;
  resultLabel?: string;
  decidedAt?: string | null;
};

type MyEntry = {
  drawId: string; joinedAt?: string; drawName?: string; drawStatus?: string; drawTime?: string;
};

type ActivityEventType =
  | 'page_view'
  | 'participation_started'
  | 'participation_completed'
  | 'cta_click'

const loading = ref(true)
const recordsLoading = ref(false)
const draws = ref<LotteryDraw[]>([])
const expandedId = ref<string | null>(null)
const sessionEmail = ref('')
/**
 * registered 模式：已登录用户的 JWT token。
 * 存 sessionStorage（会话级）：刷新页面不丢、关闭标签页自动清除；
 * 与后台 admin_token（localStorage）隔离，避免参与登录态污染管理后台入口。
 */
const registeredToken = ref(sessionStorage.getItem('lottery_registered_token') || '')
/** registered 模式：已登录用户名（展示用，随 token 一起会话级持久化） */
const registeredUsername = ref(sessionStorage.getItem('lottery_registered_username') || '')
/** registered 模式登录表单 */
const regLoginUsername = ref('')
const regLoginPassword = ref('')
const regLoginLoading = ref(false)
/** 当前登录弹窗对应的活动是否是 registered 模式 */
const isRegisteredJoin = computed(() => {
  if (!pendingJoinDrawId.value) return false
  const draw = draws.value.find(d => d.id === pendingJoinDrawId.value)
  return draw?.participationMode === 'registered'
})
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
const showResult = ref(false)
/** 参与成功后暂存 drawId + entryId，传递给 GameResultModal 生成归因分享链接 */
const lastJoinResult = ref<{ drawId: string; entryId: string } | null>(null)

// ── 查询我的结果（中奖卡密/安慰奖券） ──
const showMyResultModal = ref(false)
const myResultDraw = ref<LotteryDraw | null>(null)
const myResultEmail = ref('')
const myResultCode = ref('')
const myResultLoading = ref(false)
const myResultData = ref<{ joined: boolean; won: boolean; prizeCode: string | null; consolationCoupon: string | null } | null>(null)
const myResultError = ref('')

/** 从最近参与的活动数据中提取 publicSlug，供 GameResultModal 调用 /share API */
const lastJoinDrawSlug = computed(() => {
  if (!lastJoinResult.value) return undefined
  const draw = draws.value.find(d => d.id === lastJoinResult.value!.drawId)
  return draw?.publicSlug
})

/** 从最近参与的活动数据中提取裂变配置 */
const lastJoinViralConfig = computed(() => {
  if (!lastJoinResult.value) return undefined
  const draw = draws.value.find(d => d.id === lastJoinResult.value!.drawId)
  const pc = (draw as any)?.promotionConfig
  return pc?.viral ?? undefined
})

function openMyResult(draw: LotteryDraw) {
  myResultDraw.value = draw
  myResultEmail.value = sessionEmail.value || ''
  myResultCode.value = ''
  myResultData.value = null
  myResultError.value = ''
  showMyResultModal.value = true
}

async function queryMyResult() {
  if (!myResultDraw.value || !myResultEmail.value.trim() || !myResultCode.value.trim()) {
    myResultError.value = t('lottery.emailCodeRequired') || ''
    return
  }
  myResultLoading.value = true
  myResultError.value = ''
  try {
    const res = await fetch(`${API_BASE}/public/draws/${myResultDraw.value.publicSlug}/my-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: myResultEmail.value.trim(), code: myResultCode.value.trim() }),
    })
    const data = await res.json()
    if (data.ok) {
      myResultData.value = data
    } else {
      myResultError.value = data.message || '查询失败'
    }
  } catch {
    myResultError.value = t('lottery.networkError') || ''
  } finally {
    myResultLoading.value = false
  }
}

function copyMyResult(text: string) {
  if (!text) return
  writeClipboardText(text)
  showToast(t('lottery.copied'), 'success')
}

/** 中奖后分享活动链接（归因到当前用户的分享记录） */
async function shareMyWin() {
  const draw = myResultDraw.value
  if (!draw) return
  const slug = draw.publicSlug || draw.id
  const origin = window.location.origin
  if (lastJoinResult.value && lastJoinResult.value.drawId === draw.id) {
    try {
      const res = await fetch(`${API_BASE}/public/draws/${encodeURIComponent(slug)}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId: lastJoinResult.value.entryId }),
      })
      const data = await res.json()
      if (data.ok && data.shareUrl) {
        await writeClipboardText(origin + data.shareUrl)
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
  if (isDeepLinked.value) { void router.push('/lottery'); return }
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
const codeSent = ref(false)
const sendingCode = ref(false)
const verifyingCode = ref(false)
const codeCooldown = ref(0)
const loginError = ref('')
let cooldownTimer: ReturnType<typeof setInterval> | null = null
let countdownTimer: ReturnType<typeof setInterval> | null = null
const trackedPageViews = new Set<string>()

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

function requiresActivitySubmission(draw: LotteryDraw) {
  return draw.activityConfig?.kind === 'survey' || draw.activityConfig?.kind === 'vote'
}

function buildSubmissionPayload(draw: LotteryDraw): Record<string, unknown> | undefined {
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
    return draft.optionId ? '' : '请选择一个投票选项'
  }
  if (draw.activityConfig?.kind === 'survey') {
    // 防御：fields 未配置时跳过校验
    const fields = Array.isArray(draw.activityConfig.fields) ? draw.activityConfig.fields : []
    for (const field of fields) {
      const value = draft.fields[field.id]
      const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
      if (field.required && empty) return `请填写：${field.label}`
    }
  }
  return ''
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    open: 'statusOpen',
    drawn: 'statusDrawn',
    drawing: 'statusDrawing',
    paused: 'statusPaused',
  }
  return t('lottery.' + (map[status] || 'statusOpen'))
}

function defaultExperienceForParticipation(participationMode: string): string {
  if (participationMode === 'invite_code') return 'slot'
  if (participationMode === 'password') return 'scratch'
  if (participationMode === 'roster') return 'card'
  return 'wheel'
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

/** 距开奖/参与结束的可读倒计时；已过期返回空 */
function countdownText(draw: LotteryDraw): string {
  const targetIso = draw.status === 'open' ? draw.drawTime : ''
  if (!targetIso) return ''
  const target = new Date(targetIso).getTime()
  if (!Number.isFinite(target)) return ''
  const diff = target - nowMs.value
  if (diff <= 0) return ''
  const totalSec = Math.floor(diff / 1000)
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}${t('lottery.days')}`)
  parts.push(`${hours}${t('lottery.hours')}`)
  parts.push(`${minutes}${t('lottery.minutes')}`)
  if (days === 0) parts.push(`${seconds}${t('lottery.seconds')}`)
  return parts.join(' ')
}

/**
 * 从活动 promotionConfig 中提取指定状态的 CTA 配置。
 *
 * 安全：只返回 http/https 协议的外部链接。
 * 纵深防御：后端发布校验（publish-check）已拦截危险协议，这里再兜底一次，
 * 防止历史数据或配置被绕过时 `<a href>` 渲染 javascript: 等危险协议。
 */
function getResultCta(draw: LotteryDraw | null, key: 'after_win' | 'after_loss'): { url: string; title: string } | null {
  if (!draw) return null
  const pc = (draw as any)?.promotionConfig
  const cta = pc?.ctas?.[key]
  if (!cta?.url) return null
  // 协议白名单：仅 http/https，防止 javascript:/data: 等危险协议
  try {
    const parsed = new URL(cta.url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
  } catch {
    return null // 非法 URL 不渲染，避免坏链接和注入
  }
  return { url: cta.url, title: cta.title || '' }
}

/** 活动是否已结束（drawn/cancelled，或 open 态但 drawTime 已过） */
function hasEnded(draw: LotteryDraw): boolean {
  if (draw.status === 'drawn' || draw.status === 'cancelled') return true
  // open 态但 drawTime 已过 → 后端懒开奖还未触发，用户端标记已过期
  // 只对 open 态做时间判断：draft 未开始、paused 可能恢复，都不应标记结束
  if (draw.status === 'open' && draw.drawTime) {
    const t = new Date(draw.drawTime).getTime()
    if (Number.isFinite(t) && t < nowMs.value) return true
  }
  return false
}

function clearSession() {
  sessionEmail.value = ''
  myJoinedById.value = {}
  myWonById.value = {}
  myOutcomeById.value = {}
  myEntryList.value = []
}

function joinedStatusText(draw: LotteryDraw): string {
  const outcome = myOutcomeById.value[draw.id]
  if (draw.activityKind === 'signup_chain') {
    if (outcome?.status === 'waitlisted') return `已接龙 · ${outcome.resultLabel || '候补中'}`
    if (outcome?.status === 'assigned') return `已接龙 · ${outcome.resultLabel || '已占位'}`
    return '已接龙'
  }
  return `${t('lottery.joined')} · ${t('lottery.waitDraw')}`
}

/** 从活动数据中提取裂变配置 */
function getDrawViral(draw: LotteryDraw): { enabled?: boolean; extraEntriesPerInvite?: number; maxExtraEntries?: number; leaderboardEnabled?: boolean } | undefined {
  const pc = (draw as any)?.promotionConfig
  return pc?.viral ?? undefined
}

/** 生成带 UTM 追踪参数的商品链接（使用公开 slug，不暴露内部 ID） */
function productUtmUrl(url: string, drawId: string, publicSlug?: string): string {
  try {
    const u = new URL(url)
    u.searchParams.set('utm_source', 'lottery')
    u.searchParams.set('utm_medium', 'draw')
    // 使用公开 slug 作为 campaign 标识，不暴露内部 ID
    u.searchParams.set('utm_campaign', publicSlug || drawId)
    return u.toString()
  } catch {
    return url
  }
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

function handleCtaClick(draw: LotteryDraw, placement: string) {
  void recordActivityEvent(draw.id, 'cta_click', {
    placement,
    destination: 'product_link',
    activityKind: draw.activityKind || 'lottery',
  })
}

function openLogin(drawId?: string) {
  pendingJoinDrawId.value = drawId || null
  if (drawId) void recordActivityEvent(drawId, 'participation_started')
  loginError.value = ''
  showLoginModal.value = true
}

function closeLogin() {
  showLoginModal.value = false
  pendingJoinDrawId.value = null
  loginError.value = ''
}

function handleLogout() {
  clearSession()
  showToast(t('lottery.loggedOut'))
}

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id
  // 展开详情时调用 GET /lottery/draws/:id 触发懒开奖
  if (expandedId.value === id) {
    const draw = draws.value.find((item) => item.id === id)
    if (draw) ensureSubmissionDraft(draw)
    void fetchDrawDetail(id)
  }
}

function focusDraw(drawId: string) {
  // 列表页无该卡片时（例如仅深链其它活动），跳到该活动深链页
  if (!draws.value.some((d) => d.id === drawId)) {
    void router.push('/lottery/' + encodeURIComponent(drawId))
    return
  }
  expandedId.value = drawId
  void fetchDrawDetail(drawId)
  requestAnimationFrame(() => {
    document.getElementById('draw-' + drawId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })
}

async function handleCopyPublicLink(drawId: string) {
  const draw = draws.value.find(d => d.id === drawId)
  const slug = draw?.publicSlug || drawId
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const url = `${origin}/lottery/${slug}`
  try {
    await writeClipboardText(url)
    showToast(t('lottery.shareLinkCopied'))
  } catch {
    showToast(t('lottery.shareLinkCopyFailed'))
  }
}

async function fetchDrawDetail(id: string) {
  try {
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(id))
    const data = await res.json() as any
    if (data.ok) {
      const idx = draws.value.findIndex((d) => d.id === id)
      if (idx !== -1) {
        draws.value[idx] = { ...draws.value[idx], ...data } as LotteryDraw
        ensureSubmissionDraft(draws.value[idx]!)
      }
    }
  } catch (e) {
    console.error('[lottery] fetch draw detail failed:', e)
  }
}

async function fetchDraws() {
  loading.value = true
  try {
    // 公开活动列表：通过 /api/public/draws/:slug 逐个查询
    // MVP 暂时只支持深链访问，不支持列表页
    if (props.id) {
      const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(props.id))
      const data = await res.json() as any
      if (data.ok) {
        draws.value = [{ ...data, id: props.id } as LotteryDraw]
        ensureSubmissionDraft(draws.value[0]!)
        expandedId.value = props.id
        trackPageView(draws.value[0]!)
        const title = String(data.title || '').trim()
        if (title) document.title = title + ' - 抽奖'
        void fetchDrawDetail(props.id)
      } else {
        draws.value = []
      }
    }
  } catch (e) {
    console.error('[lottery] fetch draws failed:', e)
    draws.value = []
  } finally {
    loading.value = false
  }
}

/** registered 模式：用户名密码登录后直接参与 */
async function handleRegisteredLogin() {
  if (!regLoginUsername.value || !regLoginPassword.value) {
    loginError.value = '请输入用户名和密码'
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
    if (!loginData.ok) { loginError.value = loginData.message || '登录失败'; return }

    const token = loginData.token
    registeredToken.value = token
    registeredUsername.value = regLoginUsername.value
    sessionEmail.value = regLoginUsername.value
    // 会话级持久化：刷新页面免重复登录；关闭标签页自动清除，不残留敏感信息
    sessionStorage.setItem('lottery_registered_token', token)
    sessionStorage.setItem('lottery_registered_username', regLoginUsername.value)

    // 2. 带 JWT 调 access-code（registered 模式后端检测 JWT 后跳过验证码直接参与）
    const draw = draws.value.find(d => d.id === pendingJoinDrawId.value)
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(pendingJoinDrawId.value) + '/access-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ email: registeredUsername.value, submission: draw ? buildSubmissionPayload(draw) : undefined }),
    })
    const data = await res.json()
    if (data.ok && data.joined) {
      const joinedDrawId = pendingJoinDrawId.value
      myJoinedById.value = { ...myJoinedById.value, [joinedDrawId]: true }
      closeLogin()
      showToast('参与成功', 'success')
      void recordActivityEvent(joinedDrawId, 'participation_completed')
    } else {
      loginError.value = data.message || '参与失败'
    }
  } catch {
    loginError.value = '网络错误'
  } finally {
    regLoginLoading.value = false
  }
}

async function handleJoin(drawId: string) {
  const draw = draws.value.find((item) => item.id === drawId)
  if (draw) {
    ensureSubmissionDraft(draw)
    const message = validateSubmissionDraft(draw)
    if (message) {
      showToast(message, 'error')
      expandedId.value = drawId
      return
    }
  }
  // 打开登录弹窗，验证码验证后参与
  pendingJoinDrawId.value = drawId
  void recordActivityEvent(drawId, 'participation_started')
  showLoginModal.value = true
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

async function handleSendCode() {
  if (!loginEmail.value.includes('@')) {
    loginError.value = t('lottery.invalidEmail')
    return
  }
  if (!pendingJoinDrawId.value) {
    loginError.value = '活动未加载，请刷新页面后重试'
    return
  }
  const draw = draws.value.find((item) => item.id === pendingJoinDrawId.value)
  if (draw) {
    const message = validateSubmissionDraft(draw)
    if (message) {
      loginError.value = message
      return
    }
  }
  sendingCode.value = true
  loginError.value = ''
  try {
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(pendingJoinDrawId.value) + '/access-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: loginEmail.value.trim() }),
    })
    const data = await res.json() as any
    if (data.ok && data.sent) {
      codeSent.value = true
      startCooldown(data.expiresInSeconds || 60)
    } else {
      loginError.value = data.message || '发送失败'
    }
  } catch {
    loginError.value = t('lottery.networkError')
  } finally {
    sendingCode.value = false
  }
}

async function handleVerifyCode() {
  if (!loginCode.value || loginCode.value.length !== 6) {
    loginError.value = '请输入 6 位验证码'
    return
  }
  if (!pendingJoinDrawId.value) return
  const draw = draws.value.find((item) => item.id === pendingJoinDrawId.value)
  if (draw) {
    const message = validateSubmissionDraft(draw)
    if (message) {
      loginError.value = message
      return
    }
  }
  verifyingCode.value = true
  loginError.value = ''
  try {
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(pendingJoinDrawId.value) + '/verify-join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: loginEmail.value.trim(),
        code: loginCode.value.trim(),
        refCode: routeParam('ref'),
        submission: draw ? buildSubmissionPayload(draw) : undefined,
      }),
    })
    const data = await res.json() as any
    if (data.ok && data.joined) {
      const joinedDrawId = pendingJoinDrawId.value
      sessionEmail.value = loginEmail.value
      myJoinedById.value = { ...myJoinedById.value, [joinedDrawId]: true }
      if (data.outcome) {
        myOutcomeById.value = { ...myOutcomeById.value, [joinedDrawId]: data.outcome }
      }
      void recordActivityEvent(joinedDrawId, 'participation_completed', {
        activityKind: data.activityKind || '',
        outcomeStatus: data.outcome?.status || '',
      })
      showLoginModal.value = false
      pendingJoinDrawId.value = null
      loginEmail.value = ''
      loginCode.value = ''
      codeSent.value = false
      showToast(data.outcome?.resultLabel ? `参与成功：${data.outcome.resultLabel}` : '参与成功')
      // 暂存参与结果，供 GameResultModal 生成归因分享链接
      if (data.entryId) {
        lastJoinResult.value = { drawId: joinedDrawId, entryId: data.entryId }
      }
      showResult.value = true
    } else {
      loginError.value = data.message || '验证失败'
    }
  } catch {
    loginError.value = '网络错误'
  } finally {
    verifyingCode.value = false
  }
}

onMounted(async () => {
  countdownTimer = setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
  await fetchDraws()
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
})
</script>

<style scoped>
/* 暗色主题：全部使用 base.css 的 CSS 变量，不写死颜色值 */

.lottery-view {
  max-width: 800px;
  margin: 0 auto;
  padding: 16px;
  color: var(--tg-text);
}

.page-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.page-header h1 {
  font-size: 1.5rem;
  margin: 0;
  color: var(--tg-text);
}

.page-subtitle {
  margin: 4px 0 0;
  font-size: 0.85rem;
  color: var(--tg-hint);
}

.deep-link-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.session-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.session-email {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85rem;
  color: var(--tg-hint);
}

.login-banner,
.my-records {
  background: var(--tg-secondary-bg);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  padding: 12px 14px;
  margin-bottom: 16px;
}

.login-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.login-banner p {
  margin: 0;
  color: var(--tg-hint);
  font-size: 0.9rem;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.section-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.records-empty {
  color: var(--tg-hint);
  font-size: 0.9rem;
  padding: 8px 0;
}

.records-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.record-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
}

.record-row:first-child {
  border-top: none;
  padding-top: 0;
}

.record-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.record-name {
  font-weight: 500;
  color: var(--tg-text);
}

.record-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 0.8rem;
  color: var(--tg-hint);
}

.loading-state,
.empty-state {
  text-align: center;
  padding: 40px;
  color: var(--tg-hint);
}

/* ── 活动卡片 ── */
.draw-card {
  background: var(--tg-secondary-bg);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  margin-bottom: 12px;
  transition: border-color var(--duration-fast) ease, box-shadow var(--duration-fast) ease;
  overflow: hidden;
}
.draw-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}
.draw-card.expanded {
  border-color: var(--border-strong);
}

.draw-card-header {
  padding: 16px 16px 8px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  cursor: pointer;
}

.draw-card-info {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.draw-name {
  font-size: 1.1rem;
  margin: 0;
  color: var(--tg-text);
}

.chip {
  display: inline-block;
  padding: 2px 10px;
  border-radius: var(--r-full);
  font-size: 0.75rem;
  line-height: 1.5;
  font-weight: 500;
}
.chip-open {
  background: var(--admin-info-soft);
  color: var(--admin-info);
  border: 1px solid var(--admin-info-border);
}
.chip-drawn {
  background: var(--admin-success-soft);
  color: var(--admin-success);
  border: 1px solid var(--admin-success-border);
}
.chip-drawing {
  background: var(--admin-warning-soft);
  color: var(--admin-warning);
  border: 1px solid var(--admin-warning-border);
}
.chip-paused {
  background: var(--surface);
  color: var(--tg-hint);
  border: 1px solid var(--border);
}
.chip-won {
  background: var(--admin-warning-soft);
  color: var(--admin-warning);
  border: 1px solid var(--admin-warning-border);
}
.chip-joined {
  background: var(--admin-success-soft);
  color: var(--admin-success);
  border: 1px solid var(--admin-success-border);
}
.chip-muted {
  background: var(--surface);
  color: var(--tg-hint);
  border: 1px solid var(--border);
}

.draw-card-meta {
  text-align: right;
  font-size: 0.85rem;
  color: var(--tg-hint);
  flex: 0 0 auto;
}
.draw-prize {
  color: var(--tg-hint);
  font-size: 0.85rem;
}

.draw-count,
.draw-time,
.draw-countdown {
  display: block;
}
.draw-time,
.draw-countdown {
  margin-top: 4px;
}
.draw-countdown {
  color: var(--admin-warning);
  font-variant-numeric: tabular-nums;
}

.draw-card-quick {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 0 16px 12px;
}

.draw-card-body {
  padding: 0 16px 16px;
  border-top: 1px solid var(--border);
}

.draw-desc {
  color: var(--tg-hint);
  margin: 12px 0;
}

.prize-showcase {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.prize-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}

.prize-card-img {
  width: 56px;
  height: 56px;
  border-radius: 8px;
  object-fit: cover;
  background: var(--tg-secondary-bg, #151b28);
  flex: 0 0 auto;
}

.prize-card-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.prize-value {
  color: var(--admin-warning);
  font-weight: 600;
}

.draw-detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}
.detail-item .detail-label {
  display: block;
  font-size: 0.8rem;
  color: var(--tg-hint);
}
.detail-item .detail-value {
  font-size: 0.9rem;
  color: var(--tg-text);
}

.draw-actions {
  margin-top: 12px;
}

/* ── 按钮 ── */
.btn {
  padding: 8px 16px;
  border: none;
  border-radius: var(--r-md);
  cursor: pointer;
  font-size: 0.9rem;
  transition: background var(--duration-fast) ease, opacity var(--duration-fast) ease;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.btn-sm {
  padding: 5px 12px;
  font-size: 0.8rem;
}
.btn-xs {
  padding: 3px 8px;
  font-size: 0.75rem;
}
.btn-primary {
  background: var(--tg-btn);
  color: var(--tg-btn-text);
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--tg-text);
}
.btn-ghost:hover {
  background: var(--surface-hover);
}
.btn-ghost:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ── 状态标识 ── */
.joined-badge {
  color: var(--admin-success);
  font-weight: 500;
  font-size: 0.9rem;
}
.activity-submission {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  margin-bottom: 10px;
}
.vote-option,
.survey-field,
.checkbox-option {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.vote-option,
.survey-field {
  flex-direction: column;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--tg-secondary-bg);
}
.vote-option {
  flex-direction: row;
}
.vote-option small,
.survey-field em {
  display: block;
  color: var(--tg-hint);
  font-style: normal;
  font-size: 0.78rem;
}
.survey-field input,
.survey-field textarea,
.survey-field select {
  width: 100%;
}
.checkbox-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.won-badge {
  color: var(--admin-warning);
  font-weight: 500;
}
.not-won {
  color: var(--tg-hint);
  font-size: 0.9rem;
}
.drawing-state {
  color: var(--admin-warning);
  font-size: 0.9rem;
}
.order-link {
  color: var(--tg-link);
  text-decoration: none;
  font-weight: 500;
}
.order-link:hover {
  text-decoration: underline;
}

/* ── 模态框 ── */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 16px;
}
.modal-content {
  background: var(--tg-secondary-bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-xl);
  padding: 24px;
  width: 100%;
  max-width: 400px;
  box-shadow: var(--shadow-lg);
}
.modal-title {
  margin: 0 0 6px;
  font-size: 1.1rem;
  color: var(--tg-text);
}
.modal-hint {
  margin: 0 0 14px;
  font-size: 0.85rem;
  color: var(--tg-hint);
}

/* ── 表单 ── */
.modal-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.modal-form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  color: var(--tg-text);
}
.modal-form label span {
  font-weight: 500;
  font-size: 12px;
  color: var(--tg-hint);
}
.modal-form input:not([type='checkbox']):not([type='radio']) {
  box-sizing: border-box;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background-color: var(--tg-secondary-bg);
  color: var(--tg-text);
  -webkit-text-fill-color: var(--tg-text);
  font-size: 13px;
  color-scheme: dark;
  line-height: 32px;
}

.code-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.code-label {
  flex: 1;
}
.code-input {
  letter-spacing: 2px;
  font-family: var(--font-mono);
}
.code-timer {
  min-width: 30px;
  color: var(--tg-hint);
  padding-bottom: 6px;
  font-size: 13px;
}

.modal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}

.form-error {
  color: var(--admin-danger);
  font-size: 0.85rem;
  margin: 0;
}

@media (max-width: 520px) {
  .draw-card-header {
    flex-direction: column;
  }
  .draw-card-meta {
    text-align: left;
  }
  .draw-detail-grid {
    grid-template-columns: 1fr;
  }
}

/* 导流商品卡片 */
.product-card {
  margin-top: 12px;
  background: var(--tg-secondary-bg, #151b28);
  border-radius: var(--r-md, 8px);
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  overflow: hidden;
}
.product-card-inner {
  display: flex;
  gap: 12px;
  padding: 12px;
}
.product-card-img {
  width: 80px;
  height: 80px;
  flex-shrink: 0;
  border-radius: 6px;
  overflow: hidden;
  background: var(--tg-bg, #0a0e17);
}
.product-card-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.product-card-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.product-card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--tg-text, #f0f2f5);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.product-card-price {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--admin-accent, #f59e0b);
}

/* 查询我的结果弹窗 */
.game-result-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 1000; display: flex; align-items: center; justify-content: center; }
.game-result-modal { background: var(--tg-bg, #1f2937); border-radius: 16px; padding: 32px 24px; max-width: 360px; width: 90%; text-align: center; position: relative; animation: modalIn .3s ease; }
.result-close { position: absolute; top: 12px; right: 12px; background: none; border: none; font-size: 20px; cursor: pointer; color: var(--tg-hint, #9aa4b2); }
.result-icon { font-size: 48px; margin-bottom: 12px; }
.result-title { font-size: 22px; font-weight: 700; margin-bottom: 16px; }
.result-form { display: flex; flex-direction: column; gap: 10px; }
.result-form input { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border, rgba(255,255,255,.1)); background: var(--tg-secondary-bg, #151b28); color: var(--tg-text, #f0f2f5); font-size: 14px; }
.result-hint { font-size: 12px; color: var(--tg-hint, #9aa4b2); margin: 0; }
.result-error { font-size: 13px; color: #ef4444; margin: 0; }
.result-detail { display: flex; flex-direction: column; gap: 12px; align-items: center; }
.result-line { font-size: 16px; }
.result-cta-card { margin-top: 8px; }
.result-cta-card .btn { display: inline-block; }
.result-code-block { display: flex; flex-direction: column; gap: 4px; align-items: center; background: var(--tg-secondary-bg, #151b28); padding: 12px; border-radius: 8px; width: 100%; }
.result-code-label { font-size: 12px; color: var(--tg-hint, #9aa4b2); }
.result-code { font-size: 16px; font-weight: 700; color: var(--admin-accent, #f59e0b); cursor: pointer; word-break: break-all; }
.result-share-win { margin-top: 12px; text-align: center; }
.result-share-hint { font-size: 12px; color: var(--tg-hint); margin-bottom: 6px; }
</style>
