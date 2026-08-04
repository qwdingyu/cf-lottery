<template>
  <div class="lottery-view">
    <header class="lottery-header">
      <div class="lottery-header-left">
        <h1 class="lottery-title">{{ drawTitle }}</h1>
        <!-- 深链单活动：只保留分享，不提供「回全部/广场」（docs/055a ADR-055a-1） -->
        <div v-if="isDeepLinked && draws[0]" class="lottery-link-bar">
          <button type="button" class="lottery-share-btn" @click="handleCopyPublicLink(draws[0].id)">📋 {{ $t('lottery.copyShareLink') }}</button>
        </div>
      </div>
      <div class="lottery-header-actions">
        <select class="lang-select" :value="locale" @change="onLanguageChange">
          <option value="zh-CN">中文</option>
          <option value="en">EN</option>
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
              <span class="lottery-tag" :class="draw.status">{{ statusText(draw.status) }}</span>
              <span v-if="resultModeLabel(draw)" class="lottery-tag mode">{{ resultModeLabel(draw) }}</span>
              <span v-if="myWonById[draw.id]" class="lottery-tag won">🎉 {{ $t('lottery.wonTag') }}</span>
              <span v-else-if="isDrawJoined(draw)" class="lottery-tag joined">{{ $t('lottery.joined') }}</span>
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
          <!-- 奖池陈列：诚实展示可赢什么，不宣称「你已中」 -->
          <ul
            v-if="(draw.prizes || []).length"
            class="lottery-prize-strip"
            :aria-label="$t('lottery.prizeStripAria')"
          >
            <li v-for="(p, pi) in draw.prizes" :key="pi" class="lottery-prize-chip">
              <span class="lottery-prize-chip-name">{{ p.name || p.tierName || $t('lottery.productPlaceholder') }}</span>
              <span v-if="p.winnerCount" class="lottery-prize-chip-n">×{{ p.winnerCount }}</span>
            </li>
          </ul>
          <!--
            问卷/投票：提交字段必须在参与前可见可填（此前仅有 draft 逻辑与 CSS，模板未挂载 → 永远校验失败）。
            与 experience 游戏壳解耦：先填内容，再点游戏/底部 CTA 触发 handleJoin。
          -->
          <div
            v-if="requiresActivitySubmission(draw) && draw.status === 'open' && !isDrawJoined(draw)"
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
                  v-else-if="field.type === 'select' || field.type === 'radio'"
                  :value="submissionDrafts[draw.id]?.fields?.[field.id] || ''"
                  :disabled="joiningId === draw.id"
                  @change="setSurveyField(draw.id, field.id, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">{{ $t('lottery.pleaseSelect') }}</option>
                  <option v-for="o in (field.options || [])" :key="o.id" :value="o.id">{{ o.label }}</option>
                </select>
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
          <div class="lottery-game-area">
            <component
              :is="getGameComponent(draw.experienceType || defaultExperienceForParticipation(draw.participationMode || 'open'))"
              :key="draw.id"
              :prizes="(draw.prizes || []).map((p: any) => ({ name: p.name || p.tierName || $t('lottery.productPlaceholder'), color: '', imageUrl: p.imageUrl || '', valueText: p.valueText || '' }))"
              :disabled="joiningId === draw.id || isDrawJoined(draw) || draw.status !== 'open'"
              :loading="joiningId === draw.id"
              :celebrate-key="celebrateKeyById[draw.id] || 0"
              @play="handleJoin(draw.id)"
            />
          </div>
          <!--
            055a P1：有游戏壳时，游戏区即主 CTA（@play → handleJoin），底部不再放第二颗「参与」避免双入口。
            无游戏组件（list/queue 等）时仍用底部按钮。已参与/非 open 仍用底部状态条。
          -->
          <div class="lottery-join-bar">
            <template v-if="draw.status !== 'open'">
              <span class="lottery-join-hint">{{ statusPathHint(draw) || statusText(draw.status) }}</span>
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
            <template v-else-if="isDrawJoined(draw)">
              <span class="lottery-join-hint">✅ {{ $t('lottery.joined') }} · {{ joinedTimeText(draw) }}</span>
              <!-- 查自己的结果始终可点；showWinnerList 只控制公开中奖名单，不挡个人查询 -->
              <button type="button" class="lottery-result-btn" @click="openMyResult(draw)">{{ $t('lottery.queryResult') }}</button>
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
        <h3 class="modal-title">{{ isRegisteredJoin ? $t('lottery.loginAndJoin') : $t('lottery.emailVerify') }}</h3>
        <p class="modal-hint">{{ isRegisteredJoin ? $t('lottery.registeredRequired') : isLoginOnly ? $t('lottery.loginToViewRecords') : $t('lottery.emailVerifyHint') }}</p>

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
          <!-- cf-auth 统一认证（docs/059） -->
          <div v-if="cfAuthEnabled" class="oauth-section" style="margin-top:8px">
            <div class="oauth-divider" style="margin:8px 0"><span class="divider-text" style="font-size:12px;color:var(--tg-hint)">{{ $t('adminLogin.or') }}</span></div>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              style="width:100%"
              :disabled="cfAuthLoading"
              @click="handleCfAuthJoin"
            >{{ $t('adminLogin.cfAuthLogin') }}</button>
          </div>
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
            <!-- cf-auth 统一认证（docs/059） -->
            <div v-if="cfAuthEnabled && !codeSent" class="oauth-section" style="margin-top:8px">
              <div class="oauth-divider" style="margin:8px 0"><span class="divider-text" style="font-size:12px;color:var(--tg-hint)">{{ $t('adminLogin.or') }}</span></div>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                style="width:100%"
                :disabled="cfAuthLoading"
                @click="handleCfAuthJoin"
              >{{ $t('adminLogin.cfAuthLogin') }}</button>
            </div>
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
                  :disabled="verifyingCode"
                  @click="handleVerifyCode"
                >
                  {{ verifyingCode ? $t('lottery.loadingText') : $t('lottery.verifyAndJoin') }}
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

  <!-- 查询我的结果弹窗 -->
  <Teleport to="body">
    <div v-if="showMyResultModal" class="game-result-overlay" @click.self="showMyResultModal = false">
      <div class="game-result-modal">
        <button class="result-close" @click="showMyResultModal = false">✕</button>
        <h2 class="result-title">{{ $t('lottery.myResultTitle') }}</h2>

        <!-- 查询表单：docs/084 按会话态分流 -->
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

          <!-- 以下仅 lottery / claim 抽奖族 -->
          <template v-else-if="!myResultData.won && !isMyResultDrawFinal">
            <div class="result-line">⏳ {{ $t('lottery.resultPendingDraw') }}</div>
            <p class="result-hint">{{ $t('lottery.resultPendingDrawHint') }}</p>
          </template>
          <template v-else-if="myResultData.won">
            <div class="result-line">🎉 <strong>{{ $t('lottery.won') }}</strong></div>
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
 * 用户端抽奖页。
 *
 * 体验要点：
 * - 顶栏会话 +「我的记录」汇总中奖/参与（/lottery/my）
 * - 卡片折叠态即可参与、查单，减少二次点击
 * - 登录后可选自动加入 pendingDrawId
 * - 订单链接使用 history 模式 /order?token=（禁止 hash 路由伪链接）
 * - 个人状态用普通对象（非 Map.set 原地修改）保证 Vue 响应式
 */
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { switchLanguage } from '@/i18n'
import { useToast } from '@/composables/useToast'
import { writeClipboardText } from '@/composables/useClipboard'
import { getGameComponent, hasRegisteredGameExperience } from '@/components/games/GameRegistry'
import GameResultModal from '@/components/games/GameResultModal.vue'
import { useCfAuthLogin } from '@/composables/useCfAuthLogin'
import {
  consumeCfAuthPendingJoin,
  readCfAuthPendingJoin,
  saveCfAuthPendingJoin,
  LOTTERY_REGISTERED_TOKEN_KEY,
  LOTTERY_REGISTERED_USERNAME_KEY,
  LOTTERY_SESSION_EMAIL_KEY,
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
  defaultExperienceForParticipation,
  ambienceMsForExperience,
  gamePrimaryCtaHintKey,
  requiresActivitySubmission,
  normalizePublicDraw,
  getResultCta,
  shouldShowInviteShareCta,
  shouldShowNotWonRecordTag,
  statusHintDrawnI18nKey,
} from './lottery/public-helpers'
import {
  isAlreadyJoinedResponse,
  isSilentFetchOption,
  joinedOpenStatusHintKey,
  readJoinedHints,
  removeJoinedHintsForKeys,
  resolvePublicDrawPathKey,
  upsertJoinedHint,
} from './lottery/joined-session'
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

