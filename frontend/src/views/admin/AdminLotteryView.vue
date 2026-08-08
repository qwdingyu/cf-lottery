<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <select v-model="statusFilter" :aria-label="$t('lottery.adminStatus')" @change="reloadFromFirstPage">
          <!-- docs/083 P1：默认「进行中」视角，避免 drawn/cancelled 刷屏 -->
          <option value="active">{{ $t('lottery.adminStatusActive') }}</option>
          <option value="">{{ $t('lottery.adminStatusAll') }}</option>
          <option value="draft">{{ $t('lottery.adminDrawDraft') }}</option>
          <option value="open">{{ $t('lottery.statusOpen') }}</option>
          <option value="paused">{{ $t('lottery.statusPaused') }}</option>
          <option value="drawing">{{ $t('lottery.statusDrawing') }}</option>
          <option value="drawn">{{ $t('lottery.statusDrawn') }}</option>
          <option value="cancelled">{{ $t('lottery.adminDrawCancelled') }}</option>
        </select>
        <!-- 活动类型筛选（047 文档 🔴） -->
        <select v-model="activityKindFilter" :aria-label="$t('lottery.adminActivityKind')" @change="reloadFromFirstPage">
          <option value="">{{ $t('lottery.adminFilterKindAll') }}</option>
          <option value="lottery">{{ $t('lottery.adminKindLottery') }}</option>
          <option value="signup_chain">{{ $t('lottery.adminFilterKindSignup') }}</option>
          <option value="reservation">{{ $t('lottery.adminFilterKindReservation') }}</option>
          <option value="vote">{{ $t('lottery.adminFilterKindVote') }}</option>
          <option value="survey">{{ $t('lottery.adminFilterKindSurvey') }}</option>
          <option value="checkin">{{ $t('lottery.adminFilterKindCheckin') }}</option>
          <option value="approval">{{ $t('lottery.adminFilterKindApproval') }}</option>
          <option value="claim">{{ $t('lottery.adminFilterKindClaim') }}</option>
        </select>
        <input
          v-model="listQuery"
          type="search"
          :placeholder="$t('lottery.adminSearchPlaceholder')"
          :aria-label="$t('lottery.adminSearchAria')"
          @keyup.enter="reloadFromFirstPage"
        />
        <!-- 创建时间范围筛选（047 文档 🟡） -->
        <input v-model="createdFromFilter" type="date" :aria-label="$t('lottery.adminCreatedFrom')" :title="$t('lottery.adminCreatedFrom')" @change="reloadFromFirstPage" />
        <input v-model="createdToFilter" type="date" :aria-label="$t('lottery.adminCreatedTo')" :title="$t('lottery.adminCreatedTo')" @change="reloadFromFirstPage" />
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="loadData">
          {{ $t('lottery.adminReload') }}
        </button>
        <button
          v-if="hasListFilter"
          class="btn btn-ghost btn-sm"
          type="button"
          :disabled="loading || batchOperating"
          @click="clearListFilters"
        >{{ $t('lottery.adminClearFilters') }}</button>
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

    <div class="notice-card" role="note" style="margin-bottom:12px">
      <!-- 055a：TTV 提示，避免「专家配置台」恐吓文案 -->
      <span>{{ $t('lottery.adminListTtvHint') }}</span>
    </div>

    <div v-if="selectedCount > 0" class="table-command-actions bulk-bar" :aria-busy="batchOperating">
      <span class="selection-summary">
        {{ t('lottery.adminSelectedCount', { count: selectedCount }) }}
        <template v-if="selectedPausableCount > 0">
          · {{ t('lottery.adminSelectedPausable', { count: selectedPausableCount }) }}
        </template>
        <template v-if="selectedResumableCount > 0">
          · {{ t('lottery.adminSelectedResumable', { count: selectedResumableCount }) }}
        </template>
        <template v-if="selectedCancellableCount > 0">
          · {{ t('lottery.adminSelectedCancellable', { count: selectedCancellableCount }) }}
        </template>
        <template v-if="selectedHideableCount > 0">
          · {{ t('lottery.adminSelectedHideable', { count: selectedHideableCount }) }}
        </template>
        <template v-if="selectedDeletableCount > 0">
          · {{ t('lottery.adminSelectedDeletable', { count: selectedDeletableCount }) }}
        </template>
        <template v-if="batchOperating">
          · {{ t('lottery.adminBatchProgress', { done: batchCompleted, total: batchTotal }) }}
        </template>
      </span>
      <button class="btn btn-ghost btn-sm" :disabled="loading || batchOperating" @click="clearSelection">
        {{ t('lottery.adminClearSelection') }}
      </button>
      <button
        class="btn btn-ghost btn-sm"
        type="button"
        :disabled="loading || batchOperating || selectedCount === 0"
        @click="exportSelectedDraws"
      >
        {{ t('lottery.adminExportSelected', { count: selectedCount }) }}
      </button>
      <!-- open → paused：测试期停收参与比删更安全 -->
      <button
        class="btn btn-ghost btn-sm"
        type="button"
        :disabled="loading || batchOperating || selectedPausableCount === 0"
        @click="batchPauseDraws"
      >
        {{ t('lottery.adminBatchPause', { count: selectedPausableCount }) }}
      </button>
      <button
        class="btn btn-ghost btn-sm"
        type="button"
        :disabled="loading || batchOperating || selectedResumableCount === 0"
        @click="batchResumeDraws"
      >
        {{ t('lottery.adminBatchResume', { count: selectedResumableCount }) }}
      </button>
      <!-- draft/open/paused → cancelled：关停保留记录，比物理删除更安全 -->
      <button
        class="btn btn-ghost btn-sm"
        type="button"
        :disabled="loading || batchOperating || selectedCancellableCount === 0"
        @click="batchCancelDraws"
      >
        {{ t('lottery.adminBatchCancel', { count: selectedCancellableCount }) }}
      </button>
      <!-- docs/083：批量隐藏已开奖比批量删更安全，适合清用户视野 -->
      <button
        class="btn btn-ghost btn-sm"
        :disabled="loading || batchOperating || selectedHideableCount === 0"
        @click="batchHideDrawn"
      >
        {{ t('lottery.adminBatchHide', { count: selectedHideableCount }) }}
      </button>
      <button
        class="btn btn-danger btn-sm"
        :disabled="loading || batchOperating || selectedDeletableCount === 0"
        @click="batchDeleteDraws"
      >
        {{ t('lottery.adminBatchDelete', { count: selectedDeletableCount }) }}
      </button>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" type="button" :disabled="loading" @click="loadData">
        {{ $t('lottery.adminReload') }}
      </button>
    </div>

    <div class="table-wrap" role="region" :aria-label="$t('adminLayout.menuLottery')" tabindex="0" :aria-busy="loading">
      <table class="admin-table" :aria-label="$t('adminLayout.menuLottery')">
        <thead>
          <tr>
            <th class="select-cell">
              <input
                type="checkbox"
                :checked="allVisibleSelected"
                :indeterminate.prop="partiallySelected"
                :disabled="loading || batchOperating"
                :aria-label="$t('lottery.adminSelectAll')"
                @change="toggleAllVisible(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ $t('lottery.adminName') }}</th>
            <th>{{ $t('lottery.adminGoalType') }}</th>
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
              <!-- Shift 连选必须用 click：change 事件无可靠的 shiftKey（对齐 AdminLogsView / cf-shop） -->
              <input
                type="checkbox"
                :checked="isSelected(draw.id)"
                :disabled="loading || batchOperating || !canSelectDraw(draw)"
                :aria-label="$t('lottery.adminSelectRow')"
                @click="setSelected(draw.id, ($event.target as HTMLInputElement).checked, ($event as MouseEvent).shiftKey)"
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
                <!-- 开启失败后钉行内：不靠再点一次才看 toast；点编辑可补齐 -->
                <small
                  v-if="draw.status === 'draft' && draftPublishBlockers[draw.id]"
                  class="draft-blocker-snippet"
                  :title="draftPublishBlockers[draw.id]"
                >
                  {{ $t('lottery.adminDraftNeedFix') }}：{{ draftPublishBlockers[draw.id] }}
                </small>
              </div>
            </td>
            <td>
              <div class="relation-cell">
                <span>{{ activityKindLabel(draw.activityKind) }}</span>
                <small class="muted-text">{{ experienceTypeLabel(draw.experienceType) }}</small>
                <!-- instant 与 delayed 结果机互斥，列表一眼可辨（docs/118 后续） -->
                <small
                  v-if="shouldShowAdminInstantResultTag(draw.resultMode)"
                  class="tag tag-info"
                >{{ $t('lottery.adminResultInstantTag') }}</small>
                <small
                  v-else-if="draw.activityKind === 'lottery' && draw.resultMode"
                  class="muted-text"
                >{{ resultModeLabel(draw.resultMode) }}</small>
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
              <!--
                055a / docs/079：行内 ≤3（主 CTA + 次操作 + 更多）。
                「更多」用 Teleport 浮层，不撑开行高（旧版行内展开会把行拉成「操作墙」）。
              -->
              <div class="table-actions">
                <!-- draft：开启 + 编辑（编辑曾埋在更多，TTV 断点） -->
                <template v-if="draw.status === 'draft'">
                  <button
                    type="button"
                    class="btn btn-primary btn-xs"
                    :disabled="operatingId === draw.id"
                    @click="handleOpen(draw)"
                  >{{ operatingId === draw.id ? $t('lottery.loadingText') : $t('lottery.adminDrawOpen') }}</button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    :disabled="operatingId === draw.id"
                    @click="handleEdit(draw)"
                  >{{ $t('lottery.adminEdit') }}</button>
                </template>
                <!--
                  open 抽奖：分享优先（运营主路径是「发链接」）；
                  立即开奖仅在有参与时作主按钮，避免空池误点开奖（docs/074）。
                  instant：用户 spin 出结果，隐藏「立即开奖」（docs/116）。
                -->
                <template v-else-if="draw.status === 'open' && draw.activityKind === 'lottery'">
                  <button
                    type="button"
                    class="btn btn-primary btn-xs"
                    :disabled="operatingId === draw.id"
                    :title="$t('lottery.adminCopyLinkHint')"
                    @click="handleCopyShareLink(draw)"
                  >{{ $t('lottery.adminCopyLink') }}</button>
                  <button
                    v-if="shouldShowAdminDrawNowButton({ status: draw.status, activityKind: draw.activityKind, resultMode: draw.resultMode })"
                    type="button"
                    class="btn btn-ghost btn-xs"
                    :disabled="operatingId === draw.id || !canEnableDrawNow(draw.entryCount)"
                    :title="canEnableDrawNow(draw.entryCount) ? $t('lottery.adminDrawNow') : $t('lottery.adminDrawNowNeedEntries')"
                    @click="handleDraw(draw)"
                  >{{ operatingId === draw.id ? $t('lottery.loadingText') : $t('lottery.adminDrawNow') }}</button>
                  <button
                    v-else
                    type="button"
                    class="btn btn-ghost btn-xs"
                    :disabled="operatingId === draw.id"
                    @click="handlePause(draw.id)"
                  >{{ operatingId === draw.id ? $t('lottery.loadingText') : $t('lottery.adminPause') }}</button>
                </template>
                <!-- open 非抽奖：分享（主）+ 暂停 -->
                <template v-else-if="draw.status === 'open'">
                  <button
                    type="button"
                    class="btn btn-primary btn-xs"
                    :disabled="operatingId === draw.id"
                    :title="$t('lottery.adminCopyLinkHint')"
                    @click="handleCopyShareLink(draw)"
                  >{{ $t('lottery.adminCopyLink') }}</button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    :disabled="operatingId === draw.id"
                    @click="handlePause(draw.id)"
                  >{{ operatingId === draw.id ? $t('lottery.loadingText') : $t('lottery.adminPause') }}</button>
                </template>
                <!-- paused：恢复 + 分享 -->
                <template v-else-if="draw.status === 'paused'">
                  <button
                    type="button"
                    class="btn btn-primary btn-xs"
                    :disabled="operatingId === draw.id"
                    @click="handleResume(draw.id)"
                  >{{ operatingId === draw.id ? $t('lottery.loadingText') : $t('lottery.adminResume') }}</button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    :disabled="operatingId === draw.id"
                    :title="$t('lottery.adminCopyLinkHint')"
                    @click="handleCopyShareLink(draw)"
                  >{{ $t('lottery.adminCopyLink') }}</button>
                </template>
                <!-- drawing：恢复卡死 + 查看结果 -->
                <template v-else-if="draw.status === 'drawing'">
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    :disabled="operatingId === draw.id"
                    @click="handleRecover(draw.id)"
                  >{{ operatingId === draw.id ? $t('lottery.loadingText') : $t('lottery.adminRecoverDrawing') }}</button>
                  <button
                    v-if="draw.activityKind === 'lottery'"
                    type="button"
                    class="btn btn-ghost btn-xs"
                    :disabled="operatingId === draw.id || winnersLoading"
                    @click="viewWinners(draw.id)"
                  >{{ $t('lottery.checkResult') }}</button>
                </template>
                <!-- drawn：结果 + 分享（邮件失败时「查看结果」升为 primary，引导进重发） -->
                <template v-else-if="draw.status === 'drawn'">
                  <button
                    v-if="draw.activityKind === 'lottery'"
                    type="button"
                    class="btn btn-xs"
                    :class="drawnRowResultBtnClass(draw.id)"
                    :disabled="operatingId === draw.id || winnersLoading"
                    :title="drawnRowResultTitle(draw.id)"
                    @click="viewWinners(draw.id)"
                  >{{ $t('lottery.checkResult') }}</button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    :disabled="operatingId === draw.id"
                    :title="$t('lottery.adminCopyLinkHint')"
                    @click="handleCopyShareLink(draw)"
                  >{{ $t('lottery.adminCopyLink') }}</button>
                </template>
                <!-- cancelled 等：仅分享入口（若仍有 slug） -->
                <template v-else>
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    :disabled="operatingId === draw.id"
                    :title="$t('lottery.adminCopyLinkHint')"
                    @click="handleCopyShareLink(draw)"
                  >{{ $t('lottery.adminCopyLink') }}</button>
                </template>

                <button
                  type="button"
                  class="btn btn-ghost btn-xs table-actions-more-btn"
                  :ref="(el) => setMoreBtnRef(draw.id, el)"
                  :aria-expanded="expandedActionId === draw.id"
                  :aria-haspopup="true"
                  :title="$t('lottery.adminActionsMoreHint')"
                  @click.stop="toggleRowActions(draw.id, $event)"
                >{{ expandedActionId === draw.id ? $t('lottery.adminActionsLess') : $t('lottery.adminActionsMore') }}</button>
              </div>
            </td>
          </tr>
          <tr v-if="filteredDraws.length === 0">
            <td colspan="9" class="empty-text">
              <div v-if="hasListFilter" class="list-empty-block">
                <p>{{ $t('lottery.adminNoMatch') }}</p>
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  :disabled="loading"
                  @click="clearListFilters"
                >{{ $t('lottery.adminClearFilters') }}</button>
              </div>
              <!-- 上线 UX：零活动 / 默认进行中无数据 → 引导创建，不是「无匹配」 -->
              <div v-else class="list-empty-block list-empty-onboard">
                <p class="list-empty-title">{{ $t('lottery.adminListEmptyTitle') }}</p>
                <p class="list-empty-desc">{{ $t('lottery.adminListEmptyDesc') }}</p>
                <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
                  <button
                    class="btn btn-primary btn-sm"
                    type="button"
                    :disabled="loading || creating"
                    @click="openTemplatePicker"
                  >{{ $t('lottery.adminDrawCreate') }}</button>
                  <!-- 仅有历史 drawn 时：一键看全部，避免误以为系统空库 -->
                  <button
                    v-if="statusFilter === 'active'"
                    class="btn btn-ghost btn-sm"
                    type="button"
                    :disabled="loading"
                    @click="showAllStatuses"
                  >{{ $t('lottery.adminShowAllStatuses') }}</button>
                </div>
              </div>
            </td>
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
        <!--
          055a：创建路径 3～4 步指示（不新路由、不 Wizard 框架）。
          步骤完成态 + 正确滚动锚点；不改提交语义。
        -->
          <!--
            055a：创建路径 3～4 步指示（不新路由、不 Wizard 框架）。
            步骤完成态 + 正确滚动锚点；不改提交语义。
          -->
          <nav class="create-path-steps" :aria-label="$t('lottery.adminCreatePathAria')">
            <button
              type="button"
              class="create-path-step"
              :class="{ done: createStepDone.basic, current: createStepFocus === 1 }"
              @click="focusCreateStep(1)"
            >
              <span class="create-path-num">{{ createStepDone.basic ? '✓' : '1' }}</span>
              <span>{{ $t('lottery.adminCreateStepBasic') }}</span>
            </button>
            <button
              type="button"
              class="create-path-step"
              :class="{ done: createStepDone.time, current: createStepFocus === 2 }"
              @click="focusCreateStep(2)"
            >
              <span class="create-path-num">{{ createStepDone.time ? '✓' : '2' }}</span>
              <span>{{ $t('lottery.adminCreateStepTime') }}</span>
            </button>
            <button
              type="button"
              class="create-path-step"
              :class="{ done: createStepDone.join, current: createStepFocus === 3 }"
              @click="focusCreateStep(3)"
            >
              <span class="create-path-num">{{ createStepDone.join ? '✓' : '3' }}</span>
              <span>{{ $t('lottery.adminCreateStepJoin') }}</span>
            </button>
            <button
              type="button"
              class="create-path-step"
              :class="{ done: createStepDone.prizes, current: createStepFocus === 4 }"
              @click="focusCreateStep(4)"
            >
              <span class="create-path-num">{{ createStepDone.prizes ? '✓' : '4' }}</span>
              <span>{{ form.activityKind === 'lottery' ? $t('lottery.adminCreateStepPrizes') : $t('lottery.adminCreateStepQuota') }}</span>
            </button>
          </nav>
          <p v-if="createPathHint" class="create-path-hint" role="status">{{ createPathHint }}</p>
          <div class="lottery-editor-scroll">
            <section id="lottery-basic" class="form-section" aria-labelledby="lottery-basic-title">
            <header class="form-section-head">
              <h4 id="lottery-basic-title" class="form-section-title">{{ $t('lottery.adminSectionBasic') }}</h4>
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

          <section id="lottery-time" class="form-section" aria-labelledby="lottery-time-title">
            <header class="form-section-head">
              <h4 id="lottery-time-title" class="form-section-title">{{ $t('lottery.adminSectionTime') }}</h4>
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

          <!--
            主路径只保留「谁可以参加」：活动类型 + 参与方式 + 门槛字段。
            体验类型 13 项下拉属术语墙（055a 断点 C），默认放进高级配置，模板带入后可改。
          -->
          <section id="lottery-mode" class="form-section" aria-labelledby="lottery-mode-title">
            <header class="form-section-head">
              <h4 id="lottery-mode-title" class="form-section-title">{{ $t('lottery.adminParticipationMode') }}</h4>
              <p class="form-section-desc">{{ $t('lottery.adminParticipationModeDesc') }}</p>
            </header>
            <div class="form-grid two-cols">
              <label class="field-span-2">
                <span>{{ $t('lottery.adminActivityKind') }}</span>
                <select v-model="form.activityKind" @change="handleActivityKindChange">
                  <option v-for="opt in activityKindOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
                <small class="field-hint">{{ $t('lottery.adminActivityKindHint') }}</small>
              </label>
              <label class="field-span-2">
                <span>{{ $t('lottery.adminParticipationMode') }}</span>
                <select v-model="form.participationMode" @change="handleParticipationModeChange">
                  <option v-for="opt in participationModeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
              </label>
              <!-- 只读摘要：模板/默认体验可见，完整 13 项在高级配置中改，避免主路径术语墙 -->
              <p class="field-span-2 experience-summary" role="status">
                <span class="experience-summary-label">{{ $t('lottery.adminExperienceSummaryLabel') }}</span>
                <strong>{{ experienceTypeLabel(form.experienceType) }}</strong>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs experience-summary-edit"
                  @click="showAdvancedGrowth = true"
                >{{ $t('lottery.adminExperienceSummaryEdit') }}</button>
              </p>
              <label v-if="form.activityKind === 'signup_chain'" class="field-span-2">
                <span>{{ $t('lottery.adminAllocationPolicy') }}</span>
                <select v-model="form.allocationPolicy">
                  <option value="capacity">{{ $t('lottery.adminPolicyCapacity') }}</option>
                  <option value="waitlist">{{ $t('lottery.adminPolicyWaitlist') }}</option>
                </select>
                <small class="field-hint">{{ $t('lottery.adminAllocationHint') }}</small>
              </label>
              <label v-if="form.participationMode === 'password'" class="field-span-2">
                <span>{{ $t('lottery.adminAccessPassword') }}</span>
                <input v-model="form.accessPassword" type="text" maxlength="20" :placeholder="$t('lottery.adminAccessPasswordPlaceholder')" />
                <small class="field-hint">{{ $t('lottery.adminAccessPasswordHint') }}</small>
              </label>
              <label v-if="form.participationMode === 'roster'" class="field-span-2">
                <span>{{ $t('lottery.adminRosterLabel') }}</span>
                <textarea v-model="rosterInput" rows="5" placeholder="user1@example.com&#10;user2@example.com&#10;user3@example.com" />
                <small class="field-hint">{{ $t('lottery.adminRosterHint') }}</small>
              </label>
              <label v-if="form.participationMode === 'invite_code'" class="field-span-2">
                <span>{{ $t('lottery.adminInviteCodeCount') }}</span>
                <input v-model.number="inviteCodeCount" type="number" min="1" max="1000" step="1" />
                <small class="field-hint">{{ $t('lottery.adminInviteCodeHint') }}</small>
              </label>
            </div>
          </section>

          <!--
            055a P0 / ADR-055a-3：导流 / 裂变 / CTA 默认折叠为「高级配置」。
            能力保留、handler 与提交 payload 不变；只减少主路径同屏决策。
          -->
          <section class="form-section form-section--advanced" aria-labelledby="lottery-advanced">
            <header class="form-section-head form-section-head--toggle">
              <button
                type="button"
                class="form-advanced-toggle"
                :aria-expanded="showAdvancedGrowth"
                aria-controls="lottery-advanced-body"
                @click="showAdvancedGrowth = !showAdvancedGrowth"
              >
                <span class="form-section-title" id="lottery-advanced">{{ $t('lottery.adminAdvancedGrowthSection') }}</span>
                <span class="form-advanced-toggle-meta">
                  {{ showAdvancedGrowth ? $t('lottery.adminAdvancedCollapse') : $t('lottery.adminAdvancedExpand') }}
                </span>
              </button>
              <p class="form-section-desc">{{ $t('lottery.adminAdvancedGrowthDesc') }}</p>
            </header>
            <div v-show="showAdvancedGrowth" id="lottery-advanced-body" class="form-advanced-body">
              <!-- 体验类型：模板已带默认值；完整列表仅在此修改（055a 断点 C） -->
              <section class="form-section form-section--nested" aria-labelledby="lottery-experience">
                <header class="form-section-head">
                  <h4 id="lottery-experience" class="form-section-title">{{ $t('lottery.adminExperienceType') }}</h4>
                  <p class="form-section-desc">{{ $t('lottery.adminExperienceAdvancedDesc') }}</p>
                </header>
                <div class="form-grid two-cols">
                  <label class="field-span-2">
                    <span>{{ $t('lottery.adminExperienceType') }}</span>
                    <select v-model="form.experienceType">
                      <option value="wheel">{{ $t('lottery.adminExpWheel') }}</option>
                      <option value="slot">{{ $t('lottery.adminExpSlot') }}</option>
                      <option value="scratch">{{ $t('lottery.adminExpScratch') }}</option>
                      <option value="card">{{ $t('lottery.adminExpCard') }}</option>
                      <option value="list">{{ $t('lottery.adminExpList') }}</option>
                      <option value="queue">{{ $t('lottery.adminExpQueue') }}</option>
                      <option value="form">{{ $t('lottery.adminExpForm') }}</option>
                      <option value="ballot">{{ $t('lottery.adminExpBallot') }}</option>
                      <option value="calendar">{{ $t('lottery.adminExpCalendar') }}</option>
                      <option value="checkin">{{ $t('lottery.adminExpCheckin') }}</option>
                      <option value="reveal">{{ $t('lottery.adminExpReveal') }}</option>
                      <option value="grid">{{ $t('lottery.adminExpGrid') }}</option>
                      <option value="submit">{{ $t('lottery.adminExpSubmit') }}</option>
                    </select>
                    <small class="field-hint">{{ $t('lottery.adminExperienceHint') }}</small>
                  </label>
                </div>
              </section>

              <!--
                游戏壳奖品展示（docs/128）：
                delayed 默认扇面=仪式短语；instant 默认真奖名。
                与 experienceType 解耦：同一转盘可换「壳文案策略」。
              -->
              <section
                v-if="form.activityKind === 'lottery'"
                class="form-section form-section--nested"
                aria-labelledby="lottery-prize-shell"
              >
                <header class="form-section-head">
                  <h4 id="lottery-prize-shell" class="form-section-title">{{ $t('lottery.adminPrizeShellSection') }}</h4>
                  <p class="form-section-desc">{{ $t('lottery.adminPrizeShellSectionDesc') }}</p>
                </header>
                <div class="form-grid two-cols">
                  <label class="field-span-2">
                    <span>{{ $t('lottery.adminPrizePanelMode') }}</span>
                    <select v-model="form.prizePanelMode">
                      <option value="auto">{{ $t('lottery.adminPrizePanelAuto') }}</option>
                      <option value="full_on_shell">{{ $t('lottery.adminPrizePanelFullShell') }}</option>
                      <option value="shell_ritual_pool_full">{{ $t('lottery.adminPrizePanelRitualFull') }}</option>
                      <option value="shell_ritual_pool_summary">{{ $t('lottery.adminPrizePanelRitualSummary') }}</option>
                      <option value="ritual_only">{{ $t('lottery.adminPrizePanelRitualOnly') }}</option>
                    </select>
                    <small class="field-hint">{{ $t('lottery.adminPrizePanelModeHint') }}</small>
                    <small v-if="form.prizePanelMode === 'auto'" class="field-hint">
                      {{ form.resultMode === 'instant'
                        ? $t('lottery.adminPrizePanelModeAutoInstant')
                        : $t('lottery.adminPrizePanelModeAutoDelayed') }}
                    </small>
                    <small
                      v-if="form.resultMode !== 'instant' && form.prizePanelMode === 'full_on_shell'"
                      class="field-hint"
                      style="color:#d64541;font-weight:600"
                      role="alert"
                    >
                      {{ $t('lottery.adminPrizePanelModeConflict') }}
                    </small>
                  </label>
                  <label
                    v-if="form.prizePanelMode !== 'full_on_shell' && (form.resultMode !== 'instant' || form.prizePanelMode !== 'auto')"
                    class="field-span-2"
                  >
                    <span>{{ $t('lottery.adminRitualPhrases') }}</span>
                    <textarea
                      v-model="form.ritualPhrasesText"
                      rows="4"
                      maxlength="200"
                      :placeholder="$t('lottery.adminRitualPhrasesPlaceholder')"
                    />
                    <small class="field-hint">{{ $t('lottery.adminRitualPhrasesHint') }}</small>
                  </label>
                </div>
              </section>

              <!-- 秒杀壳配置（docs/130/131）：默认展示/导流；paymentRequired=true 时走 cf-lottery 直付发卡 -->
              <section class="form-section form-section--nested" aria-labelledby="lottery-flash-sale">
                <header class="form-section-head">
                  <h4 id="lottery-flash-sale" class="form-section-title">{{ $t('lottery.adminFlashSaleSection') }}</h4>
                  <p class="form-section-desc">{{ $t('lottery.adminFlashSaleSectionDesc') }}</p>
                </header>
                <div class="form-grid two-cols">
                  <label class="field-span-2">
                    <input v-model="form.enableFlashSale" type="checkbox" class="checkbox-inline" />
                    <span>{{ $t('lottery.adminEnableFlashSale') }}</span>
                  </label>
                  <template v-if="form.enableFlashSale">
                    <label>
                      <span>{{ $t('lottery.adminFlashSaleSessionLabel') }}</span>
                      <input v-model="form.flashSaleSessionLabel" maxlength="32" :placeholder="$t('lottery.adminFlashSaleSessionPlaceholder')" />
                    </label>
                    <label>
                      <span>{{ $t('lottery.adminFlashSaleCtaLabel') }}</span>
                      <input v-model="form.flashSaleCtaLabel" maxlength="12" placeholder="抢" />
                    </label>
                    <label>
                      <span>{{ $t('lottery.adminFlashSaleStockLimit') }}</span>
                      <input v-model.number="form.flashSaleStockLimit" type="number" min="1" max="1000000" :placeholder="$t('lottery.adminFlashSaleStockPlaceholder')" />
                      <small class="field-hint">{{ $t('lottery.adminFlashSaleStockHint') }}</small>
                    </label>
                    <label>
                      <span>{{ $t('lottery.adminFlashSaleMaxPerUser') }}</span>
                      <input v-model.number="form.flashSaleMaxPerUser" type="number" min="1" max="100" />
                    </label>
                    <label class="field-span-2">
                      <input v-model="form.flashSalePaymentRequired" type="checkbox" class="checkbox-inline" />
                      <span>{{ $t('lottery.adminFlashSalePaymentRequired') }}</span>
                    </label>
                    <template v-if="form.flashSalePaymentRequired">
                      <div class="field-span-2 flash-sale-checklist" aria-live="polite">
                        <div class="flash-sale-checklist-head">
                          <strong>{{ $t('lottery.adminFlashSaleDirectChecklistTitle') }}</strong>
                          <span>{{ $t('lottery.adminFlashSaleDirectChecklistDesc') }}</span>
                        </div>
                        <ul>
                          <li v-for="item in flashSaleDirectChecklist" :key="item.key" :class="{ done: item.done }">
                            <span class="check-dot">{{ item.done ? '✓' : '!' }}</span>
                            <span>{{ $t(`lottery.${item.labelKey}`) }}</span>
                          </li>
                        </ul>
                        <div class="flash-sale-checklist-actions">
                          <RouterLink to="/admin/payment-config" class="btn btn-ghost btn-xs">
                            {{ $t('lottery.adminFlashSaleGoPaymentConfig') }}
                          </RouterLink>
                          <RouterLink to="/admin/prizes" class="btn btn-ghost btn-xs">
                            {{ $t('lottery.adminFlashSaleGoPrizeCodes') }}
                          </RouterLink>
                        </div>
                      </div>
                      <label>
                        <span>{{ $t('lottery.adminFlashSalePriceYuan') }}</span>
                        <input v-model="flashSalePriceYuan" type="number" min="0.01" step="0.01" max="1000000" placeholder="9.90" />
                        <small>{{ $t('lottery.adminFlashSalePriceHint') }}</small>
                      </label>
                      <label>
                        <span>{{ $t('lottery.adminFlashSaleCurrency') }}</span>
                        <select v-model="form.flashSaleCurrency">
                          <option value="cny">CNY</option>
                          <option value="usd">USD</option>
                          <option value="eur">EUR</option>
                        </select>
                      </label>
                      <label class="field-span-2">
                        <span>{{ $t('lottery.adminFlashSalePaymentTitle') }}</span>
                        <input v-model="form.flashSaleTitle" maxlength="100" />
                      </label>
                    </template>
                    <label class="field-span-2">
                      <input v-model="form.flashSaleShowCountdown" type="checkbox" class="checkbox-inline" />
                      <span>{{ $t('lottery.adminFlashSaleShowCountdown') }}</span>
                    </label>
                    <label class="field-span-2">
                      <input v-model="form.flashSaleShowProgress" type="checkbox" class="checkbox-inline" />
                      <span>{{ $t('lottery.adminFlashSaleShowProgress') }}</span>
                    </label>
                    <label class="field-span-2">
                      <input v-model="form.flashSaleShowStock" type="checkbox" class="checkbox-inline" />
                      <span>{{ $t('lottery.adminFlashSaleShowStock') }}</span>
                    </label>
                    <p class="field-span-2 field-hint">{{ $t('lottery.adminFlashSaleShopHint') }}</p>
                  </template>
                </div>
              </section>

              <!-- 导流配置：关联商品推广 -->
              <section class="form-section form-section--nested" aria-labelledby="lottery-traffic">
                <header class="form-section-head">
                  <h4 id="lottery-traffic" class="form-section-title">{{ $t('lottery.adminTrafficSection') }}</h4>
                  <p class="form-section-desc">{{ $t('lottery.adminTrafficSectionDesc') }}</p>
                </header>
                <div class="form-grid two-cols">
                  <label class="field-span-2">
                    <input v-model="form.enableProductLink" type="checkbox" class="checkbox-inline" />
                    <span>{{ $t('lottery.adminEnableProductLink') }}</span>
                  </label>
                  <template v-if="form.enableProductLink">
                    <label class="field-span-2">
                      <span>{{ $t('lottery.adminProductLink') }}</span>
                      <input v-model="form.productLink.url" type="url" placeholder="https://shop.example.com/product/123" />
                    </label>
                    <label>
                      <span>{{ $t('lottery.adminProductTitle') }}</span>
                      <input v-model="form.productLink.title" maxlength="100" :placeholder="$t('lottery.adminProductTitlePlaceholder')" />
                    </label>
                    <label>
                      <span>{{ $t('lottery.adminProductPrice') }}</span>
                      <input v-model="form.productLink.price" placeholder="¥299" />
                    </label>
                    <label class="field-span-2">
                      <span>{{ $t('lottery.adminProductImageUrl') }}</span>
                      <input v-model="form.productLink.imageUrl" type="url" placeholder="https://img.example.com/xxx.jpg" />
                    </label>
                  </template>
                </div>
              </section>

              <!-- 裂变传播配置 -->
              <section class="form-section form-section--nested" aria-labelledby="lottery-viral">
                <header class="form-section-head">
                  <h4 id="lottery-viral" class="form-section-title">{{ $t('lottery.adminViralSection') }}</h4>
                  <p class="form-section-desc">{{ $t('lottery.adminViralSectionDesc') }}</p>
                </header>
                <div class="form-grid two-cols">
                  <label class="field-span-2">
                    <input v-model="form.enableViral" type="checkbox" class="checkbox-inline" />
                    <span>{{ $t('lottery.adminEnableViral') }}</span>
                  </label>
                  <template v-if="form.enableViral">
                    <label>
                      <span>{{ form.resultMode === 'instant' ? $t('lottery.adminViralPerInviteSpinsLabel') : $t('lottery.adminViralPerInviteLabel') }}</span>
                      <input v-model.number="form.viralExtraEntriesPerInvite" type="number" min="1" max="10" />
                      <small>{{ form.resultMode === 'instant' ? $t('lottery.adminViralPerInviteSpinsSuffix') : $t('lottery.adminViralPerInviteSuffix') }}</small>
                    </label>
                    <label>
                      <span>{{ form.resultMode === 'instant' ? $t('lottery.adminViralMaxSpinsLabel') : $t('lottery.adminViralMaxLabel') }}</span>
                      <input v-model.number="form.viralMaxExtraEntries" type="number" min="1" max="100" />
                      <small>{{ form.resultMode === 'instant' ? $t('lottery.adminViralMaxSpinsSuffix') : $t('lottery.adminViralMaxSuffix') }}</small>
                    </label>
                    <label class="field-span-2">
                      <input v-model="form.viralLeaderboardEnabled" type="checkbox" class="checkbox-inline" />
                      <span>{{ $t('lottery.adminViralLeaderboard') }}</span>
                      <small>{{ $t('lottery.adminViralLeaderboardHint') }}</small>
                    </label>
                  </template>
                </div>
              </section>

              <!-- 多状态 CTA 承接：中奖/未中奖不同导流 -->
              <section class="form-section form-section--nested" aria-labelledby="lottery-ctas">
                <header class="form-section-head">
                  <h4 id="lottery-ctas" class="form-section-title">{{ $t('lottery.adminCtaSection') }}</h4>
                  <p class="form-section-desc">{{ $t('lottery.adminCtaSectionDesc') }}</p>
                </header>
                <div class="form-grid two-cols">
                  <label class="field-span-2">
                    <input v-model="form.enableAfterWinCta" type="checkbox" class="checkbox-inline" />
                    <span>{{ $t('lottery.adminAfterWinCta') }}</span>
                    <small>{{ $t('lottery.adminAfterWinCtaHint') }}</small>
                  </label>
                  <template v-if="form.enableAfterWinCta">
                    <label class="field-span-2"><span>{{ $t('lottery.adminCtaUrl') }}</span><input v-model="form.afterWinCtaUrl" type="url" placeholder="https://..." /></label>
                    <label><span>{{ $t('lottery.adminCtaTitle') }}</span><input v-model="form.afterWinCtaTitle" maxlength="60" :placeholder="$t('lottery.adminAfterWinCtaTitlePlaceholder')" /></label>
                  </template>
                  <label class="field-span-2">
                    <input v-model="form.enableAfterLossCta" type="checkbox" class="checkbox-inline" />
                    <span>{{ $t('lottery.adminAfterLossCta') }}</span>
                    <small>{{ $t('lottery.adminAfterLossCtaHint') }}</small>
                  </label>
                  <template v-if="form.enableAfterLossCta">
                    <label class="field-span-2"><span>{{ $t('lottery.adminCtaUrl') }}</span><input v-model="form.afterLossCtaUrl" type="url" placeholder="https://..." /></label>
                    <label><span>{{ $t('lottery.adminCtaTitle') }}</span><input v-model="form.afterLossCtaTitle" maxlength="60" :placeholder="$t('lottery.adminAfterLossCtaTitlePlaceholder')" /></label>
                  </template>
                </div>
              </section>

              <!-- 未中奖自动发券：次要承接，默认不在主路径（仅抽奖） -->
              <section
                v-if="form.activityKind === 'lottery'"
                class="form-section form-section--nested"
                aria-labelledby="lottery-loserreward"
              >
                <header class="form-section-head">
                  <h4 id="lottery-loserreward" class="form-section-title">{{ $t('lottery.adminLoserRewardSection') }}</h4>
                  <p class="form-section-desc">{{ $t('lottery.adminLoserRewardDesc') }}</p>
                </header>
                <div class="form-grid two-cols">
                  <label class="field-span-2">
                    <span>{{ $t('lottery.adminLoserRewardLabel') }}</span>
                    <select v-model="loserRewardEnabled" @change="syncLoserReward">
                      <option :value="false">{{ $t('lottery.adminOff') }}</option>
                      <option :value="true">{{ $t('lottery.adminOn') }}</option>
                    </select>
                    <small class="field-hint">{{ $t('lottery.adminLoserRewardHint') }}</small>
                  </label>
                  <label v-if="loserRewardEnabled" class="field-span-2">
                    <span>{{ $t('lottery.adminCouponLabel') }}</span>
                    <input v-model="loserRewardCouponLabel" maxlength="50" :placeholder="$t('lottery.adminCouponLabelPlaceholder')" @change="syncLoserReward" />
                    <small class="field-hint">{{ $t('lottery.adminCouponLabelHint') }}</small>
                  </label>
                </div>
              </section>
            </div>
          </section>

          <section
            v-if="form.activityKind === 'survey' || form.activityKind === 'vote'"
            id="activity-config"
            class="form-section"
            aria-labelledby="activity-config-title"
          >
            <header class="form-section-head">
              <h4 id="activity-config-title" class="form-section-title">{{ $t('lottery.adminActivityConfigSection') }}</h4>
              <p class="form-section-desc">{{ $t('lottery.adminActivityConfigDesc') }}</p>
            </header>

            <div v-if="form.activityKind === 'survey'" class="activity-config-list">
              <div
                v-for="(field, index) in form.activityConfig.fields"
                :key="field.id"
                class="activity-config-row"
              >
                <div class="form-grid two-cols">
                  <label>
                    <span>{{ $t('lottery.adminFieldLabel') }}</span>
                    <input v-model="field.label" maxlength="80" :placeholder="$t('lottery.adminFieldLabelPlaceholder')" />
                  </label>
                  <label>
                    <span>{{ $t('lottery.adminFieldType') }}</span>
                    <select v-model="field.type" @change="normalizeSurveyFieldOptions(field)">
                      <option value="text">{{ $t('lottery.adminFieldTypeText') }}</option>
                      <option value="email">{{ $t('lottery.adminFieldTypeEmail') }}</option>
                      <option value="phone">{{ $t('lottery.adminFieldTypePhone') }}</option>
                      <option value="textarea">{{ $t('lottery.adminFieldTypeTextarea') }}</option>
                      <option value="select">{{ $t('lottery.adminFieldTypeSelect') }}</option>
                      <option value="radio">{{ $t('lottery.adminFieldTypeRadio') }}</option>
                      <option value="checkbox">{{ $t('lottery.adminFieldTypeCheckbox') }}</option>
                    </select>
                  </label>
                  <label>
                    <span>{{ $t('lottery.adminMaxLength') }}</span>
                    <input v-model.number="field.maxLength" type="number" min="1" max="2000" step="1" />
                  </label>
                  <label class="checkbox-label">
                    <input v-model="field.required" type="checkbox" />
                    <span>{{ $t('lottery.adminRequired') }}</span>
                  </label>
                </div>
                <div v-if="isChoiceSurveyField(field)" class="choice-options">
                  <label
                    v-for="option in field.options"
                    :key="option.id"
                    class="choice-option-row"
                  >
                    <span>{{ $t('lottery.adminOption') }}</span>
                    <input v-model="option.label" maxlength="80" :placeholder="$t('lottery.adminOptionName')" />
                    <button type="button" class="btn btn-ghost btn-xs" @click="removeSurveyOption(field, option.id)">{{ $t('lottery.adminDelete') }}</button>
                  </label>
                  <button type="button" class="btn btn-ghost btn-xs" @click="addSurveyOption(field)">{{ $t('lottery.adminAddOption') }}</button>
                </div>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="form.activityConfig.fields.length <= 1"
                  @click="removeSurveyField(Number(index))"
                >
                  {{ $t('lottery.adminRemoveField') }}
                </button>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" @click="addSurveyField">{{ $t('lottery.adminAddField') }}</button>
            </div>

            <div v-else class="activity-config-list">
              <div
                v-for="(option, index) in form.activityConfig.options"
                :key="option.id"
                class="activity-config-row"
              >
                <div class="form-grid two-cols">
                  <label>
                    <span>{{ $t('lottery.adminOptionName') }}</span>
                    <input v-model="option.label" maxlength="80" :placeholder="$t('lottery.adminVoteOptionPlaceholder')" />
                  </label>
                  <label>
                    <span>{{ $t('lottery.adminImageUrl') }}</span>
                    <input v-model="option.imageUrl" type="url" maxlength="2000" :placeholder="$t('lottery.adminImageUrlPlaceholder')" />
                  </label>
                  <label class="field-span-2">
                    <span>{{ $t('lottery.adminOptionDesc') }}</span>
                    <input v-model="option.description" maxlength="300" :placeholder="$t('lottery.adminOptionDescPlaceholder')" />
                  </label>
                </div>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  :disabled="form.activityConfig.options.length <= 2"
                  @click="removeVoteOption(Number(index))"
                >
                  {{ $t('lottery.adminRemoveOption') }}
                </button>
              </div>
              <button type="button" class="btn btn-ghost btn-sm" @click="addVoteOption">{{ $t('lottery.adminAddVoteOption') }}</button>
            </div>
          </section>

          <!--
            055a TTV：抽奖奖项从「基本信息」挪到步骤 4 专区，步骤条滚到 lottery-prizes 才对准。
            快速创建奖品 + 名额同屏，减少「第 4 步却滚回标题」的错位。
          -->
          <section id="lottery-prizes" class="form-section" aria-labelledby="lottery-prizes-title">
            <header class="form-section-head">
              <h4 id="lottery-prizes-title" class="form-section-title">
                {{ form.activityKind === 'lottery' ? $t('lottery.adminSectionPrizes') : $t('lottery.adminCreateStepQuota') }}
              </h4>
              <p class="form-section-desc">
                {{ form.activityKind === 'lottery' ? $t('lottery.adminSectionPrizesDesc') : $t('lottery.adminSectionQuotaDesc') }}
              </p>
            </header>
            <div class="form-grid two-cols">
              <div v-if="form.activityKind === 'lottery'" class="field-span-2">
                <span class="field-label-text">{{ $t('lottery.adminTierConfig') }}</span>
                <div class="tier-list">
                  <div v-for="(tier, idx) in form.tiers" :key="idx" class="tier-row">
                    <select v-model="tier.prizeId" class="tier-prize" :disabled="creating">
                      <option value="">{{ $t('lottery.adminSelectPrize') }}</option>
                      <option v-for="p in prizeOptions" :key="p.id" :value="p.id">{{ p.name }}</option>
                    </select>
                    <input v-model="tier.tierName" class="tier-name" :placeholder="$t('lottery.adminTierNamePlaceholder')" maxlength="50" />
                    <input v-model.number="tier.winnerCount" type="number" class="tier-count" min="1" max="1000" :placeholder="$t('lottery.adminTierSlotsPlaceholder')" />
                    <input
                      v-if="form.resultMode === 'instant'"
                      v-model.number="tier.weight"
                      type="number"
                      class="tier-count"
                      min="0"
                      max="100000"
                      :placeholder="$t('lottery.adminTierWeightPlaceholder')"
                      :title="$t('lottery.adminTierWeightHint')"
                    />
                    <button type="button" class="btn btn-ghost btn-xs" @click="removeTier(idx)">✕</button>
                  </div>
                  <div class="tier-actions">
                    <button type="button" class="btn btn-ghost btn-xs" :disabled="form.tiers.length >= 10" @click="addTier">
                      {{ $t('lottery.adminAddTier') }}
                    </button>
                    <!-- 始终提供快速创建：无奖品库时是主 CTA（手动履约，可过发布门禁）；有奖品时仍可一键加新奖 -->
                    <button
                      type="button"
                      class="btn btn-xs"
                      :class="prizeOptions.length === 0 ? 'btn-primary' : 'btn-ghost'"
                      :disabled="quickPrizeLoading"
                      @click="quickCreatePrize"
                    >
                      {{ quickPrizeLoading ? $t('lottery.adminCreating') : $t('lottery.adminQuickCreatePrize') }}
                    </button>
                    <button v-if="prizeOptions.length > 0" type="button" class="btn btn-ghost btn-xs" @click="goToPrizes">
                      {{ $t('lottery.adminManagePrizes') }}
                    </button>
                    <small class="field-hint">
                      {{ prizeOptions.length === 0 ? $t('lottery.adminEmptyPrizeHint') : $t('lottery.adminTierLimitHint') }}
                    </small>
                  </div>
                </div>
              </div>
              <label v-if="form.activityKind === 'lottery'">
                <span>{{ $t('lottery.winnerCount') }}</span>
                <input v-model.number="form.winnerCount" type="number" min="1" max="9999" step="1" required />
                <small class="field-hint">{{ $t('lottery.winnerCountHint') }}</small>
              </label>
              <label v-if="form.activityKind === 'lottery' && form.resultMode === 'instant'">
                <span>{{ $t('lottery.adminMaxSpinsPerEntry') }}</span>
                <input v-model.number="form.maxSpinsPerEntry" type="number" min="1" max="100" step="1" required />
                <small class="field-hint">{{ $t('lottery.adminMaxSpinsPerEntryHint') }}</small>
              </label>
              <label v-if="form.activityKind === 'lottery' && form.resultMode === 'instant'">
                <span>{{ $t('lottery.adminResultRule') }}</span>
                <input :value="resultModeLabel(form.resultMode)" disabled />
                <small class="field-hint">{{ $t('lottery.adminInstantResultHint') }}</small>
              </label>
              <label v-else-if="form.activityKind !== 'lottery'">
                <span>{{ $t('lottery.adminResultRule') }}</span>
                <input :value="resultModeLabel(form.resultMode)" disabled />
                <small class="field-hint">{{ $t('lottery.adminResultRuleHint') }}</small>
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
          <p v-if="!isEditing && createReadinessLabel" class="create-readiness" role="status">{{ createReadinessLabel }}</p>
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
            {{ creating ? $t('lottery.adminCreating') : (isEditing ? $t('lottery.adminDrawEdit') : $t('lottery.adminCreateDraft')) }}
          </button>
        </div>
      </form>
    </AdminModal>

    <!-- 模板选择弹窗 -->
    <AdminModal v-model="showTemplateModal" :title="$t('lottery.adminSelectTemplate')" max-width="720px">
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
              class="notice-card notice-card--danger"
              role="alert"
            >
              <div class="notice-card-body">
                <strong>{{ $t('lottery.adminEmailFailureSummary', { count: winnersEmailFailureCount }) }}</strong>
                <p class="notice-card-hint">{{ $t('lottery.adminEmailFailureHint') }}</p>
              </div>
              <button
                type="button"
                class="btn btn-primary btn-sm"
                :disabled="operatingId === winnersModalDrawId"
                @click="handleRetryEmail(winnersModalDrawId)"
              >{{ operatingId === winnersModalDrawId ? $t('lottery.loadingText') : $t('lottery.adminRetryEmail') }}</button>
            </div>
            <div
              v-else-if="winnersModalDrawId && winnersEmailPendingCount > 0"
              class="notice-card"
              role="status"
            >
              <strong>{{ $t('lottery.adminEmailPendingSummary', { count: winnersEmailPendingCount }) }}</strong>
              <span class="muted-text">{{ $t('lottery.adminEmailPendingHint') }}</span>
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
        <p class="field-hint winners-fulfill-hint">{{ $t('lottery.adminWinnersFulfillHint') }}</p>
        <div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>{{ $t('lottery.adminEmail') }}</th>
                <th>{{ $t('lottery.adminPrizeCol') }}</th>
                <th>{{ $t('lottery.adminFulfillmentCol') }}</th>
                <th>{{ $t('lottery.adminEmailStatus') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="w in winners" :key="w.id">
                <!-- identityDisplay：后端已把 user_id 身份（registered）解析为用户名(邮箱)；
                     email 身份等于 identityValue。兜底 identityValue 防止旧数据无字段 -->
                <td>{{ w.identityDisplay || w.identityValue || '-' }}</td>
                <td>
                  <div class="relation-cell">
                    <span>{{ w.prizeName || w.tierName || '-' }}</span>
                    <small v-if="w.tierName && w.prizeName && w.tierName !== w.prizeName" class="muted-text">{{ w.tierName }}</small>
                  </div>
                </td>
                <td>
                  <!-- 卡密：展示 code/secret；人工履约：说明；缺码：警示（docs/102） -->
                  <div v-if="w.cardAccountLabel || w.prizeCode" class="relation-cell">
                    <code
                      class="result-code mono-text"
                      :title="$t('lottery.clickToCopy')"
                      @click="copyWinnerCode(w)"
                    >{{ w.prizeCode || w.cardAccountLabel }}</code>
                    <small v-if="w.cardDeliverySecret && !String(w.prizeCode || '').includes(':')" class="muted-text">{{ w.cardDeliverySecret }}</small>
                  </div>
                  <div v-else-if="w.fulfillmentKind === 'manual' || isManualWinnerPrize(w)" class="relation-cell">
                    <span class="tag tag-info">{{ $t('lottery.adminFulfillManual') }}</span>
                    <small v-if="w.fulfillmentNote" class="muted-text">{{ w.fulfillmentNote }}</small>
                  </div>
                  <div v-else-if="w.fulfillmentKind === 'code_missing'" class="relation-cell">
                    <span class="tag tag-danger">{{ $t('lottery.adminFulfillCodeMissing') }}</span>
                    <small class="muted-text">{{ $t('lottery.adminFulfillCodeMissingHint') }}</small>
                  </div>
                  <span v-else class="muted-text">-</span>
                </td>
                <td>
                  <span class="tag" :class="emailStatusClass(w)" :title="winnerEmailErrorTitle(w)">
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

    <ConfirmDialog
      v-model="confirmVisible"
      :message="confirmMessage"
      :options="confirmOptionDefs"
      :option-values="confirmOptionValues"
      @confirm="onConfirm"
      @update:option="setConfirmOption"
    />

    <!--
      docs/079：行「更多」浮层（Teleport 到 body）。
      不放在 td 内：table-wrap overflow:auto 会裁切 absolute；行内展开会把行高拉爆。
    -->
    <Teleport to="body">
      <div
        v-if="expandedActionDraw"
        class="table-actions-more-backdrop"
        aria-hidden="true"
        @click="closeRowActions"
      />
      <div
        v-if="expandedActionDraw"
        ref="moreMenuEl"
        class="table-actions-more-menu"
        role="menu"
        :aria-label="$t('lottery.adminActionsMore')"
        :style="moreMenuStyle"
        @keydown.esc.prevent="closeRowActions"
      >
        <div class="table-actions-group" role="group">
          <span class="table-actions-group-label">{{ $t('lottery.adminActionsGroupShare') }}</span>
          <button
            type="button"
            class="btn btn-ghost btn-xs table-actions-menu-item"
            role="menuitem"
            :disabled="operatingId === expandedActionDraw.id"
            :title="$t('lottery.adminCopyLinkHint')"
            @click="runMoreAction(d => handleCopyShareLink(d))"
          >{{ $t('lottery.adminCopyLink') }}</button>
          <button
            type="button"
            class="btn btn-ghost btn-xs table-actions-menu-item"
            role="menuitem"
            :disabled="operatingId === expandedActionDraw.id"
            :title="$t('lottery.adminOpenPublicHint')"
            @click="runMoreAction(d => handleOpenPublic(d))"
          >{{ $t('lottery.adminOpenPublic') }}</button>
          <button
            type="button"
            class="btn btn-ghost btn-xs table-actions-menu-item"
            role="menuitem"
            :title="$t('lottery.adminGenerateQr')"
            @click="runMoreAction(d => handleShowQrCode(d))"
          >{{ $t('lottery.adminQrCode') }}</button>
          <button
            type="button"
            class="btn btn-ghost btn-xs table-actions-menu-item"
            role="menuitem"
            :title="$t('lottery.adminGeneratePoster')"
            @click="runMoreAction(d => handleShowPoster(d))"
          >{{ $t('lottery.adminPoster') }}</button>
        </div>
        <div class="table-actions-group" role="group">
          <span class="table-actions-group-label">{{ $t('lottery.adminActionsGroupOps') }}</span>
          <button
            type="button"
            class="btn btn-ghost btn-xs table-actions-menu-item"
            role="menuitem"
            :disabled="operatingId === expandedActionDraw.id"
            :title="$t('lottery.adminViewAnalytics')"
            @click="runMoreAction(d => handleViewAnalytics(d))"
          >{{ $t('lottery.adminAnalytics') }}</button>
          <button
            type="button"
            class="btn btn-ghost btn-xs table-actions-menu-item"
            role="menuitem"
            :disabled="operatingId === expandedActionDraw.id"
            :title="$t('lottery.adminDuplicateHint')"
            @click="runMoreAction(d => handleDuplicate(d))"
          >{{ $t('lottery.adminDuplicate') }}</button>
          <button
            v-if="expandedActionDraw.status === 'open' && expandedActionDraw.activityKind === 'lottery'"
            type="button"
            class="btn btn-ghost btn-xs table-actions-menu-item"
            role="menuitem"
            :disabled="operatingId === expandedActionDraw.id"
            @click="runMoreAction(d => handlePause(d.id))"
          >{{ operatingId === expandedActionDraw.id ? $t('lottery.loadingText') : $t('lottery.adminPause') }}</button>
          <button
            v-if="expandedActionDraw.status === 'drawn'"
            type="button"
            class="btn btn-ghost btn-xs table-actions-menu-item"
            role="menuitem"
            :disabled="operatingId === expandedActionDraw.id"
            @click="runMoreAction(d => handleToggleVisibility(d.id, d.visible))"
          >{{ isDrawUserVisible(expandedActionDraw) ? $t('lottery.adminHide') : $t('lottery.adminShow') }}</button>
          <button
            v-if="expandedActionDraw.status === 'drawn'"
            type="button"
            class="btn btn-ghost btn-xs table-actions-menu-item"
            role="menuitem"
            :disabled="operatingId === expandedActionDraw.id"
            @click="runMoreAction(d => handleRetryEmail(d.id))"
          >{{ operatingId === expandedActionDraw.id ? $t('lottery.loadingText') : $t('lottery.adminRetryEmail') }}</button>
        </div>
        <div class="table-actions-group table-actions-group--danger" role="group">
          <span class="table-actions-group-label">{{ $t('lottery.adminActionsGroupDanger') }}</span>
          <button
            v-if="expandedActionDraw.status === 'draft' || expandedActionDraw.status === 'open' || expandedActionDraw.status === 'paused'"
            type="button"
            class="btn btn-danger btn-xs table-actions-menu-item"
            role="menuitem"
            :disabled="operatingId === expandedActionDraw.id"
            @click="runMoreAction(d => handleCancel(d.id))"
          >{{ $t('lottery.adminDrawCancel') }}</button>
          <button
            v-if="canDeleteDraw(expandedActionDraw)"
            type="button"
            class="btn btn-danger btn-xs table-actions-menu-item"
            role="menuitem"
            :disabled="batchOperating"
            @click="runMoreAction(d => handleDelete(d.id))"
          >{{ $t('lottery.adminDrawDelete') }}</button>
        </div>
      </div>
    </Teleport>

    <!-- 活动数据：平台内漏斗 + 外部系统显式回传 -->
    <AdminModal v-model="showAnalyticsModal" :title="$t('lottery.adminAnalyticsTitle')" max-width="860px">
      <div class="analytics-modal-body">
        <div class="analytics-modal-head">
          <div>
            <h3>{{ analyticsDraw?.title || '-' }}</h3>
            <p>{{ $t('lottery.adminAnalyticsHint') }}</p>
          </div>
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            :disabled="analyticsLoading || !analyticsDraw"
            @click="analyticsDraw && handleViewAnalytics(analyticsDraw)"
          >{{ $t('lottery.adminRefresh') }}</button>
        </div>

        <div v-if="analyticsLoading" class="empty-text">{{ $t('lottery.loadingText') }}</div>
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
            <h4>{{ $t('lottery.adminKeyRates') }}</h4>
            <div class="analytics-rates">
              <div>
                <span>{{ completionRate }}</span>
                <small>{{ $t('lottery.adminRateCompletionView') }}</small>
              </div>
              <div>
                <span>{{ ctaRate }}</span>
                <small>{{ $t('lottery.adminRateCtaCompletion') }}</small>
              </div>
              <div>
                <span>{{ externalConversionRate }}</span>
                <small>{{ $t('lottery.adminRateExternalCta') }}</small>
              </div>
            </div>
          </div>

          <div class="analytics-section">
            <div class="analytics-section-head">
              <h4>{{ $t('lottery.adminConversionTypes') }}</h4>
              <span class="muted-text">{{ $t('lottery.adminConversionTypesHint') }}</span>
            </div>
            <div v-if="conversionTypeRows.length > 0" class="analytics-type-list">
              <div v-for="row in conversionTypeRows" :key="row.type">
                <span>{{ conversionTypeLabel(row.type) }}</span>
                <strong>{{ row.count }}</strong>
                <small v-if="row.amountCents > 0">{{ $t('lottery.adminCentsAmount', { amount: row.amountCents }) }}</small>
              </div>
            </div>
            <p v-else class="empty-text">{{ $t('lottery.adminNoConversions') }}</p>
          </div>

          <div class="analytics-section">
            <div class="analytics-section-head">
              <h4>{{ $t('lottery.adminRecentConversions') }}</h4>
              <button
                class="btn btn-ghost btn-xs"
                type="button"
                :disabled="analyticsConversions.length === 0"
                @click="handleExportConversions"
              >{{ $t('lottery.adminExportWinners') }}</button>
            </div>
            <div class="table-wrap analytics-table-wrap">
              <table class="admin-table">
                <thead>
                  <tr>
                    <th>{{ $t('lottery.adminConvType') }}</th>
                    <th>{{ $t('lottery.adminConvSource') }}</th>
                    <th>{{ $t('lottery.adminConvEvent') }}</th>
                    <th>{{ $t('lottery.adminConvIdentity') }}</th>
                    <th>{{ $t('lottery.adminConvAmount') }}</th>
                    <th>{{ $t('lottery.adminConvOccurredAt') }}</th>
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
                    <td colspan="6" class="empty-text">{{ $t('lottery.adminNoConversionRecords') }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </template>
      </div>
    </AdminModal>

    <!-- 二维码弹窗 -->
    <AdminModal v-model="showQrModal" :title="$t('lottery.adminQrTitle')" max-width="400px">
      <div class="qr-modal-body">
        <img :src="qrImageUrl" :alt="$t('lottery.adminQrTitle')" class="qr-image" />
        <p class="qr-hint">{{ $t('lottery.adminQrHint') }}</p>
        <div class="qr-actions">
          <button class="btn btn-primary btn-sm" @click="handleDownloadQr">{{ $t('lottery.adminDownloadQr') }}</button>
          <button class="btn btn-ghost btn-sm" @click="handleCopyQrLink">{{ $t('lottery.adminCopyQrLink') }}</button>
        </div>
      </div>
    </AdminModal>

    <!-- 海报弹窗 -->
    <AdminModal v-model="showPosterModal" :title="$t('lottery.adminPosterTitle')" max-width="500px">
      <div class="poster-modal-body">
        <!-- 海报预览：显示已生成的 PNG（或加载中） -->
        <div class="poster-preview-wrap">
          <img v-if="posterDataUrl" :src="posterDataUrl" :alt="$t('lottery.adminPosterTitle')" class="poster-preview" />
          <div v-else class="poster-loading">{{ posterGenerating ? $t('lottery.adminGenerating') : $t('lottery.loadingText') }}</div>
        </div>
        <div class="poster-actions">
          <button class="btn btn-primary btn-sm" :disabled="posterGenerating || !posterDataUrl" @click="handleDownloadPoster">
            {{ $t('lottery.adminDownloadPoster') }}
          </button>
          <button class="btn btn-ghost btn-sm" @click="showPosterModal = false">{{ $t('lottery.adminClose') }}</button>
        </div>
      </div>
    </AdminModal>

    <!-- 海报模板（隐藏 DOM，html-to-image 截图用） -->
    <div v-if="showPosterModal" ref="posterDomRef" class="poster-template" aria-hidden="true">
      <div class="poster-template-bg">
        <div class="poster-template-orb poster-template-orb-1"></div>
        <div class="poster-template-orb poster-template-orb-2"></div>
        <div class="poster-template-orb poster-template-orb-3"></div>
      </div>
      <div class="poster-template-content">
        <div class="poster-brand">{{ posterPlatformName }}</div>
        <div class="poster-kind">{{ posterKindLabel }}</div>
        <h2 class="poster-title">{{ (posterDrawData?.title || $t('lottery.adminActivity')).slice(0, 18) }}</h2>

        <div class="poster-prizes" v-if="posterPrizeList.length > 0">
          <div v-for="(p, i) in posterPrizeList.slice(0, 3)" :key="i" class="poster-prize-row">
            <span class="poster-prize-medal">{{ ['🏆','🥈','🥉'][i] || '🎁' }}</span>
            <span class="poster-prize-name">{{ p }}</span>
          </div>
        </div>
        <div v-else class="poster-prizes-empty">{{ $t('lottery.adminPosterSurprise') }}</div>

        <div class="poster-time" v-if="posterTimeText">{{ posterTimeText }}</div>

        <div class="poster-qr-wrap">
          <img v-if="posterQrImageUrl" :src="posterQrImageUrl" :alt="$t('lottery.adminQrTitle')" class="poster-qr" />
          <div class="poster-qr-hint">{{ $t('lottery.adminPosterScanHint') }}<br />{{ $t('lottery.join') }}</div>
        </div>

        <div class="poster-footer">{{ $t('lottery.adminPosterFooter') }}</div>
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
import { useToast } from '@usethink/cf-admin-fe/composables'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useConfirmDialog } from '@usethink/cf-admin-fe/composables'
import { useTableSelection } from '@usethink/cf-admin-fe/composables'
import { useAdminBatchOperation } from '@usethink/cf-admin-fe/composables'
import { formatDate, dateTimeLocalToIso, toDateTimeLocalValue, toErrorMessage, resolveBatchToastType } from '@/composables/useFormat'
import { copyWithToast, writeClipboardText } from '@usethink/cf-admin-fe/composables'
import {
  canEnableDrawNow,
  draftPublishBlockerSnippet,
  OPEN_PUBLIC_PREVIEW_OPTION_KEY,
  shouldOpenPublicPreview,
} from '@/composables/admin-list-ux'
import AdminModal from '@usethink/cf-admin-fe/components/AdminModal.vue'
import AdminPagination from '@usethink/cf-admin-fe/components/AdminPagination.vue'
import { useTablePagination } from '@usethink/cf-admin-fe/composables'
import { useAdminListLoader } from '@usethink/cf-admin-fe/composables'
import ConfirmDialog from '@usethink/cf-admin-fe/components/ConfirmDialog.vue'
import { adminRequest } from '@/composables/useAdminRequest'
import {
  defaultExperienceForActivity,
  defaultResultModeForActivity,
} from '@/lib/activity-defaults'
import type {
  ActivityConfigForm,
  ExternalConversion,
  LotteryDraw,
  LotteryWinner,
  PublishCheckItem,
  SurveyFieldForm,
} from './lottery/types'
import {
  cancelLotteryDraw,
  createLotteryDraw,
  deleteLotteryDraw,
  batchDeleteLotteryDraws,
  fetchLotteryDraws,
  fetchLotteryWinners,
  fetchPublishCheck,
  openLotteryDraw,
  pauseLotteryDraw,
  performLotteryDraw,
  recoverLotteryDraw,
  resumeLotteryDraw,
  retryAdminLotteryEmail,
  updateLotteryDraw,
} from './lottery/api'
import {
  defaultActivityConfigForKind,
  isChoiceSurveyField,
  makeStableId,
  normalizeActivityConfig as normalizeActivityConfigRaw,
  normalizeSurveyFieldOptions as normalizeSurveyFieldOptionsRaw,
} from './lottery/activity-config'
import { emptyLotteryEditorForm } from './lottery/form-defaults'
import { buildFlashSaleDirectChecklist } from './lottery/flash-sale-readiness'
import { buildPromotionConfigPayload, growthFieldsFromDraw, sanitizeRitualPhrasesForSave } from './lottery/growth-config'
import {
  buildLotteryDrawConfirmMessage,
  buildLotteryDuplicateDraft as buildLotteryDuplicateDraftRaw,
  buildLotteryWinnersCsvRows,
  buildSelectedDrawsCsvRows,
  canBatchHideDraw as canBatchHideDrawByFields,
  canDeleteDraw as canDeleteDrawByStatus,
  shouldShowAdminDrawNowButton,
  shouldShowAdminInstantResultTag,
  canGuidePublishFixInEditor as canGuidePublishFixInEditorRaw,
  canCancelDraw as canCancelDrawByStatus,
  canPauseDraw as canPauseDrawByStatus,
  canResumeDraw as canResumeDrawByStatus,
  canSelectDrawForBulk,
  conversionAmount as conversionAmountRaw,
  conversionIdentity,
  countLotteryEmailFailures,
  countLotteryEmailPending,
  drawDisplayName,
  drawDoneFeedbackKind,
  downloadCsv,
  emailStatusClass,
  hasActiveDrawListFilter,
  isLotteryUserVisible,
  isWinnerEmailFailed,
  isWinnerEmailSent,
  winnersPollSettleKind,
  formatLotteryEntryProgress,
  formatLotteryVisibilityLabel,
  formatPublishCheckItems as formatPublishCheckItemsRaw,
  publishFixSectionTargetId,
  resolveLotteryScheduleFields,
  statusClass,
} from './lottery/ops-utils'
import { usePosterQr } from './lottery/usePosterQr'
import { useDrawAnalytics } from './lottery/useDrawAnalytics'


const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const { showToast } = useToast()
useAdminAuth()
const {
  confirmVisible,
  confirmMessage,
  confirmOptionDefs,
  confirmOptionValues,
  askConfirm,
  askConfirmWithOptions,
  onConfirm,
  setConfirmOption,
} = useConfirmDialog()

/**
 * 发布门禁失败后的行内提示（drawId → 首条 error 文案）。
 * 为何不列表预拉 publish-check：N+1 请求贵；失败后再钉在行上，运营一眼知道「还差什么」。
 */
const draftPublishBlockers = ref<Record<string, string>>({})

/**
 * 开奖/查看结果后缓存的邮件失败数（drawId → count）。
 * 列表 API 不含 per-draw 通知失败数；缓存后 drawn 行「查看结果」可升主按钮，形成「开奖→邮件失败→重发」闭环。
 */
const drawEmailFailHints = ref<Record<string, number>>({})

function rememberDrawEmailFails(drawId: string, winnersList: LotteryWinner[]) {
  const n = countLotteryEmailFailures(winnersList)
  if (n <= 0) {
    if (!(drawId in drawEmailFailHints.value)) return
    const next = { ...drawEmailFailHints.value }
    delete next[drawId]
    drawEmailFailHints.value = next
    return
  }
  drawEmailFailHints.value = { ...drawEmailFailHints.value, [drawId]: n }
}

function drawnRowResultBtnClass(drawId: string): string {
  return (drawEmailFailHints.value[drawId] || 0) > 0 ? 'btn-primary' : 'btn-ghost'
}

function drawnRowResultTitle(drawId: string): string {
  const n = drawEmailFailHints.value[drawId] || 0
  return n > 0 ? t('lottery.adminEmailFailureSummary', { count: n }) : t('lottery.checkResult')
}

function setDraftPublishBlocker(drawId: string, firstMessage: string | undefined) {
  const snip = draftPublishBlockerSnippet(firstMessage)
  if (!snip) {
    const next = { ...draftPublishBlockers.value }
    delete next[drawId]
    draftPublishBlockers.value = next
    return
  }
  draftPublishBlockers.value = { ...draftPublishBlockers.value, [drawId]: snip }
}

function clearDraftPublishBlocker(drawId: string) {
  if (!(drawId in draftPublishBlockers.value)) return
  const next = { ...draftPublishBlockers.value }
  delete next[drawId]
  draftPublishBlockers.value = next
}

/** 开启/创建成功后：默认勾选「打开用户页」，确认即预览（仍保留用户手势，避免 window.open 被拦） */
async function askOpenPublicPreview(message: string): Promise<boolean> {
  const result = await askConfirmWithOptions(message, {
    options: [
      {
        key: OPEN_PUBLIC_PREVIEW_OPTION_KEY,
        label: t('lottery.adminOpenPublic'),
        hint: t('lottery.adminOpenPublicHint'),
        defaultChecked: true,
      },
    ],
  })
  return shouldOpenPublicPreview(result.confirmed, result.options)
}

// ── 从 lottery/* 抽出的纯逻辑：此处只保留需要 t / form 的薄包装 ──
function normalizeActivityConfig(kind: string, config: any): ActivityConfigForm {
  return normalizeActivityConfigRaw(kind, config, t)
}
function normalizeSurveyFieldOptions(field: SurveyFieldForm) {
  normalizeSurveyFieldOptionsRaw(field, t)
}
function buildLotteryDuplicateDraft(draw: any, opts: { nameSuffix: string; defaultName: string }) {
  return buildLotteryDuplicateDraftRaw(draw, opts, t)
}
function conversionAmount(item: ExternalConversion): string {
  return conversionAmountRaw(item, (amount) => t('lottery.adminCentsAmount', { amount }))
}
function formatPublishCheckItems(items: PublishCheckItem[], prefix: string): string {
  const more = items.length > 3 ? t('lottery.adminMoreCheckItems', { count: items.length - 3 }) : ''
  return formatPublishCheckItemsRaw(items, prefix, more)
}
function canGuidePublishFixInEditor(draw: LotteryDraw, errors: PublishCheckItem[]): boolean {
  return canGuidePublishFixInEditorRaw(draw.status, errors)
}

const draws = ref<LotteryDraw[]>([])
/** docs/083 P1：默认「进行中」虚拟筛（draft/open/paused/drawing），深链 ?status= 可覆盖 */
const statusFilter = ref('active')
/** 名称 / 奖品 / id 本地模糊搜索 */
const listQuery = ref('')
/** 活动类型筛选（047 文档 🔴） */
const activityKindFilter = ref('')
/** 创建时间范围筛选（047 文档 🟡）：ISO 日期（date input 值） */
const createdFromFilter = ref('')
const createdToFilter = ref('')
const { loading, loadError, runLoad } = useAdminListLoader()
const showCreateModal = ref(false)
/** 055a：创建表单「高级配置（导流/裂变/CTA）」默认收起，减少主路径压迫 */
const showAdvancedGrowth = ref(false)
/** docs/079：列表行「更多」浮层 — 同时只开一行；菜单 Teleport 到 body，不撑行高 */
const expandedActionId = ref<string | null>(null)
const moreMenuPos = ref({ top: 0, left: 0, width: 200 })
const moreBtnRefs = new Map<string, HTMLElement>()
const moreMenuEl = ref<HTMLElement | null>(null)

const expandedActionDraw = computed(() => {
  const id = expandedActionId.value
  if (!id) return null
  return draws.value.find((d) => d.id === id) || null
})

const moreMenuStyle = computed(() => ({
  top: `${moreMenuPos.value.top}px`,
  left: `${moreMenuPos.value.left}px`,
  minWidth: `${moreMenuPos.value.width}px`,
}))

function setMoreBtnRef(drawId: string, el: unknown) {
  if (el && el instanceof HTMLElement) moreBtnRefs.set(drawId, el)
  else moreBtnRefs.delete(drawId)
}

function closeRowActions() {
  expandedActionId.value = null
}

function positionMoreMenu(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect()
  const menuWidth = 220
  const gap = 4
  // 优先右对齐按钮；视口不够则贴右缘
  let left = rect.right - menuWidth
  if (left < 8) left = 8
  if (left + menuWidth > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - menuWidth - 8)
  }
  // 先放按钮下方；空间不足再翻到上方（用估算高度，下一帧再精修）
  let top = rect.bottom + gap
  const estHeight = 280
  if (top + estHeight > window.innerHeight - 8 && rect.top > estHeight) {
    top = Math.max(8, rect.top - estHeight - gap)
  }
  moreMenuPos.value = { top, left, width: menuWidth }
}

function refineMoreMenuPosition(anchor: HTMLElement) {
  const menu = moreMenuEl.value
  if (!menu) return
  const rect = anchor.getBoundingClientRect()
  const menuRect = menu.getBoundingClientRect()
  const gap = 4
  let top = rect.bottom + gap
  if (top + menuRect.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - menuRect.height - gap)
  }
  let left = moreMenuPos.value.left
  if (left + menuRect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - menuRect.width - 8)
  }
  moreMenuPos.value = { top, left, width: moreMenuPos.value.width }
}

