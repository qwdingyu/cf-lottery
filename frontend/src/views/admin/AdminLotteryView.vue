<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <select v-model="statusFilter" :aria-label="$t('lottery.adminStatus')" @change="loadData">
          <option value="">{{ $t('lottery.adminStatusAll') }}</option>
          <option value="draft">{{ $t('lottery.adminDrawDraft') }}</option>
          <option value="open">{{ $t('lottery.statusOpen') }}</option>
          <option value="paused">{{ $t('lottery.statusPaused') }}</option>
          <option value="drawing">{{ $t('lottery.statusDrawing') }}</option>
          <option value="drawn">{{ $t('lottery.statusDrawn') }}</option>
          <option value="cancelled">{{ $t('lottery.adminDrawCancelled') }}</option>
        </select>
        <input
          v-model="listQuery"
          type="search"
          :placeholder="$t('lottery.adminSearchPlaceholder')"
          :aria-label="$t('lottery.adminSearchAria')"
          @keyup.enter="loadData"
        />
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="loadData">
          {{ $t('lottery.adminReload') }}
        </button>
        <span
          v-if="hasListFilter"
          class="muted-text"
          style="align-self: center; font-size: 12px"
        >{{ $t('lottery.adminListCount', { shown: filteredDraws.length, total: draws.length }) }}</span>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" type="button" :disabled="loading || creating" @click="openTemplatePicker">
          {{ $t('lottery.adminDrawCreate') }}
        </button>
      </div>
    </div>

    <div v-if="selectedCount > 0" class="table-command-actions">
      <span class="selection-summary">
        {{ t('lottery.adminSelectedCount', { count: selectedCount }) }}
      </span>
      <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="clearSelection">
        {{ t('lottery.adminClearSelection') }}
      </button>
      <button class="btn btn-danger btn-sm" :disabled="loading || batchOperating || selectedCount === 0" @click="batchDeleteDraws">
        {{ t('lottery.adminBatchDelete', { count: selectedCount }) }}
      </button>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" type="button" :disabled="loading" @click="loadData">
        {{ $t('lottery.adminReload') }}
      </button>
    </div>

    <div class="notice-card" role="note">
      <strong>{{ $t('lottery.adminNoticeTitle') }}</strong>
      <span>{{ $t('lottery.adminNoticeBody') }}</span>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('adminLayout.menuLottery')" tabindex="0" :aria-busy="loading">
      <table class="admin-table" :aria-label="$t('adminLayout.menuLottery')">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate="selectedCount > 0 && !allVisibleSelected"
                :disabled="loading || batchOperating"
                :aria-label="$t('lottery.adminSelectAll')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('lottery.adminName') }}</th>
            <th>目标 / 类型</th>
            <th class="col-status">{{ $t('lottery.adminStatus') }}</th>
            <th class="col-num">{{ $t('lottery.adminEntryCount') }}</th>
            <th class="col-num">{{ $t('lottery.winnerCount') }}</th>
            <th>{{ $t('lottery.adminEntryWindow') }}</th>
            <th>{{ $t('lottery.drawTime') }}</th>
            <th class="col-actions">{{ $t('lottery.adminActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="9"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="draw in filteredDraws" :key="draw.id" :class="{ 'is-selected': isSelected(draw.id) }">
            <td class="select-cell">
              <input
                type="checkbox"
                :checked="isSelected(draw.id)"
                :disabled="loading || batchOperating || !canDeleteDraw(draw)"
                :aria-label="$t('lottery.adminSelectRow')"
                @change="setSelected(draw.id, ($event.target as HTMLInputElement).checked)"
              />
            </td>
            <td class="col-name">
              <div class="relation-cell">
                <span class="draw-name">{{ draw.title }}</span>
                <small v-if="draw.description" class="draw-desc">{{ draw.description }}</small>
                <small
                  v-if="draw.failureReason"
                  class="failure-snippet"
                  :title="draw.failureReason"
                >
                  {{ $t('lottery.adminFailureReason') }}：{{ shortFailure(draw.failureReason) }}
                </small>
              </div>
            </td>
            <td>
              <div class="relation-cell">
                <span>{{ activityKindLabel(draw.activityKind) }}</span>
                <small class="muted-text">{{ experienceTypeLabel(draw.experienceType) }}</small>
              </div>
            </td>
            <td class="col-status">
              <div class="time-stack">
                <span class="tag" :class="statusClass(draw.status)">
                  {{ statusLabel(draw.status) }}
                </span>
                <small class="muted-text">{{ visibilityLabel(draw) }}</small>
              </div>
            </td>
            <td class="col-num">
              <div class="time-stack time-stack-end">
                <span>{{ entryProgress(draw) }}</span>
                <small v-if="participantsMeta(draw)">{{ participantsMeta(draw) }}</small>
              </div>
            </td>
            <td class="col-num">
              <div class="time-stack time-stack-end">
                <span>
                  <span v-if="draw.winnerCount !== undefined">{{ draw.winnerCount }}</span>
                  <span v-else class="muted-text">-</span>
                  <span class="muted-text"> / {{ draw.maxWinners }}</span>
                </span>
                <small>{{ $t('lottery.adminWinnersOfMax') }}</small>
              </div>
            </td>
            <td>
              <div class="time-stack">
                <span>{{ formatDate(draw.startTime) }}</span>
                <small>{{ $t('lottery.adminWindowTo') }} {{ formatDate(draw.endTime) }}</small>
              </div>
            </td>
            <td>
              <div class="time-stack">
                <span>{{ formatDate(draw.drawTime) }}</span>
              </div>
            </td>
            <td class="col-actions">
              <div class="table-actions">
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  :title="$t('lottery.adminCopyLinkHint')"
                  @click="handleCopyShareLink(draw)"
                >{{ $t('lottery.adminCopyLink') }}</button>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  :title="$t('lottery.adminOpenPublicHint')"
                  @click="handleOpenPublic(draw)"
                >{{ $t('lottery.adminOpenPublic') }}</button>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :title="'生成二维码'"
                  @click="handleShowQrCode(draw)"
                >二维码</button>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :title="'生成海报'"
                  @click="handleShowPoster(draw)"
                >海报</button>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  :title="'查看活动漏斗和外部回传'"
                  @click="handleViewAnalytics(draw)"
                >数据</button>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  :title="$t('lottery.adminDuplicateHint')"
                  @click="handleDuplicate(draw)"
                >{{ $t('lottery.adminDuplicate') }}</button>
                <button
                  v-if="draw.status === 'draft'"
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handleEdit(draw)"
                >{{ $t('lottery.adminEdit') }}</button>
                <button
                  v-if="draw.status === 'draft'"
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handleOpen(draw)"
                >{{ operatingId === draw.id ? '加载中…' : $t('lottery.adminDrawOpen') }}</button>
                <button
                  v-if="draw.status === 'open' && draw.activityKind === 'lottery'"
                  type="button"
                  class="btn btn-primary btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handleDraw(draw)"
                >{{ operatingId === draw.id ? '加载中…' : $t('lottery.adminDrawNow') }}</button>
                <button
                  v-if="draw.status === 'open'"
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handlePause(draw.id)"
                >{{ operatingId === draw.id ? '加载中…' : $t('lottery.adminPause') }}</button>
                <button
                  v-if="draw.status === 'paused'"
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handleResume(draw.id)"
                >{{ operatingId === draw.id ? '加载中…' : $t('lottery.adminResume') }}</button>
                <button
                  v-if="draw.status === 'drawn'"
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handleToggleVisibility(draw.id, draw.visible)"
                >{{ draw.visible ? $t('lottery.adminHide') : $t('lottery.adminShow') }}</button>
                <button
                  v-if="draw.activityKind === 'lottery' && (draw.status === 'drawn' || draw.status === 'drawing')"
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id || winnersLoading"
                  @click="viewWinners(draw.id)"
                >{{ $t('lottery.checkResult') }}</button>
                <button
                  v-if="draw.status === 'drawing'"
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handleRecover(draw.id)"
                >{{ operatingId === draw.id ? '加载中…' : $t('lottery.adminRecoverDrawing') }}</button>
                <button
                  v-if="draw.status === 'drawn'"
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handleRetryEmail(draw.id)"
                >{{ operatingId === draw.id ? '加载中…' : $t('lottery.adminRetryEmail') }}</button>
                <button
                  v-if="draw.status === 'draft' || draw.status === 'open' || draw.status === 'paused'"
                  type="button"
                  class="btn btn-danger btn-xs"
                  :disabled="operatingId === draw.id"
                  @click="handleCancel(draw.id)"
                >{{ $t('lottery.adminDrawCancel') }}</button>
                <button
                  v-if="canDeleteDraw(draw)"
                  type="button"
                  class="btn btn-danger btn-xs"
                  :disabled="batchOperating"
                  @click="handleDelete(draw.id)"
                >{{ $t('lottery.adminDrawDelete') }}</button>
              </div>
            </td>
          </tr>
          <tr v-if="filteredDraws.length === 0">
            <td colspan="9" class="empty-text">{{ hasListFilter ? $t('lottery.adminNoMatch') : $t('lottery.adminNoData') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <AdminPagination
      v-if="pagination.total.value > 0"
      :page="pagination.page.value"
      :total="pagination.total.value"
      :total-pages="pagination.totalPages.value"
      :limit="pagination.limit.value"
      :disabled="loading"
      @prev="pagination.prevPage(); loadData()"
      @next="pagination.nextPage(); loadData()"
      @jump="pagination.setPage($event); loadData()"
      @update:limit="pagination.setLimit($event); loadData()"
    />

    <!-- 创建/编辑活动 -->
    <AdminModal
      v-model="showCreateModal"
      :title="isEditing ? $t('lottery.adminDrawEdit') : $t('lottery.adminDrawCreate')"
      max-width="720px"
      hide-actions
    >
      <form class="modal-form lottery-editor-form" @submit.prevent="handleCreate">
        <div class="lottery-editor-scroll">
          <section class="form-section" aria-labelledby="lottery-basic">
            <header class="form-section-head">
              <h4 id="lottery-basic" class="form-section-title">{{ $t('lottery.adminSectionBasic') }}</h4>
              <p class="form-section-desc">{{ $t('lottery.adminSectionBasicDesc') }}</p>
            </header>
            <div class="form-grid two-cols">
              <label class="field-span-2">
                <span>{{ $t('lottery.adminName') }}</span>
                <input
                  v-model="form.name"
                  maxlength="120"
                  required
                  autocomplete="off"
                  :placeholder="$t('lottery.adminNamePlaceholder')"
                />
              </label>
              <label class="field-span-2" v-if="form.activityKind === 'lottery'">
                <span>奖项配置</span>
                <div class="tier-list">
                  <div v-for="(tier, idx) in form.tiers" :key="idx" class="tier-row">
                    <select v-model="tier.prizeId" class="tier-prize" :disabled="creating">
                      <option value="">选择奖品</option>
                      <option v-for="p in prizeOptions" :key="p.id" :value="p.id">{{ p.name }}</option>
                    </select>
                    <input v-model="tier.tierName" class="tier-name" placeholder="奖项名称" maxlength="50" />
                    <input v-model.number="tier.winnerCount" type="number" class="tier-count" min="1" max="1000" placeholder="名额" />
                    <button type="button" class="btn btn-ghost btn-xs" @click="removeTier(idx)">✕</button>
                  </div>
                  <div class="tier-actions">
                    <button type="button" class="btn btn-ghost btn-xs" :disabled="form.tiers.length >= 10" @click="addTier">
                      + 添加奖项
                    </button>
                    <button v-if="prizeOptions.length === 0" type="button" class="btn btn-ghost btn-xs" @click="goToPrizes">
                      去创建奖品
                    </button>
                    <small class="field-hint">最多 10 个奖项，中奖名额总和不能超过参与人数</small>
                  </div>
                </div>
              </label>
              <label class="field-span-2">
                <span>{{ $t('lottery.adminDescription') }}</span>
                <textarea
                  v-model="form.description"
                  maxlength="500"
                  rows="2"
                  :placeholder="$t('lottery.adminDescriptionPlaceholder')"
                />
              </label>
            </div>
          </section>

          <section class="form-section" aria-labelledby="lottery-time">
            <header class="form-section-head">
              <h4 id="lottery-time" class="form-section-title">{{ $t('lottery.adminSectionTime') }}</h4>
              <p class="form-section-desc">{{ $t('lottery.adminSectionTimeDesc') }}</p>
            </header>

            <div class="time-preset-row" role="group" :aria-label="$t('lottery.adminTimePresets')">
              <button type="button" class="btn btn-ghost btn-xs" @click="applyTimePreset('5m')">
                {{ $t('lottery.adminPreset5m') }}
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click="applyTimePreset('10m')">
                {{ $t('lottery.adminPreset10m') }}
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click="applyTimePreset('20m')">
                {{ $t('lottery.adminPreset20m') }}
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click="applyTimePreset('30m')">
                {{ $t('lottery.adminPreset30m') }}
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click="applyTimePreset('1h')">
                {{ $t('lottery.adminPreset1h') }}
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click="applyTimePreset('1d')">
                {{ $t('lottery.adminPreset1d') }}
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click="applyTimePreset('3d')">
                {{ $t('lottery.adminPreset3d') }}
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click="applyTimePreset('7d')">
                {{ $t('lottery.adminPreset7d') }}
              </button>
            </div>

            <div class="form-grid two-cols">
              <label>
                <span>{{ $t('lottery.adminStartTime') }}</span>
                <input v-model="form.startTime" type="datetime-local" step="60" :lang="locale" required />
                <small class="field-hint">{{ $t('lottery.adminStartTimeHint') }}</small>
              </label>
              <label>
                <span>{{ $t('lottery.adminEndTime') }}</span>
                <input v-model="form.endTime" type="datetime-local" step="60" :lang="locale" required />
                <small class="field-hint">{{ $t('lottery.adminEndTimeHint') }}</small>
              </label>
              <label class="field-span-2">
                <span>{{ $t('lottery.drawTime') }}</span>
                <input v-model="form.drawTime" type="datetime-local" step="60" :lang="locale" required />
                <small class="field-hint">{{ $t('lottery.adminDrawTimeHint') }}</small>
              </label>
            </div>

            <p
              class="time-timeline"
              :class="{ 'is-invalid': Boolean(timeOrderError) }"
              role="status"
            >
              <template v-if="timeOrderError">{{ timeOrderError }}</template>
              <template v-else-if="form.startTime && form.endTime && form.drawTime">
                {{ $t('lottery.adminTimeOrderOk') }}
                <strong>{{ formatLocalInput(form.startTime) }}</strong>
                →
                <strong>{{ formatLocalInput(form.endTime) }}</strong>
                →
                <strong>{{ formatLocalInput(form.drawTime) }}</strong>
              </template>
              <template v-else>{{ $t('lottery.adminTimeOrderHint') }}</template>
            </p>
          </section>

          <section class="form-section" aria-labelledby="lottery-mode">
            <header class="form-section-head">
              <h4 id="lottery-mode" class="form-section-title">参与模式</h4>
              <p class="form-section-desc">选择参与者如何加入活动</p>
            </header>
            <div class="form-grid two-cols">
              <label class="field-span-2">
                <span>活动类型</span>
                <select v-model="form.activityKind" @change="handleActivityKindChange">
                  <option value="lottery">抽奖</option>
                  <option value="signup_chain">接龙 / 报名</option>
                  <option value="claim">资料领取 / 领券</option>
                  <option value="survey">问卷调研</option>
                  <option value="vote">投票评选</option>
                  <option value="checkin">签到 / 打卡</option>
                  <option value="reservation">预约确认</option>
                  <option value="approval">审核申请</option>
                </select>
                <small class="field-hint">活动类型决定结果语义；互动体验只决定前台展示</small>
              </label>
              <label class="field-span-2">
                <span>参与模式</span>
                <select v-model="form.participationMode" @change="handleParticipationModeChange">
                  <option value="open">公开参与（任何人都可参与）</option>
                  <option value="roster">限定名单（仅导入的邮箱可参与）</option>
                  <option value="password">访问密码（输入密码后可参与）</option>
                  <option value="invite_code">邀请码（输入邀请码后可参与）</option>
                </select>
              </label>
              <label class="field-span-2">
                <span>互动体验</span>
                <select v-model="form.experienceType">
                  <option value="wheel">大转盘</option>
                  <option value="slot">老虎机</option>
                  <option value="scratch">刮刮卡</option>
                  <option value="card">卡片翻转</option>
                  <option value="list">接龙列表</option>
                  <option value="queue">排队队列</option>
                  <option value="form">表单提交</option>
                  <option value="ballot">投票选项</option>
                  <option value="calendar">预约日历</option>
                  <option value="checkin">签到按钮</option>
                  <option value="reveal">领取揭晓</option>
                  <option value="grid">九宫格</option>
                  <option value="submit">普通提交</option>
                </select>
                <small class="field-hint">互动体验只影响活动页展示，不决定参与资格或开奖结果</small>
              </label>
              <label v-if="form.activityKind === 'signup_chain'" class="field-span-2">
                <span>名额策略</span>
                <select v-model="form.allocationPolicy">
                  <option value="capacity">满额后拒绝</option>
                  <option value="waitlist">满额后进入候补</option>
                </select>
                <small class="field-hint">接龙结果由后端按参与顺序分配，候补不会占用正式名额</small>
              </label>
              <label v-if="form.participationMode === 'password'" class="field-span-2">
                <span>访问密码</span>
                <input v-model="form.accessPassword" type="text" maxlength="20" placeholder="设置活动访问密码" />
                <small class="field-hint">参与者需要输入此密码才能参与活动</small>
              </label>
              <label v-if="form.participationMode === 'roster'" class="field-span-2">
                <span>导入名单（每行一个邮箱）</span>
                <textarea v-model="rosterInput" rows="5" placeholder="user1@example.com&#10;user2@example.com&#10;user3@example.com" />
                <small class="field-hint">导入后将在创建活动时自动添加名单，已存在的邮箱会被跳过</small>
              </label>
              <label v-if="form.participationMode === 'invite_code'" class="field-span-2">
                <span>生成邀请码数量</span>
                <input v-model.number="inviteCodeCount" type="number" min="1" max="1000" step="1" />
                <small class="field-hint">创建活动后将自动生成指定数量的邀请码，每码可使用 1 次</small>
              </label>
            </div>
          </section>

          <!-- 导流配置：关联商品推广 -->
          <section class="form-section" aria-labelledby="lottery-traffic">
            <header class="form-section-head">
              <h4 id="lottery-traffic" class="form-section-title">导流配置</h4>
              <p class="form-section-desc">关联商品链接，参与者在参与后可见商品卡片</p>
            </header>
            <div class="form-grid two-cols">
              <label class="field-span-2">
                <input v-model="form.enableProductLink" type="checkbox" class="checkbox-inline" />
                <span>关联商品推广</span>
              </label>
              <template v-if="form.enableProductLink">
                <label class="field-span-2">
                  <span>商品链接 *</span>
                  <input v-model="form.productLink.url" type="url" placeholder="https://shop.example.com/product/123" />
                </label>
                <label>
                  <span>商品名称 *</span>
                  <input v-model="form.productLink.title" maxlength="100" placeholder="AI 智能音箱 Pro Max" />
                </label>
                <label>
                  <span>展示价格</span>
                  <input v-model="form.productLink.price" placeholder="¥299" />
                </label>
                <label class="field-span-2">
                  <span>商品图片 URL</span>
                  <input v-model="form.productLink.imageUrl" type="url" placeholder="https://img.example.com/xxx.jpg" />
                </label>
              </template>
            </div>
          </section>

          <!-- 裂变传播配置 -->
          <section class="form-section" aria-labelledby="lottery-viral">
            <header class="form-section-head">
              <h4 id="lottery-viral" class="form-section-title">裂变传播</h4>
              <p class="form-section-desc">开启后参与者分享活动可额外获得抽奖机会，并展示邀请排行榜</p>
            </header>
            <div class="form-grid two-cols">
              <label class="field-span-2">
                <input v-model="form.enableViral" type="checkbox" class="checkbox-inline" />
                <span>开启裂变传播</span>
              </label>
              <template v-if="form.enableViral">
                <label>
                  <span>每邀请 1 人额外获得</span>
                  <input v-model.number="form.viralExtraEntriesPerInvite" type="number" min="1" max="10" />
                  <small>次抽奖机会（建议 1-3）</small>
                </label>
                <label>
                  <span>最多额外获得</span>
                  <input v-model.number="form.viralMaxExtraEntries" type="number" min="1" max="100" />
                  <small>次（建议 10-20）</small>
                </label>
                <label class="field-span-2">
                  <input v-model="form.viralLeaderboardEnabled" type="checkbox" class="checkbox-inline" />
                  <span>展示邀请排行榜</span>
                  <small>参与者可见谁邀请了最多人</small>
                </label>
              </template>
            </div>
          </section>

          <!-- 多状态 CTA 承接：中奖/未中奖不同导流 -->
          <section class="form-section" aria-labelledby="lottery-ctas">
            <header class="form-section-head">
              <h4 id="lottery-ctas" class="form-section-title">CTA 承接配置</h4>
              <p class="form-section-desc">中奖和未中奖用户展示不同的导流卡片，精准承接不同状态</p>
            </header>
            <div class="form-grid two-cols">
              <label class="field-span-2">
                <input v-model="form.enableAfterWinCta" type="checkbox" class="checkbox-inline" />
                <span>中奖后导流卡片</span>
                <small>中奖用户在结果页可见</small>
              </label>
              <template v-if="form.enableAfterWinCta">
                <label class="field-span-2"><span>导流链接 *</span><input v-model="form.afterWinCtaUrl" type="url" placeholder="https://..." /></label>
                <label><span>展示标题</span><input v-model="form.afterWinCtaTitle" maxlength="60" placeholder="中奖了！看看这个" /></label>
              </template>
              <label class="field-span-2">
                <input v-model="form.enableAfterLossCta" type="checkbox" class="checkbox-inline" />
                <span>未中奖导流卡片</span>
                <small>未中奖用户在结果页可见</small>
              </label>
              <template v-if="form.enableAfterLossCta">
                <label class="field-span-2"><span>导流链接 *</span><input v-model="form.afterLossCtaUrl" type="url" placeholder="https://..." /></label>
                <label><span>展示标题</span><input v-model="form.afterLossCtaTitle" maxlength="60" placeholder="没中奖？试试这个" /></label>
              </template>
            </div>
          </section>

          <section
            v-if="form.activityKind === 'survey' || form.activityKind === 'vote'"
            class="form-section"
            aria-labelledby="activity-config"
          >
            <header class="form-section-head">
              <h4 id="activity-config" class="form-section-title">活动内容配置</h4>
              <p class="form-section-desc">配置参与者实际要填写或选择的内容，发布前会由后端再次校验</p>
            </header>

            <div v-if="form.activityKind === 'survey'" class="activity-config-list">
              <div
                v-for="(field, index) in form.activityConfig.fields"
                :key="field.id"
                class="activity-config-row"
              >
                <div class="form-grid two-cols">
                  <label>
                    <span>字段名称</span>
                    <input v-model="field.label" maxlength="80" placeholder="如 公司名称 / 需求说明" />
                  </label>
                  <label>
                    <span>字段类型</span>
                    <select v-model="field.type" @change="normalizeSurveyFieldOptions(field)">
                      <option value="text">短文本</option>
                      <option value="email">邮箱</option>
                      <option value="phone">手机号</option>
                      <option value="textarea">长文本</option>
                      <option value="select">下拉选择</option>
                      <option value="radio">单选</option>
                      <option value="checkbox">多选</option>
                    </select>
                  </label>
                  <label>
                    <span>最大长度</span>
                    <input v-model.number="field.maxLength" type="number" min="1" max="2000" step="1" />
                  </label>
                  <label class="checkbox-label">
                    <input v-model="field.required" type="checkbox" />
                    <span>必填</span>
                  </label>
                </div>
                <div v-if="isChoiceSurveyField(field)" class="choice-options">
                  <label
                    v-for="option in field.options"
                    :key="option.id"
                    class="choice-option-row"
                  >
                    <span>选项</span>
                    <input v-model="option.label" maxlength="80" placeholder="选项名称" />
                    <button type="button" class="btn btn-ghost btn-xs" @click="removeSurveyOption(field, option.id)">删除</button>
                  </label>
                  <button type="button" class="btn btn-ghost btn-xs" @click="addSurveyOption(field)">添加选项</button>
                </div>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="form.activityConfig.fields.length <= 1"
                  @click="removeSurveyField(Number(index))"
                >
                  删除字段
                </button>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" @click="addSurveyField">添加字段</button>
            </div>

            <div v-else class="activity-config-list">
              <div
                v-for="(option, index) in form.activityConfig.options"
                :key="option.id"
                class="activity-config-row"
              >
                <div class="form-grid two-cols">
                  <label>
                    <span>选项名称</span>
                    <input v-model="option.label" maxlength="80" placeholder="如 方案 A" />
                  </label>
                  <label>
                    <span>图片 URL</span>
                    <input v-model="option.imageUrl" type="url" maxlength="2000" placeholder="可选，http/https 图片地址" />
                  </label>
                  <label class="field-span-2">
                    <span>说明</span>
                    <input v-model="option.description" maxlength="300" placeholder="可选，展示给参与者的补充说明" />
                  </label>
                </div>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="form.activityConfig.options.length <= 2"
                  @click="removeVoteOption(Number(index))"
                >
                  删除选项
                </button>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" @click="addVoteOption">添加投票选项</button>
            </div>
          </section>

          <!-- 活动后承接：未中奖自动发券（仅抽奖活动，需显式启用） -->
          <section v-if="form.activityKind === 'lottery'" class="form-section" aria-labelledby="lottery-loserreward">
            <header class="form-section-head">
              <h4 id="lottery-loserreward" class="form-section-title">活动后承接</h4>
              <p class="form-section-desc">未中奖用户自动发放优惠券，把流失用户转化为可再营销的潜在客户</p>
            </header>
            <div class="form-grid two-cols">
              <label class="field-span-2">
                <span>未中奖自动发券</span>
                <select v-model="loserRewardEnabled" @change="syncLoserReward">
                  <option :value="false">关闭</option>
                  <option :value="true">启用</option>
                </select>
                <small class="field-hint">启用后，开奖时自动给未中奖用户发放优惠券码</small>
              </label>
              <label v-if="loserRewardEnabled" class="field-span-2">
                <span>优惠券标签（可选）</span>
                <input v-model="loserRewardCouponLabel" maxlength="50" placeholder="指定发放某个 label 的券池，留空发任意可用券" @change="syncLoserReward" />
                <small class="field-hint">先在「奖品管理 → 优惠券」导入优惠券，可设置标签区分券池</small>
              </label>
            </div>
          </section>

          <section class="form-section" aria-labelledby="lottery-prizes">
            <header class="form-section-head">
              <h4 id="lottery-prizes" class="form-section-title">{{ $t('lottery.adminSectionPrizes') }}</h4>
              <p class="form-section-desc">{{ $t('lottery.adminSectionPrizesDesc') }}</p>
            </header>
            <div class="form-grid two-cols">
              <label v-if="form.activityKind === 'lottery'">
                <span>{{ $t('lottery.winnerCount') }}</span>
                <input v-model.number="form.winnerCount" type="number" min="1" max="9999" step="1" required />
                <small class="field-hint">{{ $t('lottery.winnerCountHint') }}</small>
              </label>
              <label v-else>
                <span>结果规则</span>
                <input :value="resultModeLabel(form.resultMode)" disabled />
                <small class="field-hint">非抽奖活动不配置中奖人数，按活动类型自动分配或记录结果</small>
              </label>
              <label>
                <span>{{ $t('lottery.maxParticipants') }}</span>
                <input
                  v-model.number="form.maxParticipants"
                  type="number"
                  min="1"
                  max="999999"
                  step="1"
                  :placeholder="$t('lottery.maxParticipantsPlaceholder')"
                />
                <small class="field-hint">{{ $t('lottery.maxParticipantsHint') }}</small>
              </label>
              <label>
                <span>{{ $t('lottery.expectedCount') }}</span>
                <input v-model.number="form.expectedParticipants" type="number" min="0" max="999999" step="1" />
                <small class="field-hint">{{ $t('lottery.expectedCountHint') }}</small>
              </label>
              <label>
                <span>{{ $t('lottery.adminDrawLimitPerEmail') }}</span>
                <!-- 后端 UNIQUE(draw_id,email) 强制 1；只读展示 -->
                <input type="number" :value="1" min="1" max="1" disabled />
                <small class="field-hint">{{ $t('lottery.adminLimitHint') }}</small>
              </label>
              <label class="checkbox-label">
                <input v-model="form.showWinners" type="checkbox" />
                <span>{{ $t('lottery.adminShowWinners') }}</span>
                <small class="field-hint">{{ $t('lottery.adminShowWinnersHint') }}</small>
              </label>
            </div>
          </section>
        </div>

        <div class="lottery-editor-footer modal-actions">
          <span style="flex:1" />
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="creating"
            @click="closeEditor"
          >
            {{ $t('lottery.adminCancel') }}
          </button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="creating || Boolean(timeOrderError)">
            {{ creating ? $t('lottery.adminCreating') : (isEditing ? $t('lottery.adminDrawEdit') : $t('lottery.adminDrawCreate')) }}
          </button>
        </div>
      </form>
    </AdminModal>

    <!-- 模板选择弹窗 -->
    <AdminModal v-model="showTemplateModal" title="选择活动模板" max-width="720px">
      <div class="template-grid">
        <button
          v-for="tpl in templates"
          :key="tpl.id"
          class="template-card"
          @click="applyTemplate(tpl)"
        >
          <span class="template-icon">{{ tpl.icon }}</span>
          <span class="template-name">{{ tpl.name }}</span>
          <span class="template-desc">{{ tpl.description }}</span>
          <span class="template-category tag" :class="'tag-' + tpl.category">{{ categoryLabel(tpl.category) }}</span>
        </button>
      </div>
    </AdminModal>

    <!-- 中奖结果 -->
    <AdminModal v-model="showWinnersModal" :title="$t('lottery.drawResult')" max-width="720px">
      <div v-if="winnersLoading" class="empty-text">{{ $t('lottery.adminWinnersLoading') }}</div>
      <div v-else>
        <div class="toolbar" style="margin-bottom: 12px">
          <div class="filters">
            <div
              v-if="winnersModalDrawId && winnersEmailFailureCount > 0"
              class="notice-card"
              role="status"
            >
              <strong>{{ $t('lottery.adminEmailFailureSummary', { count: winnersEmailFailureCount }) }}</strong>
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                :disabled="operatingId === winnersModalDrawId"
                @click="handleRetryEmail(winnersModalDrawId)"
              >{{ $t('lottery.adminRetryEmail') }}</button>
            </div>
          </div>
          <div class="toolbar-actions">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="winners.length === 0"
              @click="handleExportWinners"
            >{{ $t('lottery.adminExportWinners') }}</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>{{ $t('lottery.adminEmail') }}</th>
                <th>{{ $t('lottery.adminOrderNo') }}</th>
                <th>{{ $t('lottery.adminCards') }}</th>
                <th>{{ $t('lottery.adminEmailStatus') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="w in winners" :key="w.id">
                <td>{{ w.email }}</td>
                <td>
                  <RouterLink
                    v-if="w.orderNo"
                    class="btn btn-ghost btn-xs"
                    :to="{ path: '/admin/orders', query: { q: String(w.orderNo).slice(0, 120) } }"
                    :title="$t('lottery.adminSearchOrders')"
                  >{{ w.orderNo }}</RouterLink>
                  <span v-else class="muted-text">-</span>
                </td>
                <td>
                  <div class="relation-cell">
                    <span>{{ w.cardAccountLabel || '-' }}</span>
                    <small v-if="w.cardDeliverySecret" class="muted-text">{{ w.cardDeliverySecret }}</small>
                  </div>
                </td>
                <td>
                  <span class="tag" :class="emailStatusClass(w)" :title="w.emailError || undefined">
                    {{ emailStatusLabel(w) }}
                  </span>
                </td>
              </tr>
              <tr v-if="winners.length === 0">
                <td colspan="4" class="empty-text">{{ $t('lottery.adminNoData') }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </AdminModal>

    <ConfirmDialog v-model="confirmVisible" :message="confirmMessage" @confirm="onConfirm" />

    <!-- 活动数据：平台内漏斗 + 外部系统显式回传 -->
    <AdminModal v-model="showAnalyticsModal" title="活动数据" max-width="860px">
      <div class="analytics-modal-body">
        <div class="analytics-modal-head">
          <div>
            <h3>{{ analyticsDraw?.title || '-' }}</h3>
            <p>平台事件只代表浏览、参与和点击；外部转化只来自 API Key 回传。</p>
          </div>
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            :disabled="analyticsLoading || !analyticsDraw"
            @click="analyticsDraw && handleViewAnalytics(analyticsDraw)"
          >刷新</button>
        </div>

        <div v-if="analyticsLoading" class="empty-text">加载中...</div>
        <div v-else-if="analyticsError" class="table-error" role="alert">
          <span>{{ analyticsError }}</span>
        </div>
        <template v-else>
          <div class="analytics-grid">
            <div v-for="item in analyticsFunnelCards" :key="item.key" class="analytics-card">
              <span class="analytics-value">{{ item.value }}</span>
              <span class="analytics-label">{{ item.label }}</span>
            </div>
          </div>

          <div class="analytics-section">
            <h4>关键比率</h4>
            <div class="analytics-rates">
              <div>
                <span>{{ completionRate }}</span>
                <small>完成 / 浏览</small>
              </div>
              <div>
                <span>{{ ctaRate }}</span>
                <small>CTA / 完成</small>
              </div>
              <div>
                <span>{{ externalConversionRate }}</span>
                <small>外部回传 / CTA</small>
              </div>
            </div>
          </div>

          <div class="analytics-section">
            <div class="analytics-section-head">
              <h4>外部回传类型</h4>
              <span class="muted-text">只统计外部系统显式上报的事实</span>
            </div>
            <div v-if="conversionTypeRows.length > 0" class="analytics-type-list">
              <div v-for="row in conversionTypeRows" :key="row.type">
                <span>{{ conversionTypeLabel(row.type) }}</span>
                <strong>{{ row.count }}</strong>
                <small v-if="row.amountCents > 0">{{ row.amountCents }} 分</small>
              </div>
            </div>
            <p v-else class="empty-text">暂无外部转化回传</p>
          </div>

          <div class="analytics-section">
            <div class="analytics-section-head">
              <h4>最近回传</h4>
              <button
                class="btn btn-ghost btn-xs"
                type="button"
                :disabled="analyticsConversions.length === 0"
                @click="handleExportConversions"
              >导出 CSV</button>
            </div>
            <div class="table-wrap analytics-table-wrap">
              <table class="admin-table">
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>来源</th>
                    <th>外部事件</th>
                    <th>身份</th>
                    <th>金额</th>
                    <th>发生时间</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in analyticsConversions" :key="item.id">
                    <td>{{ conversionTypeLabel(item.conversionType) }}</td>
                    <td>{{ item.source || '-' }}</td>
                    <td>{{ item.externalEventId }}</td>
                    <td>{{ conversionIdentity(item) }}</td>
                    <td>{{ conversionAmount(item) }}</td>
                    <td>{{ formatDate(item.occurredAt) }}</td>
                  </tr>
                  <tr v-if="analyticsConversions.length === 0">
                    <td colspan="6" class="empty-text">暂无外部回传记录</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </div>
    </AdminModal>

    <!-- 二维码弹窗 -->
    <AdminModal v-model="showQrModal" title="活动二维码" max-width="400px">
      <div class="qr-modal-body">
        <img :src="qrImageUrl" alt="活动二维码" class="qr-image" />
        <p class="qr-hint">扫描二维码参与活动</p>
        <div class="qr-actions">
          <button class="btn btn-primary btn-sm" @click="handleDownloadQr">下载二维码</button>
          <button class="btn btn-ghost btn-sm" @click="handleCopyQrLink">复制链接</button>
        </div>
      </div>
    </AdminModal>

    <!-- 海报弹窗 -->
    <AdminModal v-model="showPosterModal" title="活动海报" max-width="500px">
      <div class="poster-modal-body">
        <!-- 海报预览：显示已生成的 PNG（或加载中） -->
        <div class="poster-preview-wrap">
          <img v-if="posterDataUrl" :src="posterDataUrl" alt="活动海报" class="poster-preview" />
          <div v-else class="poster-loading">{{ posterGenerating ? '生成中…' : '加载中…' }}</div>
        </div>
        <div class="poster-actions">
          <button class="btn btn-primary btn-sm" :disabled="posterGenerating || !posterDataUrl" @click="handleDownloadPoster">
            下载海报
          </button>
          <button class="btn btn-ghost btn-sm" @click="showPosterModal = false">关闭</button>
        </div>
      </div>
    </AdminModal>

    <!-- 海报模板（隐藏 DOM，html-to-image 截图用） -->
    <div v-show="showPosterModal" ref="posterDomRef" class="poster-template" aria-hidden="true">
      <div class="poster-template-bg">
        <div class="poster-template-orb poster-template-orb-1"></div>
        <div class="poster-template-orb poster-template-orb-2"></div>
        <div class="poster-template-orb poster-template-orb-3"></div>
      </div>
      <div class="poster-template-content">
        <div class="poster-brand">{{ posterPlatformName }}</div>
        <div class="poster-kind">{{ posterKindLabel }}</div>
        <h2 class="poster-title">{{ (posterDrawData?.title || '活动').slice(0, 18) }}</h2>

        <div class="poster-prizes" v-if="posterPrizeList.length > 0">
          <div v-for="(p, i) in posterPrizeList.slice(0, 3)" :key="i" class="poster-prize-row">
            <span class="poster-prize-medal">{{ ['🏆','🥈','🥉'][i] || '🎁' }}</span>
            <span class="poster-prize-name">{{ p }}</span>
          </div>
        </div>
        <div v-else class="poster-prizes-empty">🎁 惊喜大奖等你来</div>

        <div class="poster-time" v-if="posterTimeText">{{ posterTimeText }}</div>

        <div class="poster-qr-wrap">
          <img v-if="posterQrImageUrl" :src="posterQrImageUrl" alt="活动二维码" class="poster-qr" />
          <div class="poster-qr-hint">长按识别二维码<br />立即参与</div>
        </div>

        <div class="poster-footer">由抽奖平台提供技术支持</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 抽奖管理页 — cf-lottery 适配版。
 */
import { computed, ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { toPng } from 'html-to-image'
import QRCode from 'qrcode'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useTableSelection } from '@/composables/useTableSelection'
import { formatDate, dateTimeLocalToIso, toDateTimeLocalValue } from '@/composables/useFormat'
import { writeClipboardText } from '@/composables/useClipboard'
import AdminModal from '@/components/AdminModal.vue'
import AdminPagination from '@/components/AdminPagination.vue'
import { useTablePagination } from '@/composables/useTablePagination'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { adminRequest } from '@/composables/useAdminRequest'


type LotteryDraw = {
  id: string; tenantId: string; publicSlug: string; title: string; name?: string; description: string;
  status: string; activityKind: string; participationMode: string; experienceType: string; drawTrigger: string; resultMode: string; allocationPolicy?: string; policyVersion: number;
  startAt: string; startTime?: string; endAt: string; endTime?: string; drawAt: string | null; drawTime?: string | null;
  winnerCount: number; maxParticipants: number | null;
  maxWinners?: number; expectedParticipants?: number; entryCount?: number; visible?: number;
  showParticipantCount: number; showWinnerCount: number; showWinnerList: number;
  drawnAt: string | null; failureReason: string;
  activityConfig?: ActivityConfigForm;
  createdAt: string; updatedAt: string;
};

type SurveyFieldType = 'text' | 'email' | 'phone' | 'textarea' | 'select' | 'radio' | 'checkbox'
type SurveyFieldForm = {
  id: string;
  label: string;
  type: SurveyFieldType;
  required: boolean;
  maxLength: number;
  options: Array<{ id: string; label: string }>;
}
type ActivityConfigForm =
  | { version: 1; kind: 'survey'; fields: SurveyFieldForm[] }
  | { version: 1; kind: 'vote'; selection: 'single'; options: Array<{ id: string; label: string; description: string; imageUrl: string }> }
  | {
      version?: 1;
      kind?: string;
      fields?: SurveyFieldForm[];
      options?: Array<{ id: string; label: string; description?: string; imageUrl?: string }>;
      /** 未中奖自动发券（安慰奖）：仅 lottery 活动生效，enabled 默认 false */
      loserReward?: { enabled: boolean; couponLabel: string };
    };

type LotteryWinner = {
  id: string; drawId: string; tierId: string; entryId: string;
  identityType: string; identityValue: string; prizeCodeId: string;
  drawnAt: string; notificationStatus: string; notificationError: string;
  email?: string; orderNo?: string; cardAccountLabel?: string; cardDeliverySecret?: string;
  emailSent?: number; emailError?: string;
};

type ActivityEventSummary = {
  totals: Record<string, number>;
  pageViews: number;
  participationCompleted: number;
  ctaClicks: number;
  shareClicks: number;
  attributedJoins: number;
  externalConversionsReported: number;
};

type ExternalConversionSummary = {
  totalCount: number;
  totalAmountCents: number;
  totals: Record<string, { count: number; amountCents: number }>;
};

type DrawAnalyticsStats = {
  entryCount: number;
  events: ActivityEventSummary;
  externalConversions: ExternalConversionSummary;
};

type PublishCheckItem = {
  code: string;
  message: string;
  section: string;
};

type PublishCheckResult = {
  canPublish: boolean;
  errors: PublishCheckItem[];
  warnings: PublishCheckItem[];
  infos: PublishCheckItem[];
};

type ExternalConversion = {
  id: string;
  drawId: string;
  entryId: string;
  externalEventId: string;
  conversionType: string;
  source: string;
  refCode: string;
  amountCents: number | null;
  currency: string;
  identityType: string;
  identityValue: string;
  payloadJson: string;
  occurredAt: string;
  createdAt: string;
};

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const { showToast } = useToast()
useAdminAuth()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()

// ── 兼容旧 API 调用（适配到新后端） ──

const fetchLotteryDraws = async (params: { limit: number; offset: number; status?: string; query?: string }) => {
  const search = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) })
  if (params.status) search.set('status', params.status)
  if (params.query) search.set('query', params.query)
  return adminRequest<{ draws: LotteryDraw[]; total: number }>(`/api/admin/draws?${search}`)
}
const createLotteryDraw = async (body: any) => adminRequest<{ id: string; publicSlug: string }>('/api/admin/draws', { method: 'POST', body: JSON.stringify(body) });
const updateLotteryDraw = async (id: string, body: any) => adminRequest(`/api/admin/draws/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
const fetchPublishCheck = async (id: string) => adminRequest<PublishCheckResult>(`/api/admin/draws/${id}/publish-check`);
const openLotteryDraw = async (id: string) => adminRequest(`/api/admin/draws/${id}/publish`, { method: 'POST' });
const performLotteryDraw = async (id: string) => adminRequest(`/api/admin/draws/${id}/draw`, { method: 'POST' });
const cancelLotteryDraw = async (id: string) => adminRequest(`/api/admin/draws/${id}/cancel`, { method: 'POST' });
const deleteLotteryDraw = async (id: string) => adminRequest(`/api/admin/draws/${id}`, { method: 'DELETE' });
const fetchLotteryWinners = async (id: string) => adminRequest<{ winners: LotteryWinner[] }>(`/api/admin/draws/${id}/winners`);
const fetchDrawAnalyticsStats = async (id: string) => adminRequest<DrawAnalyticsStats>(`/api/admin/draws/${id}/stats`);
const fetchDrawConversions = async (id: string) => adminRequest<{ conversions: ExternalConversion[]; summary: ExternalConversionSummary }>(`/api/admin/draws/${id}/conversions?limit=50`);
const fetchAdminLottery = async (path: string, method: string) => adminRequest(path, { method });
const retryAdminLotteryEmail = async (id: string) => adminRequest<{ sent: number; failed: number }>(`/api/admin/draws/${id}/retry-email`, { method: 'POST' });
const recoverLotteryDraw = async (id: string) => adminRequest<{ healed: 'drawn' | 'open' }>(`/api/admin/draws/${id}/recover`, { method: 'POST' });

// ── 内联 lottery-ops 函数 ──
const countLotteryEmailFailures = (winners: LotteryWinner[]) => winners.filter(w => w.notificationStatus === 'failed').length;
const formatLotteryEntryProgress = (count?: number | null, max?: number | null) => max ? `${count ?? 0} / ${max}` : `${count ?? 0}`;
const formatLotteryVisibilityLabel = (visible: number | undefined | null, labels: { public: string; hidden: string }) => visible ? labels.public : labels.hidden;
const buildLotteryWinnersCsvRows = (winners: LotteryWinner[], labels: any) => {
  const header = [labels.email, labels.emailStatus];
  const rows = winners.map((w: any) => [w.identityValue, w.notificationStatus === 'sent' ? labels.sent : w.notificationStatus === 'failed' ? labels.failed : labels.pending]);
  return [header, ...rows];
};
const buildLotteryDuplicateDraft = (draw: any, opts: { nameSuffix: string; defaultName: string }) => ({
  name: draw.title ? `${draw.title}${opts.nameSuffix}` : opts.defaultName,
  description: draw.description || '',
  prizeName: '',
  startTime: draw.startAt ? toDateTimeLocalValue(draw.startAt) : '',
  endTime: draw.endAt ? toDateTimeLocalValue(draw.endAt) : '',
  drawTime: draw.drawAt ? toDateTimeLocalValue(draw.drawAt) : '',
  winnerCount: draw.winnerCount || 1,
  maxParticipants: draw.maxParticipants || null,
  participationMode: draw.participationMode || 'open',
  activityKind: draw.activityKind || 'lottery',
  allocationPolicy: draw.allocationPolicy || 'capacity',
  experienceType: draw.experienceType || defaultExperienceForParticipation(draw.participationMode || 'open'),
  resultMode: draw.resultMode || defaultResultModeForActivity(draw.activityKind || 'lottery'),
  activityConfig: normalizeActivityConfig(draw.activityKind || 'lottery', draw.activityConfig),
  accessPassword: '',
});
const buildLotteryDrawConfirmMessage = (draw: any, labels: any) => `${labels.title}\n${labels.name}${draw.title}\n${labels.pool}${draw.entryCount || 0}\n${labels.willDraw}${Math.min(Number(draw.entryCount)||0, draw.winnerCount)}`;

/** 下载 CSV */
function downloadCsv(filename: string, rows: string[][]) {
  // 公式注入防护：Excel/Sheets 会把 = + - @ 开头的单元格当公式执行，
  // 加 ' 前缀阻止；结构上统一引号包裹 + 引号加倍。
  // 注意：后端 admin-lottery.ts 的 csvEscape 有相同逻辑（服务端导出），
  // 修改此处时必须同步修改后端版本，保持一致（跨运行环境不强行共享）。
  const escapeCell = (c: unknown): string => {
    const raw = String(c ?? '')
    const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw
    return `"${safe.replace(/"/g, '""')}"`
  }
  const csv = rows.map(r => r.map(escapeCell).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  a.click(); URL.revokeObjectURL(url);
}

const draws = ref<LotteryDraw[]>([])
const statusFilter = ref('')
/** 名称 / 奖品 / id 本地模糊搜索 */
const listQuery = ref('')
const loading = ref(false)
const loadError = ref('')
const showCreateModal = ref(false)
const showTemplateModal = ref(false)
const templates = ref<any[]>([])
const showWinnersModal = ref(false)
const showAnalyticsModal = ref(false)
const showQrModal = ref(false)
const qrImageUrl = ref('')
const showPosterModal = ref(false)
const posterGenerating = ref(false)
const posterDomRef = ref<HTMLDivElement | null>(null)
const posterDataUrl = ref('')
const posterQrImageUrl = ref('')
const posterDrawData = ref<any>(null)
const qrDrawUrl = ref('')
// ── 海报模板数据（computed 派生，供 HTML 模板渲染） ──
const posterPlatformName = '抽奖平台'
const posterKindLabel = computed(() => {
  const map: Record<string, string> = {
    lottery: '抽奖', signup_chain: '报名接龙', claim: '资料领取',
    survey: '问卷调研', vote: '投票评选', checkin: '每日签到',
    approval: '审核申请', reservation: '限量预约',
  }
  return map[posterDrawData.value?.activityKind || 'lottery'] || '活动'
})
const posterPrizeList = computed(() => {
  // 从活动配置的奖项中提取奖品名（用于海报展示，增强吸引力）
  const tiers = posterDrawData.value?.tiers
  if (Array.isArray(tiers)) {
    return tiers.map((t: any) => t.prizeName || t.tierName).filter(Boolean)
  }
  return []
})
const posterTimeText = computed(() => {
  const start = posterDrawData.value?.startTime
  const end = posterDrawData.value?.endTime
  if (start && end) return `${formatDate(start)} ~ ${formatDate(end)}`
  return ''
})
// 二维码/海报 URL 缓存：drawId -> { url, qrImageUrl }
// 为什么缓存：二维码 URL 是确定性字符串（依赖 publicSlug），列表加载时预计算，
// 打开弹窗直接复用，避免每次点开都重新拼接/请求，节省 Cloudflare Free 资源。
const qrUrlMap = new Map<string, { url: string; qrImageUrl: string }>()
// 本地生成的二维码 dataURL 缓存：url -> dataURL
// 为什么本地生成：远程 qrserver API 有第三方依赖/跨域污染/隐私风险，
// 且 html-to-image 截图远程图片若无 CORS 头会导致画布污染导出失败。
// qrcode 库在浏览器本地生成（几 ms），零 Worker 资源，符合 Cloudflare Free 约束。
const qrDataUrlCache = new Map<string, string>()

/**
 * 本地生成二维码 dataURL（惰性 + 缓存）。
 * 首次生成后缓存，同一链接再次生成直接复用，避免重复计算。
 */
async function generateQrDataUrl(url: string): Promise<string> {
  const cached = qrDataUrlCache.get(url)
  if (cached) return cached
  const dataUrl = await QRCode.toDataURL(url, {
    width: 300,
    margin: 1,
    errorCorrectionLevel: 'M',  // 中等纠错：二维码美观与容错平衡
  })
  qrDataUrlCache.set(url, dataUrl)
  return dataUrl
}
// 海报 dataURL 缓存：drawId -> dataURL
// 首次生成后缓存，同一活动再次打开直接显示，避免重复 Canvas 绘制 + 远程图片加载。
const posterCache = new Map<string, string>()
// 缓存上限：防止活动很多时内存膨胀（Worker/浏览器内存有限）
const POSTER_CACHE_LIMIT = 30
const winners = ref<LotteryWinner[]>([])
const winnersLoading = ref(false)
const analyticsLoading = ref(false)
const analyticsError = ref('')
const analyticsDraw = ref<LotteryDraw | null>(null)
const analyticsStats = ref<DrawAnalyticsStats | null>(null)
const analyticsConversions = ref<ExternalConversion[]>([])
/** 中奖弹窗对应的活动 id，便于弹窗内一键重发失败邮件 */
const winnersModalDrawId = ref('')
const creating = ref(false)
const operatingId = ref('')
// batchOperating 必须在 useTableSelection 之前声明，确保模板访问时已初始化
const batchOperating = ref(false)
const pagination = useTablePagination({ initialLimit: 50 })
let loadSequence = 0
let winnersStatusTimer: ReturnType<typeof setInterval> | null = null
let winnersStatusRefreshes = 0
let winnersStatusInFlight = false
const MAX_WINNERS_STATUS_REFRESHES = 10

const filteredDraws = computed(() => draws.value)

const hasListFilter = computed(
  () => Boolean(String(statusFilter.value || '').trim() || String(listQuery.value || '').trim()),
)

// 多选删除：复用 useTableSelection（与 AdminCardsView 一致）
const visibleItems = computed(() => filteredDraws.value)
const {
  selectedIds,
  selectedCount,
  isSelected,
  setSelected,
  toggleAllVisible,
  clearSelection,
  allVisibleSelected,
} = useTableSelection(visibleItems, (row) => row.id, {
  isSelectable: canDeleteDraw,
})

const winnersEmailFailureCount = computed(() => countLotteryEmailFailures(winners.value))
const winnersEmailPendingCount = computed(() => winners.value.filter((winner) => Number(winner.emailSent) !== 1 && !winner.emailError).length)
const analyticsFunnelCards = computed(() => {
  const stats = analyticsStats.value
  const events = stats?.events
  return [
    { key: 'page_view', label: '浏览', value: events?.pageViews ?? 0 },
    { key: 'participation_started', label: '开始参与', value: events?.totals.participation_started ?? 0 },
    { key: 'participation_completed', label: '完成参与', value: events?.participationCompleted ?? 0 },
    { key: 'cta_click', label: 'CTA 点击', value: events?.ctaClicks ?? 0 },
    { key: 'share_click', label: '分享点击', value: events?.shareClicks ?? 0 },
    { key: 'attributed_join', label: '有效邀请', value: events?.attributedJoins ?? 0 },
    { key: 'external_conversion_reported', label: '外部回传', value: events?.externalConversionsReported ?? 0 },
  ]
})
const conversionTypeRows = computed(() => {
  const totals = analyticsStats.value?.externalConversions?.totals || {}
  return Object.entries(totals)
    .map(([type, row]) => ({ type, count: Number(row.count || 0), amountCents: Number(row.amountCents || 0) }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
})
const completionRate = computed(() => percent(
  analyticsStats.value?.events.participationCompleted || 0,
  analyticsStats.value?.events.pageViews || 0,
))
const ctaRate = computed(() => percent(
  analyticsStats.value?.events.ctaClicks || 0,
  analyticsStats.value?.events.participationCompleted || 0,
))
const externalConversionRate = computed(() => percent(
  analyticsStats.value?.externalConversions.totalCount || 0,
  analyticsStats.value?.events.ctaClicks || 0,
))

function makeStableId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`
}

function defaultActivityConfigForKind(kind: string): ActivityConfigForm {
  if (kind === 'survey') {
    return {
      version: 1,
      kind: 'survey',
      fields: [
        { id: 'contact_email', label: '联系邮箱', type: 'email', required: true, maxLength: 120, options: [] },
        { id: 'feedback', label: '反馈内容', type: 'textarea', required: true, maxLength: 1000, options: [] },
      ],
    }
  }
  if (kind === 'vote') {
    return {
      version: 1,
      kind: 'vote',
      selection: 'single',
      options: [
        { id: 'option_a', label: '选项 A', description: '', imageUrl: '' },
        { id: 'option_b', label: '选项 B', description: '', imageUrl: '' },
      ],
    }
  }
  // lottery 默认配置：未中奖自动发券默认关闭，需运营者显式启用
  return { version: 1, kind, loserReward: { enabled: false, couponLabel: '' } }
}

function normalizeActivityConfig(kind: string, config: any): ActivityConfigForm {
  if (!config || typeof config !== 'object' || config.kind !== kind) return defaultActivityConfigForKind(kind)
  if (kind === 'survey') {
    const fields = Array.isArray(config.fields) && config.fields.length > 0
      ? config.fields.map((field: any) => ({
          id: String(field.id || makeStableId('field')),
          label: String(field.label || '未命名字段'),
          type: (['text', 'email', 'phone', 'textarea', 'select', 'radio', 'checkbox'].includes(field.type) ? field.type : 'text') as SurveyFieldType,
          required: Boolean(field.required),
          maxLength: Number(field.maxLength || 120),
          options: Array.isArray(field.options)
            ? field.options.map((option: any) => ({ id: String(option.id || makeStableId('opt')), label: String(option.label || '选项') }))
            : [],
        }))
      : (defaultActivityConfigForKind('survey') as any).fields
    return { version: 1, kind: 'survey', fields }
  }
  if (kind === 'vote') {
    const options = Array.isArray(config.options) && config.options.length >= 2
      ? config.options.map((option: any) => ({
          id: String(option.id || makeStableId('opt')),
          label: String(option.label || '选项'),
          description: String(option.description || ''),
          imageUrl: String(option.imageUrl || ''),
        }))
      : (defaultActivityConfigForKind('vote') as any).options
    return { version: 1, kind: 'vote', selection: 'single', options }
  }
  return defaultActivityConfigForKind(kind)
}

const emptyForm = () => ({
  id: '',
  name: '',
  description: '',
  prizeName: '',
  productName: '',
  startTime: '',
  endTime: '',
  drawTime: '',
  winnerCount: 1,
  maxWinners: 1,
  maxParticipants: null as number | null,
  expectedParticipants: 0,
  activityKind: 'lottery',
  participationMode: 'open',
  experienceType: 'wheel',
  resultMode: 'manual',
  allocationPolicy: 'capacity',
  accessPassword: '',
  showWinners: false,
  // 奖项配置（抽奖活动专用）：选择奖品库中的奖品，设置中奖名额
  tiers: [] as Array<{ prizeId: string; tierName: string; winnerCount: number }>,
  // 导流配置
  enableProductLink: false,
  productLink: { url: '', title: '', imageUrl: '', price: '' },
  // 裂变配置
  enableViral: false,
  viralExtraEntriesPerInvite: 1,
  viralMaxExtraEntries: 10,
  viralLeaderboardEnabled: true,
  // 多状态 CTA
  enableAfterWinCta: false,
  afterWinCtaUrl: '',
  afterWinCtaTitle: '',
  enableAfterLossCta: false,
  afterLossCtaUrl: '',
  afterLossCtaTitle: '',
  // 玩法配置：问卷/投票共用 activity_config，避免再拆 forms/votes 重表。
  activityConfig: defaultActivityConfigForKind('lottery') as any,
})

const form = ref(emptyForm())
const isEditing = ref(false)
const rosterInput = ref('')
const inviteCodeCount = ref(10)
/** 奖品库（用于奖项配置下拉选择） */
const prizeOptions = ref<any[]>([])

// ── 活动后承接：未中奖自动发券开关（表单编辑用，保存时同步进 activityConfig.loserReward） ──
const loserRewardEnabled = ref(false)
const loserRewardCouponLabel = ref('')

/** 把开关状态同步进 form.activityConfig.loserReward */
function syncLoserReward() {
  const config = form.value.activityConfig as any
  config.loserReward = { enabled: loserRewardEnabled.value, couponLabel: loserRewardCouponLabel.value }
}

/** 从 form.activityConfig.loserReward 回填开关状态（编辑活动时调用） */
function initLoserRewardFromConfig() {
  const config = form.value.activityConfig as any
  const lr = config?.loserReward
  loserRewardEnabled.value = Boolean(lr?.enabled)
  loserRewardCouponLabel.value = lr?.couponLabel || ''
}

/** 加载奖品库 */
async function loadPrizeOptions() {
  try {
    const data = await adminRequest<{ prizes: any[] }>('/api/admin/prizes')
    prizeOptions.value = data.prizes || []
  } catch { prizeOptions.value = [] }
}

/** 添加一个奖项（最多 10 个） */
function addTier() {
  if (form.value.tiers.length >= 10) return
  form.value.tiers.push({ prizeId: '', tierName: `奖项 ${form.value.tiers.length + 1}`, winnerCount: 1 })
}

/** 移除一个奖项 */
function removeTier(idx: number) {
  form.value.tiers.splice(idx, 1)
}

function goToPrizes() {
  void router.push('/admin/prizes')
}

/** 后端约束：drawTime > endTime > startTime */
const timeOrderError = computed(() => {
  const start = form.value.startTime
  const end = form.value.endTime
  const draw = form.value.drawTime
  if (!start || !end || !draw) return ''
  const s = new Date(start).getTime()
  const e = new Date(end).getTime()
  const d = new Date(draw).getTime()
  if (Number.isNaN(s) || Number.isNaN(e) || Number.isNaN(d)) {
    return t('lottery.adminTimeInvalid')
  }
  if (!(s < e && e < d)) {
    return t('lottery.adminTimeOrderError')
  }
  return ''
})

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    draft: 'lottery.adminDrawDraft',
    open: 'lottery.statusOpen',
    paused: 'lottery.statusPaused',
    drawing: 'lottery.statusDrawing',
    drawn: 'lottery.statusDrawn',
    cancelled: 'lottery.adminDrawCancelled',
  }
  return t(map[status] || 'lottery.adminUnknown')
}

/** 与卡密/优惠券一致：共享 .tag*，禁止自造状态 chip */
function statusClass(status: string): string {
  if (status === 'open') return 'tag-success'
  if (status === 'paused') return 'tag-muted'
  if (status === 'drawing') return 'tag-warning'
  if (status === 'drawn') return 'tag-info'
  if (status === 'cancelled') return 'tag-danger'
  return 'tag-muted'
}

function defaultExperienceForParticipation(participationMode: string): string {
  if (participationMode === 'invite_code') return 'slot'
  if (participationMode === 'password') return 'scratch'
  if (participationMode === 'roster') return 'card'
  return 'wheel'
}

function defaultExperienceForActivity(activityKind: string, participationMode: string): string {
  if (activityKind === 'signup_chain') return 'list'
  if (activityKind === 'reservation') return 'calendar'
  if (activityKind === 'vote') return 'ballot'
  if (activityKind === 'survey') return 'form'
  if (activityKind === 'checkin') return 'checkin'
  if (activityKind === 'waitlist') return 'queue'
  if (activityKind === 'approval') return 'form'
  if (activityKind === 'claim') return 'reveal'
  return defaultExperienceForParticipation(participationMode)
}

function defaultResultModeForActivity(activityKind: string): string {
  if (activityKind === 'signup_chain') return 'ordered_assignment'
  if (activityKind === 'reservation') return 'capacity_assignment'
  if (activityKind === 'vote') return 'vote_tally'
  if (activityKind === 'survey') return 'no_result'
  if (activityKind === 'checkin') return 'no_result'
  if (activityKind === 'waitlist') return 'ordered_assignment'
  if (activityKind === 'approval') return 'review_decision'
  if (activityKind === 'claim') return 'instant'
  return 'manual'
}

function handleActivityKindChange() {
  const kind = form.value.activityKind || 'lottery'
  form.value.experienceType = defaultExperienceForActivity(kind, form.value.participationMode || 'open')
  form.value.resultMode = defaultResultModeForActivity(kind)
  form.value.allocationPolicy = kind === 'signup_chain' ? 'waitlist' : kind === 'approval' ? 'approval' : 'capacity'
  form.value.winnerCount = kind === 'lottery' ? Math.max(1, Number(form.value.winnerCount) || 1) : 0
  form.value.activityConfig = normalizeActivityConfig(kind, form.value.activityConfig) as any
}

function handleParticipationModeChange() {
  form.value.experienceType = defaultExperienceForActivity(form.value.activityKind || 'lottery', form.value.participationMode || 'open')
}

function isChoiceSurveyField(field: SurveyFieldForm) {
  return ['select', 'radio', 'checkbox'].includes(field.type)
}

function normalizeSurveyFieldOptions(field: SurveyFieldForm) {
  if (isChoiceSurveyField(field) && field.options.length === 0) {
    field.options = [
      { id: makeStableId('opt'), label: '选项 1' },
      { id: makeStableId('opt'), label: '选项 2' },
    ]
  }
  if (!isChoiceSurveyField(field)) field.options = []
  field.maxLength = field.type === 'textarea' ? Math.max(Number(field.maxLength) || 1000, 200) : Math.min(Number(field.maxLength) || 120, 500)
}

function addSurveyField() {
  const config = normalizeActivityConfig('survey', form.value.activityConfig) as Extract<ActivityConfigForm, { kind: 'survey' }>
  config.fields.push({
    id: makeStableId('field'),
    label: '新字段',
    type: 'text',
    required: false,
    maxLength: 120,
    options: [],
  })
  form.value.activityConfig = config as any
}

function removeSurveyField(index: number) {
  const config = normalizeActivityConfig('survey', form.value.activityConfig) as Extract<ActivityConfigForm, { kind: 'survey' }>
  if (config.fields.length <= 1) return
  config.fields.splice(index, 1)
  form.value.activityConfig = config as any
}

function addSurveyOption(field: SurveyFieldForm) {
  if (!isChoiceSurveyField(field) || field.options.length >= 20) return
  field.options.push({ id: makeStableId('opt'), label: `选项 ${field.options.length + 1}` })
}

function removeSurveyOption(field: SurveyFieldForm, optionId: string) {
  if (field.options.length <= 1) return
  field.options = field.options.filter((option) => option.id !== optionId)
}

function addVoteOption() {
  const config = normalizeActivityConfig('vote', form.value.activityConfig) as Extract<ActivityConfigForm, { kind: 'vote' }>
  if (config.options.length >= 50) return
  config.options.push({ id: makeStableId('option'), label: `选项 ${config.options.length + 1}`, description: '', imageUrl: '' })
  form.value.activityConfig = config as any
}

function removeVoteOption(index: number) {
  const config = normalizeActivityConfig('vote', form.value.activityConfig) as Extract<ActivityConfigForm, { kind: 'vote' }>
  if (config.options.length <= 2) return
  config.options.splice(index, 1)
  form.value.activityConfig = config as any
}

function activityKindLabel(kind: string): string {
  const map: Record<string, string> = {
    lottery: '抽奖',
    signup_chain: '接龙 / 报名',
    claim: '资料领取 / 领券',
    survey: '问卷调研',
    vote: '投票评选',
    checkin: '签到 / 打卡',
    reservation: '预约确认',
    approval: '审核申请',
    waitlist: '候补名单',
  }
  return map[kind] || kind || '-'
}

function experienceTypeLabel(type: string): string {
  const map: Record<string, string> = {
    submit: '普通提交',
    wheel: '大转盘',
    slot: '老虎机',
    scratch: '刮刮卡',
    card: '卡片翻转',
    list: '接龙列表',
    calendar: '预约日历',
    form: '表单提交',
    ballot: '投票选项',
    checkin: '签到按钮',
    queue: '排队队列',
    reveal: '领取揭晓',
    grid: '九宫格',
  }
  return map[type] || type || '-'
}

function resultModeLabel(mode: string): string {
  const map: Record<string, string> = {
    manual: '手动开奖',
    scheduled: '定时开奖',
    instant: '即时结果',
    ordered_assignment: '按顺序分配',
    capacity_assignment: '按容量确认',
    vote_tally: '投票统计',
    review_decision: '人工审核',
    no_result: '只记录提交',
  }
  return map[mode] || mode || '-'
}

function canDeleteDraw(draw: LotteryDraw): boolean {
  return draw.status === 'draft' || draw.status === 'paused' || draw.status === 'drawn' || draw.status === 'cancelled'
}

function emailStatusLabel(w: LotteryWinner): string {
  if (Number(w.emailSent) === 1) return t('lottery.adminEmailSent')
  if (w.emailError) return t('lottery.adminEmailFailed')
  return t('lottery.adminEmailPending')
}

function emailStatusClass(w: LotteryWinner): string {
  if (Number(w.emailSent) === 1) return 'tag-success'
  if (w.emailError) return 'tag-danger'
  return 'tag-warning'
}

function percent(numerator: number, denominator: number): string {
  if (!denominator || denominator <= 0) return '-'
  return `${((numerator / denominator) * 100).toFixed(1)}%`
}

function conversionTypeLabel(type: string): string {
  const map: Record<string, string> = {
    registration: '注册',
    purchase: '购买',
    coupon_redeemed: '券码核销',
    lead_qualified: '线索合格',
    offline_redeemed: '线下核销',
    custom: '自定义',
  }
  return map[type] || type || '-'
}

function conversionIdentity(item: ExternalConversion): string {
  if (!item.identityValue) return '-'
  return item.identityType ? `${item.identityType}:${item.identityValue}` : item.identityValue
}

function conversionAmount(item: ExternalConversion): string {
  if (item.amountCents === null || item.amountCents === undefined) return '-'
  const currency = item.currency ? `${item.currency} ` : ''
  return `${currency}${item.amountCents} 分`
}

function formatPublishCheckItems(items: PublishCheckItem[], prefix: string): string {
  const topItems = items.slice(0, 3).map((item) => item.message).join('\n')
  const rest = items.length > 3 ? `\n还有 ${items.length - 3} 项，请查看发布前预检` : ''
  return `${prefix}\n${topItems}${rest}`
}

async function handleViewAnalytics(draw: LotteryDraw) {
  analyticsDraw.value = draw
  showAnalyticsModal.value = true
  analyticsLoading.value = true
  analyticsError.value = ''
  analyticsStats.value = null
  analyticsConversions.value = []
  operatingId.value = draw.id
  try {
    const [stats, conversionData] = await Promise.all([
      fetchDrawAnalyticsStats(draw.id),
      fetchDrawConversions(draw.id),
    ])
    analyticsStats.value = {
      ...stats,
      externalConversions: conversionData.summary || stats.externalConversions,
    }
    analyticsConversions.value = conversionData.conversions || []
  } catch (e: any) {
    analyticsError.value = e?.message || '活动数据加载失败'
    showToast(analyticsError.value, 'error')
  } finally {
    analyticsLoading.value = false
    operatingId.value = ''
  }
}

function handleExportConversions() {
  if (analyticsConversions.value.length === 0) return
  const rows = [
    ['类型', '来源', '外部事件', '身份类型', '身份值', 'ref', '金额分', '币种', '发生时间', '回传时间'],
    ...analyticsConversions.value.map((item) => [
      conversionTypeLabel(item.conversionType),
      item.source || '',
      item.externalEventId,
      item.identityType || '',
      item.identityValue || '',
      item.refCode || '',
      item.amountCents === null || item.amountCents === undefined ? '' : String(item.amountCents),
      item.currency || '',
      item.occurredAt || '',
      item.createdAt || '',
    ]),
  ]
  const idPart = (analyticsDraw.value?.id || 'conversions').slice(0, 40)
  downloadCsv(`activity-conversions-${idPart}-${new Date().toISOString().slice(0, 10)}.csv`, rows)
  showToast('外部回传已导出', 'success')
}

function stopWinnersStatusPolling() {
  if (winnersStatusTimer) {
    clearInterval(winnersStatusTimer)
    winnersStatusTimer = null
  }
  winnersStatusRefreshes = 0
  winnersStatusInFlight = false
}

async function refreshWinnersStatus(id: string) {
  if (winnersStatusInFlight || !showWinnersModal.value || winnersModalDrawId.value !== id) return
  winnersStatusInFlight = true
  try {
    const data = await fetchLotteryWinners(id)
    winners.value = data.winners || []
    winnersStatusRefreshes += 1
    if (winnersEmailPendingCount.value === 0 || winnersStatusRefreshes >= MAX_WINNERS_STATUS_REFRESHES) {
      stopWinnersStatusPolling()
    }
  } catch {
    winnersStatusRefreshes += 1
    if (winnersStatusRefreshes >= MAX_WINNERS_STATUS_REFRESHES) {
      stopWinnersStatusPolling()
    }
  } finally {
    winnersStatusInFlight = false
  }
}

function startWinnersStatusPolling(id: string) {
  stopWinnersStatusPolling()
  if (winnersEmailPendingCount.value === 0) return
  // 手动开奖已等待邮件状态写库；这里是 UI 兜底，处理系统开奖或网络延迟后的短暂 pending。
  // 必须有 MAX_WINNERS_STATUS_REFRESHES 上限，避免管理员长开弹窗造成无界轮询。
  winnersStatusTimer = setInterval(() => {
    void refreshWinnersStatus(id)
  }, 2000)
}

function participantsMeta(draw: LotteryDraw): string {
  const parts: string[] = []
  if (draw.expectedParticipants !== undefined && draw.expectedParticipants !== null) {
    parts.push(`${t('lottery.expectedCount')} ${draw.expectedParticipants}`)
  }
  if (draw.maxParticipants) {
    parts.push(`${t('lottery.maxParticipants')} ${draw.maxParticipants}`)
  }
  return parts.join(' · ')
}

function entryProgress(draw: LotteryDraw): string {
  return formatLotteryEntryProgress(draw.entryCount, draw.maxParticipants)
}

function visibilityLabel(draw: LotteryDraw): string {
  return formatLotteryVisibilityLabel(draw.visible, {
    public: t('lottery.adminVisibilityPublic'),
    hidden: t('lottery.adminVisibilityHidden'),
  })
}

function publicShareUrl(drawId: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '/lottery/'
  return `${origin.replace(/\/+$/, '')}/lottery/${drawId}`
}

async function handleCopyShareLink(draw: LotteryDraw) {
  try {
    await writeClipboardText(publicShareUrl(draw.publicSlug))
    showToast(t('lottery.adminLinkCopied'), 'success')
  } catch {
    showToast(t('lottery.adminLinkCopyFailed'), 'error')
  }
}

/** 新标签打开用户端活动页，便于运营自检 */
function handleOpenPublic(draw: LotteryDraw) {
  const path = `/lottery/${draw.publicSlug}`
  if (typeof window !== 'undefined') {
    window.open(path, '_blank', 'noopener,noreferrer')
  }
}

/** 生成二维码 */
async function handleShowQrCode(draw: LotteryDraw) {
  // 复用预计算缓存（loadData 时生成链接），二维码图本地生成（零第三方依赖）
  const cached = qrUrlMap.get(draw.id) || {
    url: `${window.location.origin}/lottery/${draw.publicSlug}`,
    qrImageUrl: '',
  }
  if (!cached.url) {
    cached.url = `${window.location.origin}/lottery/${draw.publicSlug}`
    qrUrlMap.set(draw.id, cached)
  }
  qrDrawUrl.value = cached.url
  // 本地生成二维码 dataURL（带缓存），避免远程 API 依赖/跨域污染/隐私问题
  qrImageUrl.value = await generateQrDataUrl(cached.url)
  showQrModal.value = true
}

function handleDownloadQr() {
  const a = document.createElement('a')
  a.href = qrImageUrl.value
  a.download = 'qrcode.png'
  a.click()
}

function handleCopyQrLink() {
  writeClipboardText(qrDrawUrl.value)
  showToast('链接已复制', 'success')
}

/* ── 海报生成 ──────────────────────────────────────────── */

/** 生成活动海报
 *
 * 性能优化：海报 dataURL 缓存在内存 Map 中（posterCache），
 * 同一活动再次打开直接显示缓存，避免重复 Canvas 绘制 + 远程二维码图片加载，
 * 节省 Cloudflare Free 资源（CPU/请求）。
 * 缓存超过 POSTER_CACHE_LIMIT 时清空最旧的，防止内存膨胀。
 */
async function handleShowPoster(draw: LotteryDraw) {
  posterDrawData.value = draw
  // 复用预计算二维码链接（loadData 时生成），二维码图本地生成
  const cachedQr = qrUrlMap.get(draw.id) || {
    url: `${window.location.origin}/lottery/${draw.publicSlug}`,
    qrImageUrl: '',
  }
  if (!cachedQr.url) {
    cachedQr.url = `${window.location.origin}/lottery/${draw.publicSlug}`
    qrUrlMap.set(draw.id, cachedQr)
  }
  qrDrawUrl.value = cachedQr.url
  // 本地生成二维码（dataURL 带缓存），海报模板 <img> 直接引用，html-to-image 可截图
  posterQrImageUrl.value = await generateQrDataUrl(cachedQr.url)

  showPosterModal.value = true
  // 命中缓存：直接显示，无需重新生成
  const cached = posterCache.get(draw.id)
  if (cached) {
    posterDataUrl.value = cached
    return
  }
  posterGenerating.value = true
  // 等待 DOM 渲染后截图海报
  await nextTick()
  await generatePosterFromDom()
  // 生成成功则缓存（防止内存膨胀，超出上限清最旧）
  if (posterDataUrl.value) {
    if (posterCache.size >= POSTER_CACHE_LIMIT) {
      const oldestKey = posterCache.keys().next().value
      if (oldestKey !== undefined) posterCache.delete(oldestKey)
    }
    posterCache.set(draw.id, posterDataUrl.value)
  }
  posterGenerating.value = false
}

/**
 * 从海报模板 DOM 生成 PNG 海报（替代 Canvas 绘制）。
 *
 * 为什么改用 HTML 模板：Canvas 绘制排版能力有限（简单文字堆叠），
 * 且无法直接嵌入远程二维码图片（跨域污染画布导致无法导出）。
 * HTML/CSS 模板可做出精美排版（渐变/圆角/卡片/奖品展示），
 * 二维码用 <img> 标签直接显示，html-to-image 截图时保留。
 */
async function generatePosterFromDom() {
  const node = posterDomRef.value
  if (!node) return
  try {
    posterDataUrl.value = await toPng(node, {
      pixelRatio: 2,  // 2x 输出保证清晰度（手机屏幕/印刷可用）
      cacheBust: true,
    })
  } catch (err) {
    console.warn('[poster] html-to-image failed:', err)
    posterDataUrl.value = ''
  }
}

async function handleDownloadPoster() {
  if (!posterDataUrl.value) {
    showToast('海报未生成，请稍候', 'error')
    return
  }
  const a = document.createElement('a')
  a.href = posterDataUrl.value
  a.download = 'poster.png'
  a.click()
  showToast('海报已下载', 'success')
}

function handleExportWinners() {
  if (winners.value.length === 0) {
    showToast(t('lottery.adminExportWinnersEmpty'), 'error')
    return
  }
  const rows = buildLotteryWinnersCsvRows(winners.value, {
    email: t('lottery.adminEmail'),
    orderNo: t('lottery.adminOrderNo'),
    card: t('lottery.adminCards'),
    emailStatus: t('lottery.adminEmailStatus'),
    sent: t('lottery.adminEmailSent'),
    pending: t('lottery.adminEmailPending'),
    failed: t('lottery.adminEmailFailed'),
  })
  const idPart = (winnersModalDrawId.value || 'winners').slice(0, 40)
  downloadCsv(`lottery-winners-${idPart}-${new Date().toISOString().slice(0, 10)}.csv`, rows)
  showToast(t('lottery.adminExportWinnersDone'), 'success')
}

function handleDuplicate(draw: LotteryDraw) {
  const draft = buildLotteryDuplicateDraft(draw, { nameSuffix: '(副本)', defaultName: '新活动' })
  form.value = {
    ...emptyForm(),
    id: '',
    name: draft.name,
    description: draft.description,
    prizeName: draft.prizeName,
    startTime: draft.startTime,
    endTime: draft.endTime,
    drawTime: draft.drawTime,
    winnerCount: draft.winnerCount,
    maxParticipants: draft.maxParticipants,
    participationMode: draft.participationMode,
    activityKind: draft.activityKind || 'lottery',
    allocationPolicy: draft.allocationPolicy || 'capacity',
    experienceType: draft.experienceType,
    resultMode: draft.resultMode,
    activityConfig: normalizeActivityConfig(draft.activityKind || 'lottery', draft.activityConfig),
    accessPassword: draft.accessPassword,
    enableProductLink: false,
    productLink: { url: '', title: '', imageUrl: '', price: '' },
    enableViral: false,
    viralExtraEntriesPerInvite: 1,
    viralMaxExtraEntries: 10,
    viralLeaderboardEnabled: true,
  }
  isEditing.value = false
  showCreateModal.value = true
  showToast('已复制活动，请确认后创建', 'success')
}

/** 列表内失败原因截断，完整内容放 title；避免 SQL 整段撑爆表格 */
function shortFailure(reason?: string | null): string {
  const text = (reason || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (text.length <= 96) return text
  return `${text.slice(0, 96)}…`
}

function formatLocalInput(value: string): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function roundToMinute(date: Date): Date {
  const next = new Date(date)
  next.setSeconds(0, 0)
  return next
}

function toLocalInput(date: Date): string {
  return toDateTimeLocalValue(date.toISOString())
}

/** 快捷时间：开始=现在，结束=开始+时长，开奖=结束+3 分钟（满足 draw > end > start） */
function applyTimePreset(kind: '5m' | '10m' | '20m' | '30m' | '1h' | '1d' | '3d' | '7d') {
  const start = roundToMinute(new Date())
  const end = new Date(start)
  if (kind === '5m') end.setMinutes(end.getMinutes() + 5)
  else if (kind === '10m') end.setMinutes(end.getMinutes() + 10)
  else if (kind === '20m') end.setMinutes(end.getMinutes() + 20)
  else if (kind === '30m') end.setMinutes(end.getMinutes() + 30)
  else if (kind === '1h') end.setHours(end.getHours() + 1)
  else if (kind === '1d') end.setDate(end.getDate() + 1)
  else if (kind === '3d') end.setDate(end.getDate() + 3)
  else end.setDate(end.getDate() + 7)
  const draw = new Date(end)
  draw.setMinutes(draw.getMinutes() + 3)
  form.value = {
    ...form.value,
    startTime: toLocalInput(start),
    endTime: toLocalInput(end),
    drawTime: toLocalInput(draw),
  }
}

function closeEditor() {
  showCreateModal.value = false
  isEditing.value = false
  rosterInput.value = ''
  inviteCodeCount.value = 10
}

function openTemplatePicker() {
  // 加载模板列表（首次打开时）
  if (templates.value.length === 0) {
    fetchTemplates()
  }
  showTemplateModal.value = true
}

async function fetchTemplates() {
  try {
    const data = await adminRequest<any>('/api/admin/templates')
    templates.value = data.templates || []
  } catch {
    // 加载失败时允许用户直接创建空白活动
    templates.value = []
  }
}

function categoryLabel(cat: string): string {
  const map: Record<string,string> = { marketing:'营销获客', engagement:'互动传播', conversion:'转化留资', research:'调研分析' }
  return map[cat] || cat
}

function applyTemplate(tpl: any) {
  showTemplateModal.value = false
  const base = emptyForm()
  // 应用模板默认值
  form.value = {
    ...base,
    id: '',
    name: '',
    description: '',
    activityKind: tpl.defaults.activityKind,
    experienceType: tpl.defaults.experienceType,
    resultMode: tpl.defaults.resultMode || defaultResultModeForActivity(tpl.defaults.activityKind),
    participationMode: tpl.defaults.participationMode,
    allocationPolicy: tpl.defaults.allocationPolicy,
    winnerCount: tpl.defaults.winnerCount,
    maxParticipants: null,
    expectedParticipants: 0,
    activityConfig: defaultActivityConfigForKind(tpl.defaults.activityKind) as any,
  }
  isEditing.value = false
  applyTimePreset('1d')
  showCreateModal.value = true
}

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const data = await fetchLotteryDraws({
      limit: pagination.limit.value,
      offset: (pagination.page.value - 1) * pagination.limit.value,
      status: statusFilter.value || undefined,
      query: listQuery.value || undefined,
    })
    if (sequence !== loadSequence) return
    draws.value = data.draws || []
    // 预计算每个活动的二维码链接（纯字符串拼接，零成本），打开弹窗再本地生成二维码图
    const origin = window.location.origin
    for (const d of draws.value) {
      if (!qrUrlMap.has(d.id)) {
        qrUrlMap.set(d.id, {
          url: `${origin}/lottery/${d.publicSlug}`,
          qrImageUrl: '',  // 二维码图本地生成（异步），打开时惰性生成
        })
      }
    }
    pagination.setTotal(data.total || 0)
  } catch (e: any) {
    if (sequence !== loadSequence) return
    draws.value = []
    loadError.value = e?.message || t('lottery.adminLoadFailed')
    showToast(loadError.value, 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function handleOpen(draw: LotteryDraw) {
  operatingId.value = draw.id
  try {
    // 发布前先展示同一套服务端门禁结果：运营者需要知道缺奖项、码池、CTA、Webhook 等具体阻断点。
    const check = await fetchPublishCheck(draw.id)
    if (!check.canPublish) {
      showToast(formatPublishCheckItems(check.errors, '发布前需要先处理：'), 'error')
      return
    }
    if (check.warnings.length > 0) {
      const confirmed = await askConfirm(formatPublishCheckItems(check.warnings, '发布前仍有风险：') + '\n仍然发布吗？')
      if (!confirmed) return
    }
    await openLotteryDraw(draw.id)
    // 发布后复制公开 slug 链接，避免把内部活动 id 发给参与者导致公开页 404。
    try {
      await writeClipboardText(publicShareUrl(draw.publicSlug))
      showToast(t('lottery.adminOpenedWithLink'), 'success')
    } catch {
      showToast(t('lottery.adminDrawOpened'), 'success')
    }
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
}

async function handleDraw(draw: LotteryDraw) {
  // 开奖前展示池子/名额/将抽出人数，降低误操作；不改服务端开奖语义
  const summary = buildLotteryDrawConfirmMessage(draw, {
    title: t('lottery.adminConfirmDrawTitle'),
    name: t('lottery.adminConfirmDrawName'),
    pool: t('lottery.adminConfirmDrawPool'),
    quota: t('lottery.adminConfirmDrawQuota'),
    willDraw: t('lottery.adminConfirmDrawWill'),
    product: t('lottery.adminConfirmDrawProduct'),
    emptyPoolWarn: t('lottery.adminConfirmDrawEmptyPool'),
    confirm: t('lottery.adminConfirmDraw'),
  })
  if (!(await askConfirm(summary))) return
  operatingId.value = draw.id
  let drawOk = false
  try {
    await performLotteryDraw(draw.id)
    drawOk = true
    showToast(t('lottery.adminDrawDone'), 'success')
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
  // 与 viewWinners 各自管理 operatingId，避免 finally 互相覆盖导致按钮卡死
  if (drawOk) {
    await viewWinners(draw.id)
  }
}

async function viewWinners(id: string) {
  stopWinnersStatusPolling()
  winnersLoading.value = true
  winners.value = []
  winnersModalDrawId.value = id
  showWinnersModal.value = true
  operatingId.value = id
  try {
    const data = await fetchLotteryWinners(id)
    winners.value = data.winners || []
    startWinnersStatusPolling(id)
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
    showWinnersModal.value = false
    winnersModalDrawId.value = ''
  } finally {
    winnersLoading.value = false
    operatingId.value = ''
  }
}

watch(showWinnersModal, (visible) => {
  if (!visible) stopWinnersStatusPolling()
})

onBeforeUnmount(() => {
  stopWinnersStatusPolling()
})

async function handleCancel(id: string) {
  if (!(await askConfirm(t('lottery.adminConfirmCancel')))) return
  operatingId.value = id
  try {
    await cancelLotteryDraw(id)
    showToast(t('lottery.adminDrawCancelled'), 'success')
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
    await loadData()
  } finally {
    operatingId.value = ''
  }
}

async function handleDelete(id: string) {
  const draw = draws.value.find((item) => item.id === id)
  if (!draw || !canDeleteDraw(draw)) return
  if (!(await askConfirm(t('lottery.adminConfirmDelete', { name: draw.name, status: statusLabel(draw.status) })))) return
  operatingId.value = id
  try {
    await deleteLotteryDraw(id)
    showToast(t('lottery.adminDrawDeleted'), 'success')
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
}

async function batchDeleteDraws() {
  const ids = selectedIds.value
  if (ids.length === 0 || loading.value || batchOperating.value) return
  const selectedDraws = draws.value.filter((draw) => ids.includes(draw.id) && canDeleteDraw(draw))
  if (selectedDraws.length === 0) return
  const drawnCount = selectedDraws.filter((draw) => draw.status === 'drawn').length
  if (!(await askConfirm(t('lottery.adminConfirmBatchDelete', { count: selectedDraws.length, drawnCount })))) return
  batchOperating.value = true
  try {
    let success = 0
    let failed = 0
    for (const id of selectedDraws.map((draw) => draw.id)) {
      try {
        await deleteLotteryDraw(id)
        success++
      } catch {
        failed++
      }
    }
    if (failed > 0) {
      showToast(t('lottery.adminBatchDeleteResult', { success, failed }), 'error')
    } else {
      showToast(t('lottery.adminBatchDeleteSuccess', { count: success }), 'success')
    }
    clearSelection()
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
  } finally {
    batchOperating.value = false
  }
}

async function handlePause(id: string) {
  if (!(await askConfirm(t('lottery.adminConfirmPause')))) return
  operatingId.value = id
  try {
    await fetchAdminLottery(`/api/admin/draws/${id}/pause`, 'POST')
    showToast(t('lottery.adminPaused'), 'success')
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
    await loadData()
  } finally {
    operatingId.value = ''
  }
}

async function handleResume(id: string) {
  operatingId.value = id
  try {
    await fetchAdminLottery(`/api/admin/draws/${id}/resume`, 'POST')
    showToast(t('lottery.adminResumed'), 'success')
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
    await loadData()
  } finally {
    operatingId.value = ''
  }
}

async function handleEdit(draw: LotteryDraw) {
  // 与后端 PATCH 一致：仅 draft 可改配置；paused 需先恢复或复制活动
  if (draw.status !== 'draft') {
    showToast(t('lottery.adminEditNonDraft'), 'error')
    return
  }
  form.value = {
    ...emptyForm(),
    id: draw.id,
    name: draw.title,
    description: draw.description || '',
    startTime: toDateTimeLocalValue(draw.startAt),
    endTime: toDateTimeLocalValue(draw.endAt),
    drawTime: toDateTimeLocalValue(draw.drawAt || ''),
    winnerCount: draw.winnerCount,
    maxParticipants: draw.maxParticipants ?? null,
    participationMode: draw.participationMode || 'open',
    activityKind: draw.activityKind || 'lottery',
    allocationPolicy: draw.allocationPolicy || 'capacity',
    experienceType: draw.experienceType || defaultExperienceForActivity(draw.activityKind || 'lottery', draw.participationMode || 'open'),
    resultMode: draw.resultMode || defaultResultModeForActivity(draw.activityKind || 'lottery'),
    activityConfig: normalizeActivityConfig(draw.activityKind || 'lottery', draw.activityConfig) as any,
  }
  isEditing.value = true
  // 回填未中奖自动发券开关状态
  initLoserRewardFromConfig()
  showCreateModal.value = true
}

async function handleToggleVisibility(id: string, visible: number | undefined) {
  if (!(await askConfirm(t('lottery.adminConfirmToggleVisibility')))) return
  operatingId.value = id
  try {
    await updateLotteryDraw(id, { visible: visible ? 0 : 1 })
    showToast(visible ? t('lottery.adminHidden') : t('lottery.adminShown'), 'success')
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
}

async function handleRetryEmail(id: string) {
  operatingId.value = id
  try {
    const result = await retryAdminLotteryEmail(id)
    if (result.sent > 0 || result.failed === 0) {
      showToast(t('lottery.adminRetrySuccess', { sent: result.sent }), 'success')
    } else {
      showToast(t('lottery.adminRetryFailed', { failed: result.failed }), 'error')
    }
    // 若中奖弹窗正打开同一活动，刷新名单上的发送态
    if (showWinnersModal.value && winnersModalDrawId.value === id) {
      try {
        const data = await fetchLotteryWinners(id)
        winners.value = data.winners || []
      } catch {
        /* 列表刷新失败不阻断主提示 */
      }
    }
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
}

/**
 * drawing 卡死恢复：走服务端 force heal。
 * 有中奖 → drawn（不二次发卡）；无中奖 → open。
 */
async function handleRecover(id: string) {
  if (!(await askConfirm(t('lottery.adminConfirmRecover')))) return
  operatingId.value = id
  try {
    const result = await recoverLotteryDraw(id)
    if (result.healed === 'drawn') {
      showToast(t('lottery.adminRecoverDoneDrawn'), 'success')
    } else {
      showToast(t('lottery.adminRecoverDoneOpen'), 'success')
    }
    await loadData()
  } catch (e: any) {
    showToast(e?.message || t('lottery.adminFailed'), 'error')
  } finally {
    operatingId.value = ''
  }
}

async function handleCreate() {
  if (!form.value.name || !form.value.startTime || !form.value.endTime) {
    showToast('请填写活动名称和参与时间', 'error')
    return
  }
  if (timeOrderError.value) {
    showToast(timeOrderError.value, 'error')
    return
  }
  creating.value = true
  try {
    // 注意：后端 API 使用 title/startAt/endAt/drawAt/winnerCount 字段名
    // 前端 form 使用 name/startTime/endTime/drawTime/maxWinners 需要映射
    const payload = {
      title: form.value.name,
      description: form.value.description,
      startAt: dateTimeLocalToIso(form.value.startTime),
      endAt: dateTimeLocalToIso(form.value.endTime),
      drawAt: form.value.drawTime ? dateTimeLocalToIso(form.value.drawTime) : undefined,
      winnerCount: form.value.activityKind === 'lottery' ? Number(form.value.winnerCount) || 1 : 0,
      maxParticipants: form.value.maxParticipants ? Number(form.value.maxParticipants) : undefined,
      participationMode: form.value.participationMode || 'open',
      experienceType: form.value.experienceType || defaultExperienceForActivity(form.value.activityKind || 'lottery', form.value.participationMode || 'open'),
      activityKind: form.value.activityKind || 'lottery',
      // resultMode 是“结果什么时候/如何产生”的业务语义，不能由抽奖旧逻辑统一覆盖。
      // 模板和活动类型默认值必须原样传给后端，否则问卷/签到/资料领取会被误建成 manual 抽奖语义。
      resultMode: form.value.resultMode || defaultResultModeForActivity(form.value.activityKind || 'lottery'),
      allocationPolicy: form.value.allocationPolicy || 'capacity',
      activityConfig: (() => {
        // survey/vote 发送完整内容配置；lottery 发送活动后承接（未中奖自动发券）配置
        if (['survey', 'vote'].includes(form.value.activityKind || '')) {
          return normalizeActivityConfig(form.value.activityKind || 'lottery', form.value.activityConfig)
        }
        if (form.value.activityKind === 'lottery') {
          syncLoserReward()
          const config = form.value.activityConfig as any
          return { version: 1, kind: 'lottery', loserReward: config?.loserReward || { enabled: false, couponLabel: '' } }
        }
        return undefined
      })(),
      accessPassword: form.value.accessPassword || '',
      // 导流：商品链接（启用时发送，关闭时发送 undefined）
      productLink: form.value.enableProductLink && form.value.productLink.url
        ? form.value.productLink
        : undefined,
      // 导流与裂变：版本化配置（PromotionConfigV1 + ctas 扩展）
      promotionConfig: (form.value.enableProductLink && form.value.productLink.url) || form.value.enableViral
        || form.value.enableAfterWinCta || form.value.enableAfterLossCta
        ? {
            version: 1,
            enabled: true,
            kind: 'destination',
            placement: 'after_join',
            ...(form.value.enableProductLink && form.value.productLink.url ? {
              destination: {
                url: form.value.productLink.url,
                title: form.value.productLink.title,
                imageUrl: form.value.productLink.imageUrl || '',
                priceText: form.value.productLink.price || '',
              },
              tracking: { enabled: true },
            } : {}),
            ...(form.value.enableViral ? {
              viral: {
                enabled: true,
                extraEntriesPerInvite: form.value.viralExtraEntriesPerInvite || 1,
                maxExtraEntries: form.value.viralMaxExtraEntries || 10,
                leaderboardEnabled: form.value.viralLeaderboardEnabled ?? true,
              },
            } : {}),
            // 多状态 CTA：中奖/未中奖不同导流卡片
            ctas: {
              ...(form.value.enableAfterWinCta && form.value.afterWinCtaUrl ? {
                after_win: { url: form.value.afterWinCtaUrl, title: form.value.afterWinCtaTitle || '' },
              } : {}),
              ...(form.value.enableAfterLossCta && form.value.afterLossCtaUrl ? {
                after_loss: { url: form.value.afterLossCtaUrl, title: form.value.afterLossCtaTitle || '' },
              } : {}),
            },
          }
        : undefined,
    }
    if (isEditing.value && form.value.id) {
      const current = draws.value.find((d) => d.id === form.value.id)
      if (current && current.status !== 'draft') {
        showToast('只有草稿状态的活动可以编辑', 'error')
        closeEditor()
        form.value = emptyForm()
        return
      }
      await updateLotteryDraw(form.value.id, payload)
      showToast('活动已更新', 'success')
    } else {
      const created = await createLotteryDraw(payload)
      if (created?.id) {
        // 如果是 roster 模式，导入名单
        if (form.value.participationMode === 'roster' && rosterInput.value.trim()) {
          const emails = rosterInput.value
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .map(email => ({ email }))
          if (emails.length > 0) {
            try {
              await adminRequest(`/api/admin/draws/${created.id}/roster`, {
                method: 'POST',
                body: JSON.stringify({ members: emails }),
              })
            } catch { /* 导入失败不阻断主流程 */ }
          }
        }
        // 如果是 invite_code 模式，生成邀请码
        if (form.value.participationMode === 'invite_code' && inviteCodeCount.value > 0) {
          try {
            await adminRequest(`/api/admin/draws/${created.id}/invite-codes`, {
              method: 'POST',
              body: JSON.stringify({ count: inviteCodeCount.value, maxUses: 1 }),
            })
          } catch { /* 生成失败不阻断主流程 */ }
        }
        // 抽奖活动：创建成功后保存奖项配置（选择奖品库中的奖品 + 中奖名额）
        if (form.value.activityKind === 'lottery' && form.value.tiers.some(t => t.prizeId)) {
          const validTiers = form.value.tiers
            .filter(t => t.prizeId)
            .map((t, i) => ({
              prizeId: t.prizeId,
              tierName: t.tierName || `奖项 ${i + 1}`,
              winnerCount: Math.max(1, Number(t.winnerCount) || 1),
            }))
          if (validTiers.length > 0) {
            try {
              await adminRequest(`/api/admin/draws/${created.id}/tiers`, {
                method: 'POST',
                body: JSON.stringify({ tiers: validTiers }),
              })
            } catch { /* 奖项保存失败不阻断主流程，用户可在编辑时重试 */ }
          }
        }
        try {
          await writeClipboardText(publicShareUrl(created.publicSlug || created.id))
        } catch { /* 剪贴板写入失败不阻断 */ }
        showToast('活动已创建，链接已复制', 'success')
        closeEditor()
        form.value = emptyForm()
        await loadData()
        // 创建成功后自动打开编辑模式，让用户立即配置奖品和发布
        if (created.id) {
          const newDraw = draws.value.find((d: any) => d.id === created.id)
          if (newDraw) handleEdit(newDraw)
        }
      } else {
        showToast('活动已创建', 'success')
        closeEditor()
        form.value = emptyForm()
        await loadData()
      }
    }
  } catch (e: any) {
    showToast(e?.message || '创建失败', 'error')
  } finally {
    creating.value = false
  }
}

onMounted(() => {
  loadData()
  loadPrizeOptions()
  // 从运营台空状态跳转过来时，自动打开模板选择弹窗。
  if (route.query.new === 'true') {
    openTemplatePicker()
  }
})
</script>

<style>
@import '@/assets/admin.css';
</style>

<style>
/* 仅本页编辑器结构；颜色/分区 token 仍来自 admin.css，禁止 scoped 以免合约失败 */
.lottery-editor-form {
  gap: 0;
  min-height: 0;
  flex: 1 1 auto;
  max-height: min(78dvh, 720px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.lottery-editor-scroll {
  display: flex;
  flex-direction: column;
  gap: var(--admin-card-gap, 12px);
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 2px;
  padding-bottom: 4px;
}

.lottery-editor-footer.modal-actions {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 0;
  padding-top: 12px;
  border-top: 0.5px solid var(--border, rgba(255, 255, 255, 0.12));
  background: var(--tg-bg, #0f172a);
  padding-right: 2px;
}

.lottery-editor-footer .btn {
  min-width: 88px;
  max-width: 100%;
}

/* 二维码弹窗 */
.qr-modal-body { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 16px; }
.qr-image { width: 240px; height: 240px; border-radius: 8px; background: #fff; padding: 8px; }
.qr-hint { font-size: 13px; color: var(--tg-hint, #9aa4b2); }
.qr-actions { display: flex; gap: 8px; }

/* 海报弹窗 */
.poster-modal-body { display: flex; flex-direction: column; align-items: center; gap: 16px; }
.poster-preview-wrap { border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.3); width: 100%; max-width: 360px; }
.poster-preview { display: block; width: 100%; height: auto; }
.poster-loading { display: flex; align-items: center; justify-content: center; height: 400px; color: var(--tg-hint, #9aa4b2); font-size: 14px; }
.poster-actions { display: flex; gap: 8px; }

/* 海报模板（html-to-image 截图目标） */
.poster-template {
  position: fixed; left: -10000px; top: 0; /* 移出视口避免闪现，v-show 控制显示 */
  width: 400px; height: 560px;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  background: linear-gradient(160deg, #0f0c29 0%, #302b63 55%, #24243e 100%);
  color: #fff;
}
.poster-template-bg { position: absolute; inset: 0; overflow: hidden; }
.poster-template-orb {
  position: absolute; border-radius: 50%; filter: blur(40px); opacity: 0.45;
}
.poster-template-orb-1 { width: 220px; height: 220px; background: #f59e0b; top: -60px; right: -60px; }
.poster-template-orb-2 { width: 160px; height: 160px; background: #ef4444; bottom: 80px; left: -50px; }
.poster-template-orb-3 { width: 120px; height: 120px; background: #3b82f6; bottom: -30px; right: 40px; }
.poster-template-content {
  position: relative; z-index: 1; height: 100%;
  display: flex; flex-direction: column; align-items: center;
  padding: 32px 24px 20px; box-sizing: border-box; text-align: center;
}
.poster-brand { font-size: 15px; font-weight: 700; color: #f59e0b; letter-spacing: 2px; margin-bottom: 6px; }
.poster-kind {
  font-size: 11px; color: #fbbf24; background: rgba(245,158,11,0.15);
  border: 1px solid rgba(245,158,11,0.4); border-radius: 20px;
  padding: 3px 14px; margin-bottom: 16px;
}
.poster-title {
  font-size: 26px; font-weight: 800; line-height: 1.3; margin: 0 0 18px;
  word-break: break-all;
}
.poster-prizes {
  display: flex; flex-direction: column; gap: 8px; width: 100%;
  background: rgba(255,255,255,0.07); border-radius: 12px;
  padding: 14px; margin-bottom: 16px; box-sizing: border-box;
}
.poster-prize-row { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.poster-prize-medal { font-size: 18px; }
.poster-prize-name { font-weight: 600; }
.poster-prizes-empty { font-size: 15px; color: #fbbf24; margin-bottom: 16px; font-weight: 600; }
.poster-time { font-size: 12px; color: rgba(255,255,255,0.7); margin-bottom: 18px; }
.poster-qr-wrap {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  width: 100%;
}
.poster-qr {
  width: 170px; height: 170px; border-radius: 12px;
  background: #fff; padding: 8px; box-sizing: border-box;
}
.poster-qr-hint { font-size: 12px; color: rgba(255,255,255,0.8); line-height: 1.5; }
.poster-footer { font-size: 10px; color: rgba(255,255,255,0.4); margin-top: 8px; }

.analytics-modal-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.analytics-modal-head,
.analytics-section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.analytics-modal-head h3,
.analytics-section h4 {
  margin: 0;
  font-size: 15px;
  line-height: 1.3;
}

.analytics-modal-head p {
  margin: 4px 0 0;
  color: var(--tg-hint, #9aa4b2);
  font-size: 12px;
  line-height: 1.5;
}

.analytics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
  gap: 8px;
}

.analytics-card {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: var(--r-md, 8px);
  background: var(--tg-secondary-bg, #151b28);
  min-width: 0;
}

.analytics-value {
  color: var(--admin-accent, #f59e0b);
  font-size: 22px;
  font-weight: 700;
  line-height: 1.1;
}

.analytics-label {
  color: var(--tg-hint, #9aa4b2);
  font-size: 12px;
}

.analytics-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.analytics-rates,
.analytics-type-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
}

.analytics-rates > div,
.analytics-type-list > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: var(--r-md, 8px);
  background: var(--surface, rgba(255, 255, 255, 0.04));
  min-width: 0;
}

.analytics-rates span,
.analytics-type-list strong {
  color: var(--tg-text, #f0f2f5);
  font-weight: 700;
}

.analytics-rates small,
.analytics-type-list small {
  color: var(--tg-hint, #9aa4b2);
  font-size: 12px;
}

.analytics-table-wrap {
  flex: 0 1 auto;
  max-height: 280px;
}

/* 模板选择网格 */
.template-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
  padding: 8px 0;
}
.template-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 20px 12px;
  background: var(--tg-secondary-bg, #151b28);
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s;
  text-align: center;
}
.template-card:hover {
  border-color: var(--admin-accent, #f59e0b);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.2);
}
.template-card--blank {
  border-style: dashed;
  opacity: 0.7;
}
.template-card--blank:hover {
  opacity: 1;
}
.template-icon {
  font-size: 32px;
  line-height: 1;
}
.template-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--tg-text, #f3f4f6);
}
.template-desc {
  font-size: 11px;
  color: var(--tg-hint, #9aa4b2);
  line-height: 1.4;
}
.template-category {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 4px;
}

/* 奖项配置 */
.tier-list { display: flex; flex-direction: column; gap: 8px; }
.tier-row { display: flex; gap: 8px; align-items: center; }
.tier-prize { flex: 2; min-width: 0; }
.tier-name { flex: 1.5; min-width: 0; }
.tier-count { flex: 0.5; min-width: 70px; }
.tier-actions { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
</style>