const loading = ref(true)
const fetchError = ref('')
const recordsLoading = ref(false)
const draws = ref<LotteryDraw[]>([])
const expandedId = ref<string | null>(null)
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
/** 当前登录弹窗对应的活动是否是 registered 模式 */
const isRegisteredJoin = computed(() => {
  if (!pendingJoinDrawId.value) return false
  const draw = draws.value.find(d => d.id === pendingJoinDrawId.value)
  return draw?.participationMode === 'registered'
})
const pendingJoinDraw = computed(() => {
  if (!pendingJoinDrawId.value) return null
  return draws.value.find(d => d.id === pendingJoinDrawId.value) || null
})
const pendingJoinNeedsPassword = computed(() => pendingJoinDraw.value?.participationMode === 'password')
const pendingJoinNeedsInvite = computed(() => pendingJoinDraw.value?.participationMode === 'invite_code')
/**
 * 已有参与 JWT，只差活动密码/邀请码：弹窗不走邮箱 OTP（docs/096）。
 * roster/open 有 JWT 时通常不会进弹窗（直参）。
 */
const pendingJoinCredentialOnly = computed(() => {
  if (!pendingJoinDrawId.value || !registeredToken.value) return false
  return pendingJoinNeedsPassword.value || pendingJoinNeedsInvite.value
})
/** 仅登录查看记录（无具体活动，不需要验证码） */
const isLoginOnly = computed(() => !pendingJoinDrawId.value)