/** 点菜单项：先关浮层再执行（避免 confirm/modal 叠层） */
function runMoreAction(action: (draw: LotteryDraw) => void | Promise<void>) {
  const draw = expandedActionDraw.value
  closeRowActions()
  if (draw) void action(draw)
}
/** 055a P1：当前创建来自哪个模板（仅提示用，不参与提交） */
const activeTemplateId = ref('')
const activeTemplateName = ref('')
const showTemplateModal = ref(false)
const templates = ref<any[]>([])
// 启用的活动类型列表（从系统配置 enabled_activity_kinds 获取，由 L3 平台运营者配置）
const enabledKinds = ref<string[]>([])
const enabledParticipationModes = ref<string[]>([])

// 活动类型显示名称映射（与系统配置 enabled_activity_kinds 联动）
const activityKindLabels: Record<string, string> = {
  lottery: t('lottery.adminKindLottery'),
  signup_chain: t('lottery.adminKindSignupChain'),
  claim: t('lottery.adminKindClaim'),
  survey: t('lottery.adminKindSurvey'),
  vote: t('lottery.adminKindVote'),
  checkin: t('lottery.adminKindCheckin'),
  reservation: t('lottery.adminKindReservation'),
  approval: t('lottery.adminKindApproval'),
  waitlist: t('lottery.adminKindWaitlist'),
}

