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
              <span v-else-if="myJoinedById[draw.id]" class="lottery-tag joined">{{ $t('lottery.joined') }}</span>
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
          <button class="lottery-share-btn" @click="openLogin(draw.id)">{{ $t('lottery.loginToCheck') }}</button>
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
          <ul v-if="(draw.prizes || []).length" class="lottery-prize-strip" aria-label="prizes">
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
            v-if="requiresActivitySubmission(draw) && draw.status === 'open' && !myJoinedById[draw.id]"
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
              :disabled="joiningId === draw.id || !!myJoinedById[draw.id] || draw.status !== 'open'"
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
                  @click="openLogin(draw.id)"
                >{{ $t('lottery.loginToCheck') }}</button>
                <button
                  v-if="nonOpenSecondaryCta(draw) === 'copy_link'"
                  type="button"
                  class="lottery-result-btn"
                  @click="handleCopyPublicLink(draw.id)"
                >{{ $t('lottery.copyShareLink') }}</button>
              </div>
            </template>
            <template v-else-if="myJoinedById[draw.id]">
              <span class="lottery-join-hint">✅ {{ $t('lottery.joined') }} · {{ joinedTimeText(draw) }}</span>
              <!-- 查自己的结果始终可点；showWinnerList 只控制公开中奖名单，不挡个人查询 -->
              <button type="button" class="lottery-result-btn" @click="openMyResult(draw)">{{ $t('lottery.queryResult') }}</button>
            </template>
            <template v-else-if="hasInteractiveGame(draw)">
              <span class="lottery-join-hint">{{ $t('lottery.gamePrimaryCtaHint') }}</span>
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

    <!-- 我的参与记录 -->
    <section v-if="(sessionEmail || registeredUsername) && sortedMyEntries.length > 0" class="lottery-records">
      <h2 class="lottery-section-title">{{ $t('lottery.myRecords') }}</h2>
      <div v-if="recordsLoading" class="lottery-center">{{ $t('lottery.loadingText') }}</div>
      <div v-else class="lottery-records-list">
        <div v-for="row in sortedMyEntries" :key="row.drawId" class="lottery-record">
          <span class="lottery-record-name">{{ row.drawName || row.drawId }}</span>
          <span v-if="myWonById[row.drawId]" class="lottery-tag won">🎉 {{ $t('lottery.wonTag') }}</span>
          <span v-else-if="row.drawStatus === 'drawn'" class="lottery-tag muted">{{ $t('lottery.notWonTag') }}</span>
          <span v-else class="lottery-tag joined">{{ $t('lottery.joined') }}</span>
        </div>
      </div>
    </section>

    <div v-if="showLoginModal" class="modal-overlay" @click.self="closeLogin" @keydown.escape="closeLogin">
      <div class="modal-content" role="dialog" aria-modal="true" tabindex="-1" ref="loginModalRef" :aria-label="$t('lottery.emailVerify')">
        <h3 class="modal-title">{{ isRegisteredJoin ? $t('lottery.loginAndJoin') : $t('lottery.emailVerify') }}</h3>
        <p class="modal-hint">{{ isRegisteredJoin ? $t('lottery.registeredRequired') : isLoginOnly ? $t('lottery.loginToViewRecords') : $t('lottery.emailVerifyHint') }}</p>

        <!-- 仅登录（无具体活动）：跳转到完整登录页，确保邮箱验证码验证 -->
        <div v-if="isLoginOnly" class="modal-form">
          <p class="field-hint" style="text-align:center;margin-bottom:12px">{{ $t('lottery.loginToViewRecords') }}</p>
          <a href="/admin/login" class="btn btn-primary" style="width:100%;text-align:center;text-decoration:none">{{ $t('landing.login') }}</a>
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
            密码 / 邀请码：后端 joinDraw 强制校验；此前前端从未采集 → 模式活动 100% 参与失败。
            与邮箱码分离：活动访问凭证 ≠ 邮箱 OTP。
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
              <!--
                055a P1：SMS/邮件 OTP 自动填充协议。
                autocomplete=one-time-code + numeric + 仅数字规范化；满 6 位自动校验（见 watch）。
              -->
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
    :viral-config="lastJoinViralConfig"
    @close="showResult = false"
  />

  <!-- 查询我的结果弹窗 -->
  <Teleport to="body">
    <div v-if="showMyResultModal" class="game-result-overlay" @click.self="showMyResultModal = false">
      <div class="game-result-modal">
        <button class="result-close" @click="showMyResultModal = false">✕</button>
        <div class="result-icon">🎫</div>
        <h2 class="result-title">{{ $t('lottery.myResultTitle') }}</h2>

        <!-- 查询表单 -->
        <div v-if="!myResultData" class="result-form">
          <!-- registered 模式：JWT 已证明身份，无需邮箱/验证码 -->
          <template v-if="isRegMyResult">
            <p class="result-hint">{{ $t('lottery.loggedInQueryHint', { name: registeredUsername }) }}</p>
            <p v-if="myResultError" class="result-error">{{ myResultError }}</p>
            <button class="btn btn-primary join-modal-primary" :disabled="myResultLoading" @click="queryMyResult">
              {{ myResultLoading ? $t('lottery.queryingText') : $t('lottery.queryText') }}
            </button>
          </template>
          <template v-else>
            <!-- docs/077：本页可发查询码（purpose=query），不依赖「参与时」旧码 -->
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
                @keyup.enter="queryMyResult"
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
            <p class="result-hint">{{ $t('lottery.resultCodeHint') }}</p>
            <p v-if="myResultError" class="result-error">{{ myResultError }}</p>
            <button class="btn btn-primary join-modal-primary" :disabled="myResultLoading || myResultSendingCode" @click="queryMyResult">
              {{ myResultLoading ? $t('lottery.queryingText') : $t('lottery.queryText') }}
            </button>
          </template>
        </div>

        <!-- 查询结果 -->
        <div v-else class="result-detail">
          <!-- 身份通过但未参与：诚实说明，避免误显示「谢谢参与」 -->
          <template v-if="myResultData.joined === false">
            <div class="result-line">{{ $t('lottery.resultNotJoined') }}</div>
          </template>
          <template v-else-if="myResultData.won">
            <div class="result-line">🎉 <strong>{{ $t('lottery.won') }}</strong></div>
            <div v-if="myResultData.prizeCode" class="result-code-block">
              <span class="result-code-label">{{ $t('lottery.prizeCodeLabel') }}</span>
              <code class="result-code" @click="copyMyResult(myResultData.prizeCode)">{{ myResultData.prizeCode }}</code>
              <small class="result-hint">{{ $t('lottery.clickToCopy') }}</small>
            </div>
            <div class="result-share-win">
              <p class="result-share-hint">🎁 {{ $t('lottery.shareYourLuck') }}</p>
              <button class="btn btn-primary btn-sm" @click="shareMyWin">📤 {{ $t('lottery.shareActivityBtn') }}</button>
            </div>
            <!-- 中奖后 CTA：运营者配置的导流卡片 -->
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
          <template v-else>
            <div class="result-line">😊 {{ $t('lottery.thanksForParticipating') }}</div>
          </template>
          <!-- 未中奖 CTA：运营者配置的导流卡片（安慰奖和未中奖都展示） -->
          <div v-if="myResultData.joined !== false && !myResultData.won && getResultCta(myResultDraw, 'after_loss')" class="result-cta-card">
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
import { getGameComponent } from '@/components/games/GameRegistry'
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
} from '@/composables/cf-auth-session'
import { clearLotteryBrowserSessionOnly } from '@/composables/business-session'
import { isOtpComplete, normalizeOtpDigits } from '@/composables/otp-input'
import {
  publicNonOpenPrimaryCta,
  publicNonOpenSecondaryCta,
  publicStatusBannerTone,
} from '@/composables/lottery-public-ux'
import {
  defaultExperienceForParticipation,
  ambienceMsForExperience,
  requiresActivitySubmission,
  normalizePublicDraw,
  getResultCta,
} from './lottery/public-helpers'
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
  myJoinedById.value = { ...myJoinedById.value, [joinedDrawId]: true }
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
/** 结果查询弹窗对应的活动是否是 registered 模式（决定是否用 JWT 查询） */
const isRegMyResult = computed(() => myResultDraw.value?.participationMode === 'registered')

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
  return ''
}