function persistSessionEmail(email: string) {
  sessionEmail.value = email
  if (email) sessionStorage.setItem(LOTTERY_SESSION_EMAIL_KEY, email)
  else sessionStorage.removeItem(LOTTERY_SESSION_EMAIL_KEY)
}

/**
 * 参与成功后氛围动画时长（ms）：先让用户看见游戏反馈，再出结果弹窗，避免遮罩盖住转盘/滚轮。
 * 时长与组件内 celebrate 动画大致对齐；无长动画的体验立即弹窗。动画仍不表示开奖结果。
 */
function ambienceMsForDraw(drawId: string): number {
  const draw = draws.value.find((d) => d.id === drawId)
  return ambienceMsForExperience(draw?.experienceType, draw?.participationMode)
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
  const row: MyEntry = {
    drawId: key,
    joinedAt: extra?.joinedAt || new Date().toISOString(),
    drawName: extra?.drawName || draw?.name || draw?.title || key,
    drawStatus: extra?.drawStatus || draw?.status,
    activityKind,
  }
  const rest = myEntryList.value.filter((r) => r.drawId !== key && r.drawId !== joinedDrawId)
  myEntryList.value = [row, ...rest]
  // 本机提示：无密码学意义；退出登录时 clearJoinedHints（business-session）
  upsertJoinedHint(
    sessionStorage,
    [key, joinedDrawId, draw?.publicSlug || '', props.id || ''],
    {
      drawId: key,
      entryId: extra?.entryId,
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
 */
function handleAlreadyJoined(joinedDrawId: string, opts?: { openResult?: boolean }) {
  markDrawJoined(joinedDrawId)
  closeLogin()
  showToast(t('lottery.alreadyJoinedHint'), 'success')
  if (opts?.openResult !== false) {
    const draw =
      draws.value.find((d) => d.id === joinedDrawId || d.publicSlug === joinedDrawId) || null
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

function completeJoinSuccess(
  joinedDrawId: string,
  data: {
    entryId?: string
    outcome?: ActivityOutcome
    activityKind?: string
    resultMode?: string
  },
  opts?: { email?: string },
) {
  if (opts?.email) persistSessionEmail(opts.email)
  markDrawJoined(joinedDrawId, {
    entryId: data.entryId,
    activityKind: data.activityKind,
    // 抽奖中奖靠 my-result.won；outcome.status 多为 assigned/waitlisted，勿当「已中奖」
    won: data.outcome?.status === 'won',
  })
  if (data.outcome) {
    myOutcomeById.value = { ...myOutcomeById.value, [joinedDrawId]: data.outcome }
  }
  void recordActivityEvent(joinedDrawId, 'participation_completed', {
    activityKind: data.activityKind || '',
    outcomeStatus: data.outcome?.status || '',
  })
  rememberJoinSuccess(joinedDrawId, data.entryId, {
    outcomeLabel: data.outcome?.resultLabel,
    resultMode: data.resultMode,
  })
  // 先触发氛围（转盘/老虎机等），再延迟结果弹窗；动画不表示开奖结果
  celebrateKeyById.value = {
    ...celebrateKeyById.value,
    [joinedDrawId]: (celebrateKeyById.value[joinedDrawId] || 0) + 1,
  }
  showToast(
    data.outcome?.resultLabel
      ? t('lottery.joinSuccessWithOutcome', { outcome: data.outcome.resultLabel })
      : t('lottery.joinSuccess'),
  )
  closeLogin()
  joinAccessPassword.value = ''
  joinInviteCode.value = ''
  // 延迟出弹窗：让 celebrate 动效可见；短路径（submit/form）仍立即展示
  clearResultModalTimer()
  const delayMs = ambienceMsForDraw(joinedDrawId)
  if (delayMs <= 0) {
    showResult.value = true
  } else {
    resultModalTimer = setTimeout(() => {
      resultModalTimer = null
      showResult.value = true
    }, delayMs)
  }
}
/** docs/084：持有业务 JWT 即强会话（registered 按 sub；open 按 JWT.email 免 OTP） */
const myResultHasStrongSession = computed(() => Boolean(registeredToken.value))

/** 头部标题：单活动模式用活动名，多活动模式用默认标题 */
const drawTitle = computed(() => {
  const d = draws.value[0]
  if (d && (draws.value.length === 1 || isDeepLinked.value)) {
    return d.name || d.title || t('lottery.title')
  }
  return t('lottery.title')
})
/** 状态精简文案 */
const statusText = (s: string) =>
  ({ draft: t('lottery.adminDrawDraft'), open: t('lottery.statusOpen'), paused: t('lottery.statusPaused'), drawing: t('lottery.statusDrawing'), drawn: t('lottery.ended'), cancelled: t('lottery.adminDrawCancelled') } as Record<string,string>)[s] || s

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
 * 不推导 experience / participation，只展示 result_mode 诚实语义。
 */
function resultModeLabel(draw: LotteryDraw) {
  const mode = String(draw.resultMode || '').toLowerCase()
  if (mode === 'instant') return t('lottery.resultModeInstantTag')
  if (mode === 'scheduled') return t('lottery.resultModeScheduledTag')
  if (mode === 'manual') return t('lottery.resultModeManualTag')
  // 非抽奖：有标签总比空白好（docs/097）
  if (mode === 'no_result') return t('lottery.adminResultNoResult')
  if (mode === 'vote_tally') return t('lottery.adminResultVoteTally')
  if (mode === 'ordered_assignment' || mode === 'capacity_assignment') {
    return t('lottery.adminResultOrdered')
  }
  return ''
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
  // drawn：抽奖族可说「是否中奖」；其它玩法用中性「查询结果」（docs/104）
  if (draw.status === 'drawn') {
    return t(`lottery.${statusHintDrawnI18nKey(draw.activityKind)}`)
  }
  const key = ({
    draft: 'lottery.statusHintDraft',
    open: '',
    paused: 'lottery.statusHintPaused',
    drawing: 'lottery.statusHintDrawing',
    cancelled: 'lottery.statusHintCancelled',
  } as Record<string, string>)[draw.status]
  return key ? t(key) : ''
}

function isDrawJoined(draw: LotteryDraw): boolean {
  return Boolean(myJoinedById.value[draw.id] || myJoinedById.value[draw.publicSlug || ''])
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
/**
 * 游戏氛围触发器：参与成功后对该 drawId 递增。
 * Wheel/Slot/Grid 等 watch celebrateKey 再播动画，避免「未验证先转盘」。
 */
const celebrateKeyById = ref<Record<string, number>>({})
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

/** 从最近参与的活动数据中提取裂变配置 */
const lastJoinViralConfig = computed(() => {
  if (!lastJoinResult.value) return undefined
  const draw = draws.value.find(d => d.id === lastJoinResult.value!.drawId)
  const pc = (draw as any)?.promotionConfig
  return pc?.viral ?? undefined
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
  myResultEmail.value = sessionEmail.value || ''
  myResultCode.value = ''
  myResultData.value = null
  myResultError.value = ''
  myResultSendingCode.value = false
  stopMyResultCooldown()
  showMyResultModal.value = true
  // docs/084：有业务 JWT 则打开即查（open 系后端用 JWT.email）
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
  // registered：必须 JWT；open 系：有 Bearer 可免 OTP，否则必须邮箱+码
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
      // 查到已参与：回填 joined / 中奖标签（刷新后恢复 UI，docs/097）
      const drawKey = myResultDraw.value.id
      if (data.joined) {
        markDrawJoined(drawKey, { drawStatus: myResultDraw.value.status })
        if (data.won) {
          myWonById.value = { ...myWonById.value, [drawKey]: true }
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

/** 中奖后分享活动链接（仅未终态；归因到当前用户的分享记录） */
async function shareMyWin() {
  if (!showMyResultInviteShare.value) return
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

function openLogin(drawId?: string) {
  pendingJoinDrawId.value = drawId || null
  if (drawId) void recordActivityEvent(drawId, 'participation_started')
  loginError.value = ''
  codeSent.value = false
  loginCode.value = ''
  // 预填会话邮箱，减少二次参与摩擦
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
  loginError.value = ''
  // 保留 loginEmail / 访问凭证不在关闭时强制清空，避免用户误关后重填；成功路径会清凭证
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
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(props.id))
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
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(pathKey) + '/access-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ submission: draw ? buildSubmissionPayload(draw) : undefined }),
    })
    const data = await res.json()
    if (data.ok && data.joined) {
      completeJoinSuccess(drawId, data)
    } else if (isAlreadyJoinedResponse(data, res.status)) {
      handleAlreadyJoined(drawId)
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
      handleAlreadyJoined(drawId)
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
          }),
        },
      )
      const data = (await res.json()) as any
      if (data.ok && data.joined) {
        finishPendingOk()
        completeJoinSuccess(joinKey, data)
      } else if (isAlreadyJoinedResponse(data, res.status)) {
        finishPendingOk()
        handleAlreadyJoined(joinKey)
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
      handleAlreadyJoined(joinKey)
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
  if (draw.status !== 'open') {
    showToast(statusPathHint(draw) || statusText(draw.status), 'error')
    return
  }
  // id 与 publicSlug 任一命中即视为已参与（hints / mark 双键，docs/098）
  if (myJoinedById.value[drawId] || myJoinedById.value[draw.publicSlug || '']) {
    showToast(t('lottery.alreadyJoinedHint'), 'success')
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
  const credErr = validateJoinCredentials()
  if (credErr) {
    loginError.value = credErr
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
    const pathKey = publicDrawPathKey(pendingJoinDrawId.value)
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(pathKey) + '/access-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        // 免码直参时后端 joinDraw 需要凭证；发码路径忽略多余字段
        accessPassword: joinAccessPassword.value.trim() || undefined,
        inviteCode: joinInviteCode.value.trim() || undefined,
        refCode: routeParam('ref'),
        submission: draw ? buildSubmissionPayload(draw) : undefined,
      }),
    })
    const data = await res.json() as any
    if (data.ok && data.joined) {
      // 邮箱验证码关闭：直接参与成功（完整收尾 + celebrateKey 氛围）
      joiningId.value = pendingJoinDrawId.value!
      completeJoinSuccess(pendingJoinDrawId.value!, data, { email })
      loginCode.value = ''
      codeSent.value = false
      joiningId.value = ''
    } else if (data.ok && data.sent) {
      codeSent.value = true
      startCooldown(data.expiresInSeconds || 60)
    } else if (isAlreadyJoinedResponse(data, res.status)) {
      handleAlreadyJoined(pendingJoinDrawId.value!)
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
  const credErr = validateJoinCredentials()
  if (credErr) {
    loginError.value = credErr
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
      handleAlreadyJoined(pendingJoinDrawId.value!)
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

onMounted(async () => {
  void cfAuth.refresh()
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
  pollTimer = setInterval(() => {
    void fetchDraws({ silent: true })
  }, 30000)
  await fetchDraws()
  // 有业务 JWT 时静默回填已参与（刷新后恢复 UI）
  await hydrateJoinedStateFromSession()
  // cf-auth OAuth 往返后：有 pendingJoin + 业务 JWT 则自动参与（docs/059）
  await resumeCfAuthJoinAfterCallback()
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
  stopMyResultCooldown()
  clearResultModalTimer()
})
</script>