// 根据 enabledKinds 过滤可创建的活动类型；未加载时显示全部（降级）
const activityKindOptions = computed(() => {
  const kinds = enabledKinds.value.length > 0 ? enabledKinds.value : Object.keys(activityKindLabels)
  return kinds.filter(k => activityKindLabels[k]).map(k => ({ value: k, label: activityKindLabels[k] }))
})

// 参与模式显示名称映射（与系统配置 enabled_participation_modes 联动）
const participationModeLabels: Record<string, string> = {
  open: t('lottery.adminModeOpen'),
  registered: t('lottery.adminModeRegistered'),
  roster: t('lottery.adminModeRoster'),
  password: t('lottery.adminModePassword'),
  invite_code: t('lottery.adminModeInviteCode'),
}
const participationModeOptions = computed(() => {
  const modes = enabledParticipationModes.value.length > 0 ? enabledParticipationModes.value : Object.keys(participationModeLabels)
  return modes.filter(m => participationModeLabels[m]).map(m => ({ value: m, label: participationModeLabels[m] }))
})
const showWinnersModal = ref(false)
const {
  showQrModal,
  qrImageUrl,
  qrDrawUrl,
  showPosterModal,
  posterGenerating,
  posterDomRef,
  posterDataUrl,
  posterQrImageUrl,
  posterDrawData,
  posterPlatformName,
  posterKindLabel,
  posterPrizeList,
  posterTimeText,
  prefetchPublicUrl,
  handleShowQrCode,
  handleDownloadQr,
  handleCopyQrLink,
  handleShowPoster,
  handleDownloadPoster,
} = usePosterQr()
void posterDomRef
void qrDrawUrl