/**
 * 状态路径提示：主 CTA 旁用完整句子，避免只显示「已结束」等单词。
 * docs/076：draft/paused 说明「为何不能参与 + 下一步」。
 */
function statusPathHint(draw: LotteryDraw) {
  if (myJoinedById.value[draw.id] && draw.status === 'open') {
    return t('lottery.statusHintJoinedPending')
  }
  const key = ({
    draft: 'lottery.statusHintDraft',
    open: '',
    paused: 'lottery.statusHintPaused',
    drawing: 'lottery.statusHintDrawing',
    drawn: 'lottery.statusHintDrawn',
    cancelled: 'lottery.statusHintCancelled',
  } as Record<string, string>)[draw.status]
  return key ? t(key) : ''
}

function nonOpenPrimaryCta(draw: LotteryDraw) {
  return publicNonOpenPrimaryCta({
    status: draw.status,
    joined: Boolean(myJoinedById.value[draw.id]),
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

/** 结果模式：优先用参与时快照，否则读当前活动（弹窗语义用） */
const lastJoinResultMode = computed(() => {
  if (!lastJoinResult.value) return undefined
  if (lastJoinResult.value.resultMode) return lastJoinResult.value.resultMode
  const draw = draws.value.find(d => d.id === lastJoinResult.value!.drawId)
  return draw?.resultMode
})

const lastJoinOutcomeLabel = computed(() => lastJoinResult.value?.outcomeLabel)

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
  // registered + 已登录：打开即查，少一次「点查询」
  if (draw.participationMode === 'registered' && registeredToken.value) {
    void queryMyResult()
  }
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
  // registered 模式：已登录用户带 JWT 直接查询，无需邮箱/验证码；
  // 其他模式仍需邮箱+验证码防枚举
  if (!isReg && (!myResultEmail.value.trim() || !myResultCode.value.trim())) {
    myResultError.value = t('lottery.emailCodeRequired') || ''
    return
  }
  myResultLoading.value = true
  myResultError.value = ''
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    // registered 模式：JWT 即身份证明（后端按 userId 匹配 entry，跳过验证码）
    if (isReg && registeredToken.value) headers['Authorization'] = 'Bearer ' + registeredToken.value
    const res = await fetch(`${API_BASE}/public/draws/${myResultDraw.value.publicSlug}/my-result`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email: isReg ? registeredUsername.value : myResultEmail.value.trim(),
        code: isReg ? '' : myResultCode.value.trim(),
      }),
    })
    const data = await res.json()
    if (data.ok) {
      myResultData.value = data
      // 查到结果后记住邮箱会话，方便「我的记录」
      if (!isReg && myResultEmail.value.trim()) {
        persistSessionEmail(myResultEmail.value.trim())
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
/** 是否已挂载可交互游戏壳（与 GameRegistry 对齐）；有则游戏区即主 CTA，底部不再放第二颗参与按钮 */
function hasInteractiveGame(draw: { experienceType?: string; participationMode?: string }): boolean {
  const exp = draw.experienceType || defaultExperienceForParticipation(draw.participationMode || 'open')
  return getGameComponent(exp) != null
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

async function fetchDraws() {
  loading.value = true
  fetchError.value = ''
  try {
    // 公开页：只支持深链 /lottery/:slug（011 Option C）；无 slug 不做活动广场
    if (!props.id) {
      draws.value = []
      return
    }
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(props.id))
    const data = await res.json() as any
    if (data.ok) {
      const draw = normalizePublicDraw(data, props.id)
      draws.value = [draw]
      ensureSubmissionDraft(draw)
      expandedId.value = draw.id
      trackPageView(draw)
      if (draw.title || draw.name) {
        document.title = (draw.name || draw.title) + ' - ' + t('lottery.title')
      }
      // 详情与列表同源；再拉一次以触发懒开奖等服务端副作用
      void fetchDrawDetail(draw.publicSlug || draw.id)
    } else {
      draws.value = []
      fetchError.value = data.message || t('lottery.noActivity')
    }
  } catch (e) {
    console.error('[lottery] fetch draws failed:', e)
    fetchError.value = t('lottery.networkError')
    draws.value = []
  } finally {
    loading.value = false
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
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(drawId) + '/access-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ submission: draw ? buildSubmissionPayload(draw) : undefined }),
    })
    const data = await res.json()
    if (data.ok && data.joined) {
      completeJoinSuccess(drawId, data)
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
  const email =
    sessionStorage.getItem(LOTTERY_SESSION_EMAIL_KEY) || sessionEmail.value || ''
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
      const res = await fetch(
        API_BASE + '/public/draws/' + encodeURIComponent(joinKey) + '/access-code',
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
    const res = await fetch(
      API_BASE + '/public/draws/' + encodeURIComponent(joinKey) + '/verify-join',
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
  const draw = draws.value.find((item) => item.id === drawId)
  if (!draw) return
  if (draw.status !== 'open') {
    showToast(statusPathHint(draw) || statusText(draw.status), 'error')
    return
  }
  if (myJoinedById.value[drawId]) {
    showToast(t('lottery.joined'), 'success')
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

  // registered 且已登录：跳过弹窗，直参与（核心 UX：游戏点一次就提交）
  if (draw.participationMode === 'registered' && registeredToken.value) {
    pendingJoinDrawId.value = drawId
    await joinWithRegisteredToken(drawId, registeredToken.value)
    return
  }

  // 打开登录/验证弹窗
  openLogin(drawId)
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
  if (!loginEmail.value.includes('@')) {
    loginError.value = t('lottery.invalidEmail')
    return
  }
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
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(pendingJoinDrawId.value) + '/access-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: loginEmail.value.trim(),
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
      completeJoinSuccess(pendingJoinDrawId.value!, data, { email: loginEmail.value.trim() })
      loginCode.value = ''
      codeSent.value = false
      joiningId.value = ''
    } else if (data.ok && data.sent) {
      codeSent.value = true
      startCooldown(data.expiresInSeconds || 60)
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
    const res = await fetch(API_BASE + '/public/draws/' + encodeURIComponent(pendingJoinDrawId.value) + '/verify-join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: loginEmail.value.trim(),
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
      completeJoinSuccess(joinedDrawId, data, { email: loginEmail.value.trim() })
      loginCode.value = ''
      codeSent.value = false
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

  countdownTimer = setInterval(() => {
    nowMs.value = Date.now()
  }, 1000)
  // 每 30 秒轮询活动状态，自动反映开奖/状态变更（P1-4）
  pollTimer = setInterval(() => {
    fetchDraws()
  }, 30000)
  await fetchDraws()
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