const winners = ref<LotteryWinner[]>([])
const winnersLoading = ref(false)
/** 中奖弹窗对应的活动 id，便于弹窗内一键重发失败邮件 */
const winnersModalDrawId = ref('')
const creating = ref(false)
const operatingId = ref('')
const {
  showAnalyticsModal,
  analyticsLoading,
  analyticsError,
  analyticsDraw,
  analyticsStats,
  analyticsConversions,
  analyticsFunnelCards,
  conversionTypeRows,
  completionRate,
  ctaRate,
  externalConversionRate,
  conversionTypeLabel,
  handleViewAnalytics,
  handleExportConversions,
} = useDrawAnalytics({ operatingId })

// 模板绑定的 composable 字段：避免 vue-tsc 在部分配置下误报 TS6133
void analyticsStats

// docs/082 P0：统一批量进度；batchOperating 须在 useTableSelection 前可用
const {
  operating: batchOperating,
  completed: batchCompleted,
  total: batchTotal,
  runSequential: runBatchSequential,
} = useAdminBatchOperation()
const pagination = useTablePagination({ initialLimit: 50 })
let winnersStatusTimer: ReturnType<typeof setInterval> | null = null
let winnersStatusRefreshes = 0
let winnersStatusInFlight = false
const MAX_WINNERS_STATUS_REFRESHES = 10

const filteredDraws = computed(() => draws.value)

/** 默认 status=active 不算「有筛选」，空库走创建引导而非「无匹配」 */
const hasListFilter = computed(() =>
  hasActiveDrawListFilter({
    statusFilter: statusFilter.value,
    listQuery: listQuery.value,
    activityKindFilter: activityKindFilter.value,
    createdFromFilter: createdFromFilter.value,
    createdToFilter: createdToFilter.value,
  }),
)

function canSelectDraw(draw: LotteryDraw): boolean {
  return canSelectDrawForBulk(draw.status, draw.visible)
}

function canBatchHideDraw(draw: LotteryDraw): boolean {
  return canBatchHideDrawByFields(draw.status, draw.visible)
}

function canPauseDraw(draw: LotteryDraw): boolean {
  return canPauseDrawByStatus(draw.status)
}

function canResumeDraw(draw: LotteryDraw): boolean {
  return canResumeDrawByStatus(draw.status)
}

function canCancelDraw(draw: LotteryDraw): boolean {
  return canCancelDrawByStatus(draw.status)
}

function isDrawUserVisible(draw: LotteryDraw): boolean {
  return isLotteryUserVisible(draw.visible)
}

// 多选：可删 / 隐藏 drawn / 暂停 open / 恢复 paused；Shift 连选由 setSelected 第三参（click）处理
const visibleItems = computed(() => filteredDraws.value)
const {
  selectedIds,
  selectedCount,
  isSelected,
  setSelected,
  toggleAllVisible,
  clearSelection,
  allVisibleSelected,
  partiallySelected,
} = useTableSelection(visibleItems, (row) => row.id, {
  isSelectable: canSelectDraw,
})

const selectedDeletableCount = computed(
  () => draws.value.filter((d) => selectedIds.value.includes(d.id) && canDeleteDraw(d)).length,
)
const selectedHideableCount = computed(
  () => draws.value.filter((d) => selectedIds.value.includes(d.id) && canBatchHideDraw(d)).length,
)
const selectedPausableCount = computed(
  () => draws.value.filter((d) => selectedIds.value.includes(d.id) && canPauseDraw(d)).length,
)
const selectedResumableCount = computed(
  () => draws.value.filter((d) => selectedIds.value.includes(d.id) && canResumeDraw(d)).length,
)
const selectedCancellableCount = computed(
  () => draws.value.filter((d) => selectedIds.value.includes(d.id) && canCancelDraw(d)).length,
)

const winnersEmailFailureCount = computed(() => countLotteryEmailFailures(winners.value))
// 与后端 notificationStatus 对齐；旧逻辑把 failed 误算进 pending，重发条会不出现
const winnersEmailPendingCount = computed(() => countLotteryEmailPending(winners.value))
const emptyForm = () => emptyLotteryEditorForm(t)

const form = ref(emptyForm())
const isEditing = ref(false)
const flashSalePriceYuan = computed({
  get: () => {
    const v = form.value.flashSalePriceCents
    return v != null && v > 0 ? (v / 100).toFixed(2) : ''
  },
  set: (val: string) => {
    const n = parseFloat(val)
    form.value.flashSalePriceCents = isNaN(n) || n <= 0 ? null : Math.max(1, Math.round(n * 100))
  },
})
const rosterInput = ref('')
const inviteCodeCount = ref(10)
/** 奖品库（用于奖项配置下拉选择） */
const prizeOptions = ref<any[]>([])

const flashSaleDirectChecklist = computed(() => {
  return buildFlashSaleDirectChecklist({
    enableFlashSale: form.value.enableFlashSale,
    flashSalePaymentRequired: form.value.flashSalePaymentRequired,
    flashSalePriceCents: form.value.flashSalePriceCents,
    flashSaleStockLimit: form.value.flashSaleStockLimit,
    flashSaleTitle: form.value.flashSaleTitle,
    maxParticipants: form.value.maxParticipants,
    productLink: form.value.productLink,
    tiers: form.value.tiers,
    prizeOptions: prizeOptions.value,
  })
})

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

/**
 * 保存活动的奖项配置（创建 + 编辑共用）。
 * 抽奖活动必须配置奖项才能通过发布门禁，编辑时遗漏保存会导致「已更新但无奖项」。
 */
async function saveDrawTiers(drawId: string) {
  const isInstant = form.value.resultMode === 'instant'
  const validTiers = form.value.tiers
    .filter((tier) => tier.prizeId)
    .map((tier, i) => ({
      prizeId: tier.prizeId,
      tierName: tier.tierName || t('lottery.adminTierName', { n: i + 1 }),
      winnerCount: Math.max(1, Number(tier.winnerCount) || 1),
      // instant：未填 weight 默认 1，避免发布预检权重和=0
      ...(isInstant
        ? { weight: Math.max(0, Math.floor(Number(tier.weight) || 1)) }
        : {}),
    }))
  if (validTiers.length === 0) return
  try {
    await adminRequest(`/api/admin/draws/${drawId}/tiers`, {
      method: 'POST',
      body: JSON.stringify({ tiers: validTiers }),
    })
  } catch {
    showToast(t('lottery.adminFailed'), 'error')
  }
}

/**
 * 保存活动的名单（创建 + 编辑共用）。
 * 仅 roster 模式且用户填了名单时执行。
 */
async function saveDrawRoster(drawId: string) {
  if (form.value.participationMode !== 'roster' || !rosterInput.value.trim()) return
  const emails = rosterInput.value
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(email => ({ email }))
  if (emails.length === 0) return
  try {
    await adminRequest(`/api/admin/draws/${drawId}/roster`, {
      method: 'POST',
      body: JSON.stringify({ members: emails }),
    })
  } catch { /* 导入失败不阻断主流程 */ }
}

/**
 * 生成邀请码（创建 + 编辑共用）。
 * 仅 invite_code 模式且设置了数量时执行。
 */
async function saveDrawInviteCodes(drawId: string) {
  if (form.value.participationMode !== 'invite_code' || inviteCodeCount.value <= 0) return
  try {
    await adminRequest(`/api/admin/draws/${drawId}/invite-codes`, {
      method: 'POST',
      body: JSON.stringify({ count: inviteCodeCount.value, maxUses: 1 }),
    })
  } catch { /* 生成失败不阻断主流程 */ }
}

/** 添加一个奖项（最多 10 个） */
function addTier() {
  if (form.value.tiers.length >= 10) return
  form.value.tiers.push({
    prizeId: '',
    tierName: t('lottery.adminTierName', { n: form.value.tiers.length + 1 }),
    winnerCount: 1,
    weight: form.value.resultMode === 'instant' ? 1 : 0,
  })
}

/** 移除一个奖项 */
function removeTier(idx: number) {
  form.value.tiers.splice(idx, 1)
}

function goToPrizes() {
  void router.push('/admin/prizes')
}

const quickPrizeLoading = ref(false)

/**
 * 在活动表单内一键创建默认奖品，消除跳奖品页的流程断裂（055a P1 TTV）。
 *
 * 默认 prizeType=manual_fulfillment：无需码池即可过 publish-check（非 code 类型不校验库存）。
 * 适合「选模板 → 快速奖 → 发布试跑」；若需卡密，运营者仍可去奖品页改类型并导入码。
 */
async function quickCreatePrize() {
  quickPrizeLoading.value = true
  try {
    const prizeName = t('lottery.adminQuickPrizeName', { name: form.value.name || t('lottery.adminLotteryActivity') })
    const slots = Math.max(1, Number(form.value.winnerCount) || 1)
    const prizeData = await adminRequest<{ id: string }>('/api/admin/prizes', {
      method: 'POST',
      body: JSON.stringify({
        name: prizeName,
        // 手动履约：空库也能一次过发布门禁；不自动造 10 个码（避免脏码 + 假「已备货」感）
        prizeType: 'manual_fulfillment',
        valueText: t('lottery.adminQuickPrizeValueHint'),
      }),
    })
    await loadPrizeOptions()
    // 无奖项则补一行；有空奖项则挂上新奖品——避免「有奖无奖项」仍过不了发布门禁
    if (form.value.tiers.length === 0) {
      form.value.tiers = [{
        prizeId: prizeData.id,
        tierName: t('lottery.adminTierName', { n: 1 }),
        winnerCount: slots,
      }]
    } else if (!form.value.tiers[0]!.prizeId) {
      form.value.tiers[0]!.prizeId = prizeData.id
      if (!form.value.tiers[0]!.winnerCount) {
        form.value.tiers[0]!.winnerCount = slots
      }
    }
    // 活动中奖人数与第一奖项对齐，减少 publish-check winner_count.mismatch 警告
    if (form.value.activityKind === 'lottery') {
      const tierTotal = form.value.tiers.reduce((sum, tier) => sum + Math.max(0, Number(tier.winnerCount) || 0), 0)
      if (tierTotal > 0) form.value.winnerCount = tierTotal
    }
    showToast(t('lottery.adminPrizeCreatedManual', { name: prizeName }), 'success')
  } catch (err) {
    showToast(toErrorMessage(err, t('lottery.adminQuickPrizeFailed')), 'error')
  } finally {
    quickPrizeLoading.value = false
  }
}

/**
 * 055a P1：创建路径就绪提示（客户端预检，不替代服务端 publish-check）。
 * 只提示「保存草稿前还缺什么」，降低「创建成功却开不了」的落差。
 */
const createPathHint = computed(() => {
  if (isEditing.value) return ''
  if (activeTemplateId.value) {
    const name = activeTemplateName.value || activeTemplateId.value
    return t('lottery.adminCreatePathFromTemplate', { name })
  }
  return t('lottery.adminCreatePathBlank')
})

/** 当前高亮步骤（点击步骤条时更新；不强制线性 Wizard） */
const createStepFocus = ref(1)

/**
 * 各步完成态：驱动步骤条 ✓，与 createReadiness 同源规则。
 * 第 4 步：抽奖看奖项；非抽奖有时间即可（名额可选）。
 */
const createStepDone = computed(() => {
  const nameOk = Boolean(String(form.value.name || '').trim())
  const timeFilled = Boolean(form.value.startTime && form.value.endTime && form.value.drawTime)
  const timeOk = timeFilled && !timeOrderError.value
  let joinOk = true
  if (form.value.participationMode === 'password') {
    joinOk = Boolean(String(form.value.accessPassword || '').trim())
  } else if (form.value.participationMode === 'roster') {
    joinOk = Boolean(rosterInput.value.trim())
  } else if (form.value.participationMode === 'invite_code') {
    joinOk = Number(inviteCodeCount.value) > 0
  }
  let prizesOk = true
  if (form.value.activityKind === 'lottery') {
    prizesOk = form.value.tiers.some((tier) => Boolean(tier.prizeId))
  } else {
    prizesOk = timeOk // 非抽奖：名额可选，时间齐即视为第 4 步可过
  }
  return { basic: nameOk, time: timeOk, join: joinOk, prizes: prizesOk }
})

const createReadinessLabel = computed(() => {
  if (isEditing.value) return ''
  const missing: string[] = []
  if (!createStepDone.value.basic) missing.push(t('lottery.adminCreateNeedName'))
  if (!form.value.startTime || !form.value.endTime || !form.value.drawTime) {
    missing.push(t('lottery.adminCreateNeedTime'))
  } else if (timeOrderError.value) {
    missing.push(t('lottery.adminCreateNeedTimeOrder'))
  }
  if (form.value.activityKind === 'lottery' && !createStepDone.value.prizes) {
    missing.push(t('lottery.adminCreateNeedPrize'))
  }
  if (form.value.participationMode === 'password' && !String(form.value.accessPassword || '').trim()) {
    missing.push(t('lottery.adminCreateNeedPassword'))
  }
  if (form.value.participationMode === 'roster' && !rosterInput.value.trim()) {
    missing.push(t('lottery.adminCreateNeedRoster'))
  }
  if (missing.length === 0) return t('lottery.adminCreateReadyHint')
  return t('lottery.adminCreateMissingHint', { items: missing.join(' · ') })
})

/** 步骤条：滚到对应分区（编辑器内部滚动容器） */
function scrollEditorSection(sectionId: string) {
  const el = document.getElementById(sectionId)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/** 点击步骤条：高亮 + 滚到分区 */
function focusCreateStep(step: number) {
  createStepFocus.value = step
  const map: Record<number, string> = {
    1: 'lottery-basic',
    2: 'lottery-time',
    3: 'lottery-mode',
    4: 'lottery-prizes',
  }
  const id = map[step]
  if (id) scrollEditorSection(id)
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

function addSurveyField() {
  const config = normalizeActivityConfig('survey', form.value.activityConfig) as Extract<ActivityConfigForm, { kind: 'survey' }>
  config.fields.push({
    id: makeStableId('field'),
    label: t('lottery.adminNewField'),
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
  field.options.push({ id: makeStableId('opt'), label: t('lottery.adminOptionNumber', { n: field.options.length + 1 }) })
}

function removeSurveyOption(field: SurveyFieldForm, optionId: string) {
  if (field.options.length <= 1) return
  field.options = field.options.filter((option) => option.id !== optionId)
}

function addVoteOption() {
  const config = normalizeActivityConfig('vote', form.value.activityConfig) as Extract<ActivityConfigForm, { kind: 'vote' }>
  if (config.options.length >= 50) return
  config.options.push({ id: makeStableId('option'), label: t('lottery.adminOptionNumber', { n: config.options.length + 1 }), description: '', imageUrl: '' })
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
    lottery: t('lottery.adminKindLottery'),
    signup_chain: t('lottery.adminKindSignupChain'),
    claim: t('lottery.adminKindClaim'),
    survey: t('lottery.adminKindSurvey'),
    vote: t('lottery.adminKindVote'),
    checkin: t('lottery.adminKindCheckin'),
    reservation: t('lottery.adminKindReservation'),
    approval: t('lottery.adminKindApproval'),
    waitlist: t('lottery.adminKindWaitlist'),
  }
  return map[kind] || kind || '-'
}

function experienceTypeLabel(type: string): string {
  const map: Record<string, string> = {
    submit: t('lottery.adminExpSubmit'),
    wheel: t('lottery.adminExpWheel'),
    slot: t('lottery.adminExpSlot'),
    scratch: t('lottery.adminExpScratch'),
    card: t('lottery.adminExpCard'),
    list: t('lottery.adminExpList'),
    calendar: t('lottery.adminExpCalendar'),
    form: t('lottery.adminExpForm'),
    ballot: t('lottery.adminExpBallot'),
    checkin: t('lottery.adminExpCheckin'),
    queue: t('lottery.adminExpQueue'),
    reveal: t('lottery.adminExpReveal'),
    grid: t('lottery.adminExpGrid'),
  }
  return map[type] || type || '-'
}

function resultModeLabel(mode: string): string {
  const map: Record<string, string> = {
    manual: t('lottery.adminResultManual'),
    scheduled: t('lottery.adminResultScheduled'),
    instant: t('lottery.adminResultInstant'),
    ordered_assignment: t('lottery.adminResultOrdered'),
    capacity_assignment: t('lottery.adminResultCapacity'),
    vote_tally: t('lottery.adminResultVoteTally'),
    review_decision: t('lottery.adminResultReview'),
    no_result: t('lottery.adminResultNoResult'),
  }
  return map[mode] || mode || '-'
}

function canDeleteDraw(draw: LotteryDraw): boolean {
  return canDeleteDrawByStatus(draw.status)
}

/** 筛选变更回第 1 页，避免页码卡在空页 */
function reloadFromFirstPage() {
  pagination.setPage(1)
  void loadData()
}

/** 清空搜索/类型/时间，状态回到默认「进行中」 */
function clearListFilters() {
  statusFilter.value = 'active'
  listQuery.value = ''
  activityKindFilter.value = ''
  createdFromFilter.value = ''
  createdToFilter.value = ''
  clearSelection()
  reloadFromFirstPage()
}

/** 空态：查看含已结束的全部状态 */
function showAllStatuses() {
  statusFilter.value = ''
  reloadFromFirstPage()
}

function emailStatusLabel(w: LotteryWinner): string {
  if (isWinnerEmailSent(w)) return t('lottery.adminEmailSent')
  if (isWinnerEmailFailed(w)) return t('lottery.adminEmailFailed')
  return t('lottery.adminEmailPending')
}

/** 中奖行 title：优先 notificationError，兼容旧 emailError */
function winnerEmailErrorTitle(w: LotteryWinner): string | undefined {
  const msg = String(w.notificationError || w.emailError || '').trim()
  return msg || undefined
}

function scrollToPublishFixSection(errors: PublishCheckItem[]) {
  const targetId = publishFixSectionTargetId(errors)
  if (!targetId) return
  // 高级区需要先展开再滚
  if (targetId === 'lottery-advanced') showAdvancedGrowth.value = true
  requestAnimationFrame(() => {
    setTimeout(() => scrollEditorSection(targetId), 80)
  })
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
  const prevPending = winnersEmailPendingCount.value
  try {
    const data = await fetchLotteryWinners(id)
    winners.value = data.winners || []
    rememberDrawEmailFails(id, winners.value)
    winnersStatusRefreshes += 1
    const nextFail = winnersEmailFailureCount.value
    const nextPending = winnersEmailPendingCount.value
    const hitMax = winnersStatusRefreshes >= MAX_WINNERS_STATUS_REFRESHES
    const shouldStop = nextPending === 0 || hitMax
    if (shouldStop) {
      stopWinnersStatusPolling()
      // docs/077：pending 收敛后给一次可感知反馈（失败优先）
      const settle = winnersPollSettleKind({
        prevPending,
        nextFail,
        nextPending,
        hitMaxRefreshes: hitMax,
      })
      if (settle === 'became_failed') {
        showToast(t('lottery.adminEmailPollBecameFailed', { count: nextFail }), 'error')
      } else if (settle === 'all_sent') {
        showToast(t('lottery.adminEmailPollAllSent'), 'success')
      } else if (settle === 'still_pending') {
        showToast(t('lottery.adminEmailPollStillPending'), 'success')
      }
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
  await copyWithToast(publicShareUrl(draw.publicSlug), {
    successMessage: t('lottery.adminLinkCopied'),
    errorMessage: t('lottery.adminLinkCopyFailed'),
  })
}

/** 新标签打开用户端活动页，便于运营自检 */
function handleOpenPublic(draw: LotteryDraw) {
  const path = `/lottery/${draw.publicSlug}`
  if (typeof window !== 'undefined') {
    window.open(path, '_blank', 'noopener,noreferrer')
  }
}
function isManualWinnerPrize(w: LotteryWinner): boolean {
  const t = String(w.prizeType || '').trim().toLowerCase()
  return t === 'manual_fulfillment' || t === 'manual'
}

async function copyWinnerCode(w: LotteryWinner) {
  const text = String(w.prizeCode || w.cardAccountLabel || '').trim()
  if (!text) return
  await copyWithToast(text, {
    successMessage: t('lottery.copied'),
    errorMessage: t('lottery.networkError'),
  })
}

function handleExportWinners() {
  if (winners.value.length === 0) {
    showToast(t('lottery.adminExportWinnersEmpty'), 'error')
    return
  }
  const rows = buildLotteryWinnersCsvRows(winners.value, {
    email: t('lottery.adminEmail'),
    prize: t('lottery.adminPrizeCol'),
    fulfillment: t('lottery.adminFulfillmentCol'),
    emailStatus: t('lottery.adminEmailStatus'),
    sent: t('lottery.adminEmailSent'),
    pending: t('lottery.adminEmailPending'),
    failed: t('lottery.adminEmailFailed'),
    manual: t('lottery.adminFulfillManual'),
    codeMissing: t('lottery.adminFulfillCodeMissing'),
  })
  const idPart = (winnersModalDrawId.value || 'winners').slice(0, 40)
  downloadCsv(`lottery-winners-${idPart}-${new Date().toISOString().slice(0, 10)}.csv`, rows)
  showToast(t('lottery.adminExportWinnersDone'), 'success')
}

function handleDuplicate(draw: LotteryDraw) {
  const draft = buildLotteryDuplicateDraft(draw, { nameSuffix: t('lottery.adminDuplicateSuffix'), defaultName: t('lottery.adminNewActivity') })
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
  showAdvancedGrowth.value = false
  activeTemplateId.value = ''
  activeTemplateName.value = ''
  showCreateModal.value = true
  showToast(t('lottery.adminDuplicatedToast'), 'success')
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
  showAdvancedGrowth.value = false
  activeTemplateId.value = ''
  activeTemplateName.value = ''
  rosterInput.value = ''
  inviteCodeCount.value = 10
  createStepFocus.value = 1
}

/** 列表行「更多」：同 thr 收起；另 thr 只开一行；锚定按钮定位浮层 */
function toggleRowActions(drawId: string, event?: MouseEvent) {
  if (expandedActionId.value === drawId) {
    closeRowActions()
    return
  }
  const anchor =
    (event?.currentTarget instanceof HTMLElement ? event.currentTarget : null)
    || moreBtnRefs.get(drawId)
    || null
  expandedActionId.value = drawId
  if (anchor) {
    positionMoreMenu(anchor)
    nextTick(() => refineMoreMenuPosition(anchor))
  }
}

/**
 * 表格/窗口滚动时关闭浮层（行业常见：避免锚点滚走后菜单悬空）。
 * 菜单自身 overflow 滚动不关——否则长菜单无法扫到底。
 */
function onMoreMenuScroll(e: Event) {
  if (!expandedActionId.value) return
  const t = e.target
  if (t instanceof Node && moreMenuEl.value?.contains(t)) return
  closeRowActions()
}

function onMoreMenuResize() {
  if (!expandedActionId.value) return
  closeRowActions()
}

function onMoreMenuKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && expandedActionId.value) {
    e.preventDefault()
    closeRowActions()
  }
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
    enabledKinds.value = data.enabledKinds || []
    enabledParticipationModes.value = data.enabledParticipationModes || []
  } catch {
    // 加载失败时允许用户直接创建空白活动
    templates.value = []
    enabledKinds.value = []
    enabledParticipationModes.value = []
  }
}

function categoryLabel(cat: string): string {
  const map: Record<string,string> = { marketing: t('lottery.adminCatMarketing'), engagement: t('lottery.adminCatEngagement'), conversion: t('lottery.adminCatConversion'), research: t('lottery.adminCatResearch') }
  return map[cat] || cat
}

/**
 * 055a P1：模板 → 接近可发布草稿。
 * - 带入 kind / experience / mode / resultMode / 展示开关
 * - 自动时间预设（抽奖 1 天 + 开奖缓冲；短互动类可用 1h，仍可改）
 * - 抽奖：预置空奖项行 + winnerCount，配合「快速创建奖品」闭环
 * 不改 API、不伪造奖品；发布门禁仍以服务端 publish-check 为准。
 */
function applyTemplate(tpl: any) {
  showTemplateModal.value = false
  const base = emptyForm()
  const kind = tpl.defaults?.activityKind || 'lottery'
  const winnerCount = Number(tpl.defaults?.winnerCount) || (kind === 'lottery' ? 1 : 0)
  // 应用模板默认值
  form.value = {
    ...base,
    id: '',
    // 预填可改标题，避免「空名 + 时间已填」却仍无法保存的落差；运营者一改即可
    name: String(tpl.name || '').trim(),
    description: String(tpl.description || '').trim().slice(0, 500),
    activityKind: kind,
    experienceType: tpl.defaults.experienceType,
    resultMode: tpl.defaults.resultMode || defaultResultModeForActivity(kind),
    participationMode: tpl.defaults.participationMode || 'open',
    allocationPolicy: tpl.defaults.allocationPolicy || 'capacity',
    winnerCount: kind === 'lottery' ? Math.max(1, winnerCount) : 0,
    maxParticipants: tpl.defaults?.maxParticipants ?? null,
    expectedParticipants: 0,
    // 模板 defaults 含展示开关时带入（后端 create 支持 show* 字段）
    showWinners: Number(tpl.defaults?.showWinnerList ?? tpl.defaults?.showWinnerCount ?? 0) === 1,
    showParticipantCount: (Number(tpl.defaults?.showParticipantCount ?? 1) === 1 ? 1 : 0) as 0 | 1,
    // instant 模板：默认 maxSpins=1（docs/116）
    maxSpinsPerEntry: Math.max(1, Number(tpl.defaults?.maxSpinsPerEntry) || 1),
    activityConfig: defaultActivityConfigForKind(kind, t) as any,
    // 抽奖：先占一行奖项，引导「选奖品 / 快速创建」；instant 预填 weight=1
    tiers: kind === 'lottery'
      ? [{
          prizeId: '',
          tierName: t('lottery.adminTierName', { n: 1 }),
          winnerCount: Math.max(1, winnerCount || 1),
          weight: String(tpl.defaults?.resultMode || '') === 'instant' ? 1 : 0,
        }]
      : [],
    enableProductLink: tpl.defaults?.enableProductLink === true,
    productLink: {
      url: '',
      title: String(tpl.defaults?.productLinkTitle || ''),
      imageUrl: '',
      price: String(tpl.defaults?.productLinkPrice || ''),
    },
    enableFlashSale: tpl.defaults?.enableFlashSale === true,
    flashSaleSessionLabel: String(tpl.defaults?.flashSaleSessionLabel || ''),
    flashSaleStockLimit: tpl.defaults?.flashSaleStockLimit ?? null,
    flashSalePaymentRequired: tpl.defaults?.flashSalePaymentRequired === true,
    flashSalePriceCents: tpl.defaults?.flashSalePriceCents ?? null,
    flashSaleCurrency: String(tpl.defaults?.flashSaleCurrency || 'cny'),
    flashSaleTitle: String(tpl.defaults?.flashSaleTitle || ''),
  }
  // 模板智能增强：不同类型预设更合理的默认值，减少重复配置
  if (tpl.id === 'signup-chain' || kind === 'signup_chain') {
    form.value.maxParticipants = 30   // 预设容量，运营者可调整
    form.value.allocationPolicy = 'waitlist'  // 候补默认开启
  }
  if (tpl.id === 'checkin-daily' || kind === 'checkin') {
    form.value.maxParticipants = null
  }
  if (tpl.id === 'survey-feedback') {
    // defaultActivityConfigForKind 已预设「联系邮箱」和「反馈内容」2 个字段
  }
  if (tpl.id === 'vote-pick') {
    // defaultActivityConfigForKind 已预设「选项 A」和「选项 B」2 个选项
  }
  // 若奖品库已有可用奖品，自动挂到第一奖项，减少一次点击（不创建新奖品，避免脏数据）
  if (kind === 'lottery' && prizeOptions.value.length > 0 && form.value.tiers[0] && !form.value.tiers[0].prizeId) {
    const first = prizeOptions.value[0]
    if (first?.id) {
      form.value.tiers[0].prizeId = first.id
      if (!form.value.tiers[0].tierName) {
        form.value.tiers[0].tierName = first.name || t('lottery.adminTierName', { n: 1 })
      }
    }
  }
  isEditing.value = false
  showAdvancedGrowth.value = false
  activeTemplateId.value = String(tpl.id || '')
  activeTemplateName.value = String(tpl.name || '')
  // 时间：抽奖/接龙偏「一天活动」；短互动（签到试跑）仍 1d 可改，统一 1d 降低认知分支
  applyTimePreset('1d')
  // 模板已带标题/时间时，焦点落到第 4 步（奖项/名额），缩短 TTV 扫视
  createStepFocus.value = kind === 'lottery' ? 4 : 1
  showCreateModal.value = true
  showToast(t('lottery.adminTemplateApplied', { name: activeTemplateName.value || activeTemplateId.value }), 'success')
  // 空奖品库 + 抽奖：额外提示用「快速创建」过门禁，不自动写库（避免误点模板就落脏奖品）
  if (kind === 'lottery' && prizeOptions.value.length === 0) {
    showToast(t('lottery.adminEmptyPrizeHint'), 'info')
  }
  // 打开后滚到焦点步骤，避免用户仍停在标题区
  nextTick(() => focusCreateStep(createStepFocus.value))
}

async function loadData() {
  const ok = await runLoad(
    async ({ isStale }) => {
      const data = await fetchLotteryDraws({
        limit: pagination.limit.value,
        offset: (pagination.page.value - 1) * pagination.limit.value,
        status: statusFilter.value || undefined,
        query: listQuery.value || undefined,
        activityKind: activityKindFilter.value || undefined,
        createdFrom: createdFromFilter.value ? `${createdFromFilter.value}T00:00:00.000Z` : undefined,
        createdTo: createdToFilter.value ? `${createdToFilter.value}T23:59:59.999Z` : undefined,
      })
      if (isStale()) return
      draws.value = data.draws || []
      // 预填公开链接缓存，打开二维码/海报弹窗时再本地生成图
      for (const d of draws.value) {
        prefetchPublicUrl(d)
      }
      pagination.setTotal(data.total || 0)
    },
    {
      onError: (err) =>
        toErrorMessage(err, t('lottery.adminLoadFailed')),
    },
  )
  if (!ok && loadError.value) {
    draws.value = []
    showToast(loadError.value, 'error')
  }
}

async function handleOpen(draw: LotteryDraw) {
  operatingId.value = draw.id
  try {
    // 发布前先展示同一套服务端门禁结果：运营者需要知道缺奖项、码池、CTA、Webhook 等具体阻断点。
    const check = await fetchPublishCheck(draw.id)
    if (!check.canPublish) {
      // 钉在列表行：下次扫一眼就知道还差什么，不必再点开启才出 toast
      setDraftPublishBlocker(draw.id, check.errors[0]?.message)
      const summary = formatPublishCheckItems(check.errors, t('lottery.adminPublishErrorsPrefix'))
      // 可编辑补齐：确认后进编辑并滚到相关分区；否则仅 toast（如 webhook 类）
      if (canGuidePublishFixInEditor(draw, check.errors)) {
        const goEdit = await askConfirm(`${summary}\n\n${t('lottery.adminPublishFixGoEdit')}`)
        if (goEdit) {
          operatingId.value = ''
          await handleEdit(draw)
          scrollToPublishFixSection(check.errors)
          return
        }
      }
      showToast(summary, 'error')
      return
    }
    clearDraftPublishBlocker(draw.id)
    if (check.warnings.length > 0) {
      const confirmed = await askConfirm(formatPublishCheckItems(check.warnings, t('lottery.adminPublishWarningsPrefix')) + t('lottery.adminPublishStill'))
      if (!confirmed) return
    }
    await openLotteryDraw(draw.id)
    // 发布后复制公开 slug 链接，避免把内部活动 id 发给参与者导致公开页 404。
    // docs/075：默认勾选「打开用户页」，确认即预览，少一次「是否打开？」心智负担。
    try {
      await writeClipboardText(publicShareUrl(draw.publicSlug))
      showToast(t('lottery.adminOpenedWithLink'), 'success')
      if (await askOpenPublicPreview(t('lottery.adminOpenedWithPreview'))) {
        handleOpenPublic(draw)
      }
    } catch {
      showToast(t('lottery.adminDrawOpened'), 'success')
    }
    await loadData()
  } catch (e) {
    showToast(toErrorMessage(e, t('lottery.adminFailed')), 'error')
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
    await loadData()
  } catch (e) {
    showToast(toErrorMessage(e, t('lottery.adminFailed')), 'error')
  } finally {
    operatingId.value = ''
  }
  // 与 viewWinners 各自管理 operatingId，避免 finally 互相覆盖导致按钮卡死
  // docs/076：先打开中奖名单再按邮件态 toast——失败可感知，且名单上可一键重发
  if (drawOk) {
    await viewWinners(draw.id)
    const kind = drawDoneFeedbackKind(winners.value)
    if (kind === 'email_failed') {
      showToast(
        t('lottery.adminDrawDoneWithEmailFail', { count: winnersEmailFailureCount.value }),
        'error',
      )
    } else if (kind === 'email_pending') {
      showToast(t('lottery.adminDrawDonePendingEmail'), 'success')
    } else if (kind === 'empty') {
      showToast(t('lottery.adminDrawDoneEmpty'), 'success')
    } else {
      showToast(t('lottery.adminDrawDone'), 'success')
    }
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
    rememberDrawEmailFails(id, winners.value)
    startWinnersStatusPolling(id)
  } catch (e) {
    showToast(toErrorMessage(e, t('lottery.adminFailed')), 'error')
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



async function handleCancel(id: string) {
  if (!(await askConfirm(t('lottery.adminConfirmCancel')))) return
  operatingId.value = id
  try {
    await cancelLotteryDraw(id)
    showToast(t('lottery.adminDrawCancelled'), 'success')
    await loadData()
  } catch (e) {
    showToast(toErrorMessage(e, t('lottery.adminFailed')), 'error')
    await loadData()
  } finally {
    operatingId.value = ''
  }
}

async function handleDelete(id: string) {
  const draw = draws.value.find((item) => item.id === id)
  if (!draw || !canDeleteDraw(draw)) return
  if (!(await askConfirm(t('lottery.adminConfirmDelete', { name: drawDisplayName(draw), status: statusLabel(draw.status) })))) return
  operatingId.value = id
  try {
    await deleteLotteryDraw(id)
    showToast(t('lottery.adminDrawDeleted'), 'success')
    await loadData()
  } catch (e) {
    showToast(toErrorMessage(e, t('lottery.adminFailed')), 'error')
  } finally {
    operatingId.value = ''
  }
}

/**
 * 批量删除：优先 POST /draws/batch-delete（单次请求 + 一条审计）；
 * 失败时降级为顺序单条 DELETE，保持测试清场可用。
 */
async function batchDeleteDraws() {
  const ids = selectedIds.value
  if (ids.length === 0 || loading.value || batchOperating.value) return
  const selectedDraws = draws.value.filter((draw) => ids.includes(draw.id) && canDeleteDraw(draw))
  if (selectedDraws.length === 0) return
  const drawnCount = selectedDraws.filter((draw) => draw.status === 'drawn').length
  if (!(await askConfirm(t('lottery.adminConfirmBatchDelete', { count: selectedDraws.length, drawnCount })))) return

  const targetIds = selectedDraws.map((d) => d.id)
  // 标记 busy 供 bulk-bar；勿与 runBatchSequential 重叠占用 operating
  batchOperating.value = true
  batchCompleted.value = 0
  batchTotal.value = targetIds.length
  try {
    const data = await batchDeleteLotteryDraws(targetIds)
    batchCompleted.value = targetIds.length
    if (data.deleted === 0 && data.failed === 0) {
      showToast(t('lottery.adminBatchNothingDone'), 'info')
    } else {
      const batchType = resolveBatchToastType({ success: data.deleted, failed: data.failed })
      if (batchType === 'error') {
        showToast(t('lottery.adminBatchDeleteResult', { success: data.deleted, failed: data.failed }), batchType)
      } else {
        showToast(t('lottery.adminBatchDeleteSuccess', { count: data.deleted }), batchType)
      }
    }
  } catch {
    // 旧后端或网络异常：释放 busy 后降级顺序 DELETE（runSequential 自己管 operating）
    batchOperating.value = false
    const result = await runBatchSequential(targetIds, async (id) => {
      await deleteLotteryDraw(id)
    })
    if (!result) return
    if (result.success === 0 && result.failed === 0) {
      showToast(t('lottery.adminBatchNothingDone'), 'info')
    } else {
      const batchType = resolveBatchToastType(result)
      if (batchType === 'error') {
        showToast(t('lottery.adminBatchDeleteResult', { success: result.success, failed: result.failed }), batchType)
      } else {
        showToast(t('lottery.adminBatchDeleteSuccess', { count: result.success }), batchType)
      }
    }
  } finally {
    batchOperating.value = false
  }
  clearSelection()
  await loadData()
}

/**
 * 批量隐藏已开奖活动（visible=0）。
 * 为什么优先于批量删：数据与中奖记录保留，只清用户视野；仅 drawn 且当前可见。
 */
async function batchHideDrawn() {
  const targets = draws.value.filter((d) => selectedIds.value.includes(d.id) && canBatchHideDraw(d))
  if (targets.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(t('lottery.adminConfirmBatchHide', { count: targets.length })))) return
  const result = await runBatchSequential(targets.map((d) => d.id), async (id) => {
    await updateLotteryDraw(id, { visible: 0 })
  })
  if (!result) return
  toastBatchLifecycle(result, 'hide')
  clearSelection()
  await loadData()
}

/** 导出已选元数据（id/slug/状态），测试排障与交接，不含参与者 PII */
function exportSelectedDraws() {
  const selected = draws.value.filter((d) => selectedIds.value.includes(d.id))
  if (selected.length === 0) return
  downloadCsv(
    `selected-draws-${new Date().toISOString().slice(0, 10)}.csv`,
    buildSelectedDrawsCsvRows(selected),
  )
  showToast(t('lottery.adminExportSelectedSuccess', { count: selected.length }), 'success')
}

/** open → paused 顺序暂停 */
async function batchPauseDraws() {
  const targets = draws.value.filter((d) => selectedIds.value.includes(d.id) && canPauseDraw(d))
  if (targets.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(t('lottery.adminConfirmBatchPause', { count: targets.length })))) return
  const result = await runBatchSequential(targets.map((d) => d.id), async (id) => {
    await pauseLotteryDraw(id)
  })
  if (!result) return
  toastBatchLifecycle(result, 'pause')
  clearSelection()
  await loadData()
}

/** paused → open 顺序恢复 */
async function batchResumeDraws() {
  const targets = draws.value.filter((d) => selectedIds.value.includes(d.id) && canResumeDraw(d))
  if (targets.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(t('lottery.adminConfirmBatchResume', { count: targets.length })))) return
  const result = await runBatchSequential(targets.map((d) => d.id), async (id) => {
    await resumeLotteryDraw(id)
  })
  if (!result) return
  toastBatchLifecycle(result, 'resume')
  clearSelection()
  await loadData()
}

/**
 * draft/open/paused → cancelled。
 * 为什么：测试关停优先取消而非物理删；保留行便于审计，drawn/drawing 不可取消。
 */
async function batchCancelDraws() {
  const targets = draws.value.filter((d) => selectedIds.value.includes(d.id) && canCancelDraw(d))
  if (targets.length === 0 || loading.value || batchOperating.value) return
  if (!(await askConfirm(t('lottery.adminConfirmBatchCancel', { count: targets.length })))) return
  const result = await runBatchSequential(targets.map((d) => d.id), async (id) => {
    await cancelLotteryDraw(id)
  })
  if (!result) return
  toastBatchLifecycle(result, 'cancel')
  clearSelection()
  await loadData()
}

function toastBatchLifecycle(
  result: { success: number; failed: number },
  kind: 'hide' | 'pause' | 'resume' | 'cancel',
) {
  if (result.success === 0 && result.failed === 0) {
    showToast(t('lottery.adminBatchNothingDone'), 'info')
    return
  }
  const map = {
    hide: { ok: 'lottery.adminBatchHideSuccess', fail: 'lottery.adminBatchHideResult' },
    pause: { ok: 'lottery.adminBatchPauseSuccess', fail: 'lottery.adminBatchPauseResult' },
    resume: { ok: 'lottery.adminBatchResumeSuccess', fail: 'lottery.adminBatchResumeResult' },
    cancel: { ok: 'lottery.adminBatchCancelSuccess', fail: 'lottery.adminBatchCancelResult' },
  } as const
  const keys = map[kind]
  const batchType = resolveBatchToastType(result)
  if (batchType === 'error') {
    showToast(t(keys.fail, { success: result.success, failed: result.failed }), batchType)
  } else {
    showToast(t(keys.ok, { count: result.success }), batchType)
  }
}

async function handlePause(id: string) {
  if (!(await askConfirm(t('lottery.adminConfirmPause')))) return
  operatingId.value = id
  try {
    await pauseLotteryDraw(id)
    showToast(t('lottery.adminPaused'), 'success')
    await loadData()
  } catch (e) {
    showToast(toErrorMessage(e, t('lottery.adminFailed')), 'error')
    await loadData()
  } finally {
    operatingId.value = ''
  }
}

async function handleResume(id: string) {
  operatingId.value = id
  try {
    await resumeLotteryDraw(id)
    showToast(t('lottery.adminResumed'), 'success')
    await loadData()
  } catch (e) {
    showToast(toErrorMessage(e, t('lottery.adminFailed')), 'error')
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
  // 调详情 API 获取完整活动数据（含奖项配置 tiers + promotionConfig）
  let tiers: Array<{ prizeId: string; tierName: string; winnerCount: number; weight?: number }> = []
  let detailDraw: Record<string, any> | null = null
  try {
    const detail = await adminRequest<{ draw: any; tiers: Array<{ prizeId: string; tierName: string; winnerCount: number; weight?: number }> }>(`/api/admin/draws/${draw.id}`)
    if (detail.tiers) {
      tiers = detail.tiers.map(t => ({
        prizeId: t.prizeId || '',
        tierName: t.tierName || '',
        winnerCount: t.winnerCount || 1,
        weight: Number(t.weight) || 0,
      }))
    }
    if (detail.draw) detailDraw = detail.draw
  } catch { /* 详情加载失败时使用空奖项 + 列表行上的字段 */ }
  // 详情优先（含完整 promotionConfig）；列表行作 fallback
  const source = detailDraw || (draw as Record<string, any>)
  const growth = growthFieldsFromDraw(source)
  form.value = {
    ...emptyForm(),
    id: draw.id,
    name: draw.title,
    description: draw.description || '',
    startTime: toDateTimeLocalValue(draw.startAt),
    endTime: toDateTimeLocalValue(draw.endAt),
    drawTime: toDateTimeLocalValue(draw.drawAt || ''),
    winnerCount: draw.winnerCount,
    maxSpinsPerEntry: Math.max(1, Number(source.maxSpinsPerEntry || draw.maxSpinsPerEntry || 1)),
    maxParticipants: draw.maxParticipants ?? null,
    participationMode: draw.participationMode || 'open',
    activityKind: draw.activityKind || 'lottery',
    allocationPolicy: draw.allocationPolicy || 'capacity',
    experienceType: draw.experienceType || defaultExperienceForActivity(draw.activityKind || 'lottery', draw.participationMode || 'open'),
    resultMode: draw.resultMode || defaultResultModeForActivity(draw.activityKind || 'lottery'),
    activityConfig: normalizeActivityConfig(draw.activityKind || 'lottery', draw.activityConfig) as any,
    // 编辑回填展示开关，避免保存时把服务端已有 show* 误写成 0
    showWinners: Number(draw.showWinnerList ?? draw.showWinnerCount ?? 0) === 1,
    showParticipantCount: (Number(draw.showParticipantCount ?? 1) === 1 ? 1 : 0) as 0 | 1,
    tiers,  // 回填奖项配置（修复编辑时奖项带不出来的 bug）
    enableProductLink: growth.enableProductLink,
    productLink: growth.productLink,
    enableViral: growth.enableViral,
    viralExtraEntriesPerInvite: growth.viralExtraEntriesPerInvite,
    viralMaxExtraEntries: growth.viralMaxExtraEntries,
    viralLeaderboardEnabled: growth.viralLeaderboardEnabled,
    enableAfterWinCta: growth.enableAfterWinCta,
    afterWinCtaUrl: growth.afterWinCtaUrl,
    afterWinCtaTitle: growth.afterWinCtaTitle,
    enableAfterLossCta: growth.enableAfterLossCta,
    afterLossCtaUrl: growth.afterLossCtaUrl,
    afterLossCtaTitle: growth.afterLossCtaTitle,
    // docs/128：壳展示必须回填，否则二次保存会擦掉 experience
    prizePanelMode: growth.prizePanelMode || 'auto',
    ritualPhrasesText: growth.ritualPhrasesText || '',
    // docs/130：秒杀壳回填
    enableFlashSale: growth.enableFlashSale,
    flashSaleSessionLabel: growth.flashSaleSessionLabel || '',
    flashSaleStockLimit: growth.flashSaleStockLimit,
    flashSaleMaxPerUser: growth.flashSaleMaxPerUser || 1,
    flashSaleCtaLabel: growth.flashSaleCtaLabel || '抢',
    flashSaleShowCountdown: growth.flashSaleShowCountdown !== false,
    flashSaleShowProgress: growth.flashSaleShowProgress !== false,
    flashSaleShowStock: growth.flashSaleShowStock !== false,
    flashSalePaymentRequired: growth.flashSalePaymentRequired === true,
    flashSalePriceCents: growth.flashSalePriceCents,
    flashSaleCurrency: growth.flashSaleCurrency || 'cny',
    flashSaleTitle: growth.flashSaleTitle || '',
  }
  isEditing.value = true
  // 回填未中奖自动发券开关状态
  initLoserRewardFromConfig()
  // 已有裂变/导流时展开高级增长区，否则运营看不到「已开启」状态（易二次保存擦掉）
  showAdvancedGrowth.value = growth.hasGrowthConfig
  activeTemplateId.value = ''
  activeTemplateName.value = ''
  // 缺奖项时焦点落在步骤 4，方便门禁失败后的补齐路径
  const needPrizes = (draw.activityKind || 'lottery') === 'lottery'
    && !tiers.some((tier) => Boolean(tier.prizeId))
  createStepFocus.value = needPrizes ? 4 : 1
  showCreateModal.value = true
  if (needPrizes) nextTick(() => focusCreateStep(4))
}

async function handleToggleVisibility(id: string, visible: number | undefined) {
  // docs/083：仅 drawn 可切换；缺省 visible 视为用户可见（与 isLotteryUserVisible 一致）
  const currentlyVisible = isLotteryUserVisible(visible)
  const action = currentlyVisible ? t('lottery.adminHide') : t('lottery.adminShow')
  if (!(await askConfirm(t('lottery.adminConfirmToggleVisibility', { action })))) return
  operatingId.value = id
  try {
    await updateLotteryDraw(id, { visible: currentlyVisible ? 0 : 1 })
    showToast(currentlyVisible ? t('lottery.adminHidden') : t('lottery.adminShown'), 'success')
    await loadData()
  } catch (e) {
    showToast(toErrorMessage(e, t('lottery.adminFailed')), 'error')
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
    // 若中奖弹窗正打开同一活动，刷新名单上的发送态；同步行内邮件失败提示
    try {
      const data = await fetchLotteryWinners(id)
      if (showWinnersModal.value && winnersModalDrawId.value === id) {
        winners.value = data.winners || []
      }
      rememberDrawEmailFails(id, data.winners || [])
    } catch {
      /* 列表刷新失败不阻断主提示 */
    }
    await loadData()
  } catch (e) {
    showToast(toErrorMessage(e, t('lottery.adminFailed')), 'error')
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
  } catch (e) {
    showToast(toErrorMessage(e, t('lottery.adminFailed')), 'error')
  } finally {
    operatingId.value = ''
  }
}

async function handleCreate() {
  if (!form.value.name || !form.value.startTime || !form.value.endTime) {
    showToast(t('lottery.adminFillNameTime'), 'error')
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
    const activityKind = form.value.activityKind || 'lottery'
    const drawAtIso = form.value.drawTime ? dateTimeLocalToIso(form.value.drawTime) : undefined
    // docs/115：drawAt 必须配对 drawTrigger=scheduled，否则 Cron 永不扫到（表单文案写「系统自动开奖」）
    const schedule = resolveLotteryScheduleFields({
      activityKind,
      drawAt: drawAtIso,
      resultMode: form.value.resultMode || defaultResultModeForActivity(activityKind),
    })
    const payload = {
      title: form.value.name,
      description: form.value.description,
      startAt: dateTimeLocalToIso(form.value.startTime),
      endAt: dateTimeLocalToIso(form.value.endTime),
      // instant 不写 drawAt，避免运营误以为定时开奖
      drawAt: schedule.resultMode === 'instant' ? undefined : drawAtIso,
      drawTrigger: schedule.drawTrigger,
      winnerCount: activityKind === 'lottery' ? Number(form.value.winnerCount) || 1 : 0,
      maxParticipants: form.value.maxParticipants ? Number(form.value.maxParticipants) : undefined,
      participationMode: form.value.participationMode || 'open',
      experienceType: form.value.experienceType || defaultExperienceForActivity(activityKind, form.value.participationMode || 'open'),
      activityKind,
      // lottery delayed：resultMode 跟 drawTrigger；instant 由 schedule 保留；非 lottery 保留表单默认
      resultMode: schedule.resultMode,
      // instant：每人 spin 次数硬顶（后端 create 仅 lottery+instant 写入）
      ...(schedule.resultMode === 'instant'
        ? { maxSpinsPerEntry: Math.max(1, Math.min(100, Math.floor(Number(form.value.maxSpinsPerEntry) || 1))) }
        : {}),
      allocationPolicy: form.value.allocationPolicy || 'capacity',
      // 表单「展示中奖名单」对应后端 showWinnerList；模板 defaults 也可经此写入
      showWinnerList: form.value.showWinners ? 1 : 0,
      showWinnerCount: form.value.showWinners ? 1 : 0,
      showParticipantCount: form.value.showParticipantCount ? 1 : 0,
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
      // 导流：商品链接（启用时发送；编辑关闭时显式 null，避免 PATCH 跳过字段导致旧链接残留）
      productLink: form.value.enableProductLink && form.value.productLink.url
        ? form.value.productLink
        : (isEditing.value ? null : undefined),
      // 导流与裂变：buildPromotionConfigPayload 单一真相（docs/114，可单测）
      // instant 时双写 extraSpins*（docs/122）
      promotionConfig: buildPromotionConfigPayload(
        { ...form.value, resultMode: form.value.resultMode },
        { isEditing: isEditing.value },
      ),
    }
    if (isEditing.value && form.value.id) {
      const current = draws.value.find((d) => d.id === form.value.id)
      if (current && current.status !== 'draft') {
        showToast(t('lottery.adminEditDraftOnly'), 'error')
        closeEditor()
        form.value = emptyForm()
        return
      }
      await updateLotteryDraw(form.value.id, payload)
      // ★ 创建与编辑共用：名单导入 / 邀请码生成 / 奖项配置（防止编辑分支遗漏）
      await saveDrawRoster(form.value.id)
      await saveDrawInviteCodes(form.value.id)
      await saveDrawTiers(form.value.id)
      // P1 体验：保存成功后回显清洗后的仪式短语，运营者立即看到哪些被保留/被拒。
      // sanitizeRitualPhrasesForSave 与提交清洗同源（docs/128）；不回显会显得「填的短语丢了」。
      form.value.ritualPhrasesText = sanitizeRitualPhrasesForSave(
        form.value.ritualPhrasesText ?? '',
      ).join('\n')
      showToast(t('lottery.adminDrawUpdated'), 'success')
    } else {
      const created = await createLotteryDraw(payload)
      if (created?.id) {
        // 如果是 roster 模式，导入名单
        await saveDrawRoster(created.id)
        // 如果是 invite_code 模式，生成邀请码
        await saveDrawInviteCodes(created.id)
        // 抽奖活动：创建成功后保存奖项配置（选择奖品库中的奖品 + 中奖名额）
        await saveDrawTiers(created.id)
        try {
          await writeClipboardText(publicShareUrl(created.publicSlug || created.id))
        } catch { /* 剪贴板写入失败不阻断 */ }
        // 055a P1：创建成功即关闭并回列表，不再强制再开编辑 Modal（打断「创建→开启」节奏）。
        // 可选「预览公开页」：用现有 handleOpenPublic，不新路由、不强制弹编辑。
        const lotteryMissingTier = form.value.activityKind === 'lottery'
          && !form.value.tiers.some((tier) => Boolean(tier.prizeId))
        const previewSlug = created.publicSlug || created.id
        closeEditor()
        form.value = emptyForm()
        await loadData()
        if (lotteryMissingTier) {
          showToast(t('lottery.adminCreatedNeedPrizeHint'), 'success')
          if (previewSlug && await askOpenPublicPreview(t('lottery.adminCreateNeedPrizeWithPreview'))) {
            handleOpenPublic({ publicSlug: previewSlug } as LotteryDraw)
          }
        } else {
          showToast(t('lottery.adminCreateDoneWithLink'), 'success')
          if (previewSlug && await askOpenPublicPreview(t('lottery.adminCreateDoneWithPreview'))) {
            handleOpenPublic({ publicSlug: previewSlug } as LotteryDraw)
          }
        }
      } else {
        showToast(t('lottery.adminCreated'), 'success')
        closeEditor()
        form.value = emptyForm()
        await loadData()
      }
    }
  } catch (e) {
    showToast(toErrorMessage(e, t('lottery.adminCreateFailed')), 'error')
  } finally {
    creating.value = false
  }
}

onMounted(() => {
  // Dashboard「邮件失败」待办深链：?status=drawn 预筛已开奖，便于点「查看结果」重发
  // 亦支持 ?status=active（与默认一致）或 ?status= 空串表示全部
  const statusQ = String(route.query.status ?? '').trim()
  if (statusQ && ['active', 'draft', 'open', 'paused', 'drawing', 'drawn', 'cancelled'].includes(statusQ)) {
    statusFilter.value = statusQ
  } else if (route.query.status === '') {
    statusFilter.value = ''
  }
  loadData()
  loadPrizeOptions()
  // 从运营台空状态跳转过来时，自动打开模板选择弹窗。
  if (route.query.new === 'true') {
    openTemplatePicker()
  }
  // 浮层菜单：表体滚动/窗口缩放时关闭，避免锚点滚走后菜单悬空
  window.addEventListener('scroll', onMoreMenuScroll, true)
  window.addEventListener('resize', onMoreMenuResize)
  window.addEventListener('keydown', onMoreMenuKeydown)
})

onBeforeUnmount(() => {
  stopWinnersStatusPolling()
  window.removeEventListener('scroll', onMoreMenuScroll, true)
  window.removeEventListener('resize', onMoreMenuResize)
  window.removeEventListener('keydown', onMoreMenuKeydown)
  moreBtnRefs.clear()
})
</script>
<style>
@import '@/assets/admin.css';
@import './lottery/admin-lottery-page.css';
</style>
