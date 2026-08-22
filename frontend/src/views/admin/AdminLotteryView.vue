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
        <button class="btn btn-ghost btn-sm" type="button" @click="exportCsv">
          {{ $t('lottery.adminExportCsv') }}
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
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || batchOperating" @click="openDeleteByIds">
          {{ $t('lottery.adminDeleteByIds') }}
        </button>
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
            <th class="col-actions">{{ $t('lottery.adminActions') }}</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="'sk' + i" class="skeleton-row">
            <td :colspan="8"><div class="skeleton-cell" /></td>
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
                </span>
                <small>{{ $t('lottery.adminWinnersOfMax') }}</small>
              </div>
            </td>
            <td>
              <!-- 活动时间单列（2026-08 打磨）：时间窗主行 + 开奖时间小字（即时出奖不显示空行） -->
              <div class="time-stack">
                <span>{{ formatDate(draw.startAt) }} → {{ formatDate(draw.endAt) }}</span>
                <small v-if="draw.drawAt">{{ $t('lottery.adminDrawAtPrefix') }} {{ formatDate(draw.drawAt) }}</small>
                <small v-else-if="draw.resultMode === 'instant'">{{ $t('lottery.adminListInstantOutcome') }}</small>
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
                  <!-- docs/223：进行中活动允许编辑非破坏性字段 -->
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    :disabled="operatingId === draw.id"
                    :title="$t('lottery.adminEditLiveHint')"
                    @click="handleEdit(draw)"
                  >{{ $t('lottery.adminEdit') }}</button>
                </template>
                <!-- open 非抽奖：分享（主）+ 暂停 + 编辑 -->
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
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    :disabled="operatingId === draw.id"
                    :title="$t('lottery.adminEditLiveHint')"
                    @click="handleEdit(draw)"
                  >{{ $t('lottery.adminEdit') }}</button>
                </template>
                <!-- paused：恢复 + 分享 + 编辑 -->
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
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    :disabled="operatingId === draw.id"
                    :title="$t('lottery.adminEditLiveHint')"
                    @click="handleEdit(draw)"
                  >{{ $t('lottery.adminEdit') }}</button>
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
            <td colspan="8" class="empty-text">
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
      @update:limit="pagination.setLimit($event); resetCursorMap(); loadData()"
    />

    <!-- 创建/编辑活动 -->
    <AdminModal
      v-model="showCreateModal"
      :title="isEditing ? $t('lottery.adminDrawEdit') : $t('lottery.adminDrawCreate')"
      max-width="720px"
      hide-actions
    >
      <form class="modal-form lottery-editor-form" novalidate @submit.prevent="handleCreate">
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
          <!-- docs/162 P1-C：套用模板后展示配置要点（hints），新手也能知道关键前置条件 -->
          <ul v-if="activeTemplateHints.length" class="template-hints" :aria-label="$t('lottery.adminTemplateHintsTitle')">
            <li v-for="(h, hi) in activeTemplateHints" :key="hi">{{ h }}</li>
          </ul>
          <!-- docs/145 P2 接线（docs/162 发现此前从未接入 UI）：已按模板收敛的诚实提示 -->
          <p
            v-if="isFieldScopedTemplate(activeTemplateId) && !isEditing"
            class="create-path-hint create-path-hint--scoped"
            role="note"
          >{{ $t('lottery.adminTemplateFieldScopedHint') }}</p>
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

            <!-- 时间三字段同排（2026-08 打磨）：开始/结束/开奖各占 1/3 一行，省竖向空间；
                 hint 精简进 label 与 section desc，不再逐字段冗述（语义不丢） -->
            <div class="form-grid time-grid three-cols">
              <label>
                <span>{{ $t('lottery.adminStartTime') }}</span>
                <input v-model="form.startTime" type="datetime-local" step="60" :lang="locale" :disabled="editLocked" required />
                <small v-if="editLocked" class="field-hint">{{ $t('lottery.adminEditLiveLockHint') }}</small>
              </label>
              <label>
                <span>{{ $t('lottery.adminEndTime') }}</span>
                <input v-model="form.endTime" type="datetime-local" step="60" :lang="locale" required />
                <small v-if="editLocked" class="field-hint">{{ $t('lottery.adminEditLiveEndOnlyHint') }}</small>
              </label>
              <template v-if="isInstantMode">
                <div class="field-static-inline time-draw-instant-hint" role="status">
                  {{ $t('lottery.adminDrawTimeInstantHint') }}
                </div>
              </template>
              <template v-else>
                <label>
                  <span>{{ $t('lottery.drawTime') }}</span>
                  <input v-model="form.drawTime" type="datetime-local" step="60" :lang="locale" required />
                </label>
              </template>
            </div>

            <p
              class="time-timeline"
              :class="{ 'is-invalid': Boolean(timeOrderError) }"
              role="status"
            >
              <template v-if="timeOrderError">{{ timeOrderError }}</template>
              <template v-else-if="form.startTime && form.endTime && (isInstantMode || form.drawTime)">
                <span>{{ $t('lottery.adminTimeOrderOk') }}</span>
                <strong>{{ formatLocalInput(form.startTime) }}</strong>
                <span aria-hidden="true">→</span>
                <strong>{{ formatLocalInput(form.endTime) }}</strong>
                <template v-if="!isInstantMode">
                  <span aria-hidden="true">→</span>
                  <strong>{{ formatLocalInput(form.drawTime) }}</strong>
                </template>
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
            <div class="form-grid mode-summary-grid">
              <label>
                <span>{{ $t('lottery.adminActivityKind') }}</span>
                <select v-model="form.activityKind" :disabled="editLocked" @change="handleActivityKindChange">
                  <option v-for="opt in activityKindOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
                <small class="field-hint">{{ editLocked ? $t('lottery.adminEditLiveLockHint') : $t('lottery.adminActivityKindHint') }}</small>
              </label>
              <label>
                <span>{{ $t('lottery.adminParticipationMode') }}</span>
                <select v-model="form.participationMode" :disabled="editLocked" @change="handleParticipationModeChange">
                  <option v-for="opt in participationModeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
                <small v-if="editLocked" class="field-hint">{{ $t('lottery.adminEditLiveLockHint') }}</small>
              </label>
              <!-- 只读摘要：模板/默认体验可见，完整 13 项在高级配置中改，避免主路径术语墙 -->
              <p class="experience-summary" role="status">
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
                <!-- 编辑已设密码的活动：留空 = 保持不变（后端 PATCH 空串跳过、null 清空），避免运营误以为密码丢了 -->
                <small v-if="editingHasAccessPassword" class="field-hint password-keep-hint" role="status">{{ $t('lottery.adminPasswordKeepHint') }}</small>
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
              <!-- 折叠态摘要（2026-08 体验优化）：运营不展开也能一眼看到该活动已启用了哪些增长/导流/秒杀配置，
                   避免「折叠后无法感知配置状态」——编辑已有活动/复盘时尤其重要。 -->
              <div
                v-if="!showAdvancedGrowth && advancedConfigSummary.length"
                class="form-advanced-summary"
                role="note"
                aria-label="已启用配置"
              >
                <span
                  v-for="chip in advancedConfigSummary"
                  :key="chip"
                  class="form-advanced-chip"
                >{{ chip }}</span>
              </div>
            </header>
            <div v-show="showAdvancedGrowth" id="lottery-advanced-body" class="form-advanced-body">
              <!-- 体验类型：模板已带默认值；完整列表仅在此修改（055a 断点 C）；docs/145 按模板收口 -->
              <section
                v-if="editorVisibility.experienceType"
                class="form-section form-section--nested"
                aria-labelledby="lottery-experience"
              >
                <header class="form-section-head">
                  <h4 id="lottery-experience" class="form-section-title">{{ $t('lottery.adminExperienceType') }}</h4>
                  <p class="form-section-desc">{{ $t('lottery.adminExperienceAdvancedDesc') }}</p>
                </header>
                <div class="form-grid two-cols">
                  <!-- 体验 + 壳策略两列并排（2026-08 紧凑化）：两个下拉不再各占满行 -->
                  <label :class="showPrizeShellSelector ? '' : 'field-span-2'">
                    <span>{{ $t('lottery.adminExperienceType') }}</span>
                    <select v-model="form.experienceType" :disabled="editLocked" @change="handleExperienceChange">
                      <option value="wheel" :disabled="form.activityKind !== 'lottery'">{{ $t('lottery.adminExpWheel') }}</option>
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
                      <option value="flash_sale">{{ $t('lottery.adminExpFlashSale') }}</option>
                      <option value="grid">{{ $t('lottery.adminExpGrid') }}</option>
                      <option value="submit">{{ $t('lottery.adminExpSubmit') }}</option>
                    </select>
                    <small class="field-hint">{{ $t('lottery.adminExperienceHint') }}</small>
                  </label>
                  <!-- 壳策略（lottery 时与体验同行；非 lottery 体验 select 自动占满行） -->
                  <label v-if="showPrizeShellSelector">
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
                </div>
              </section>

              <!--
                游戏壳奖品展示（docs/128）：
                delayed 默认扇面=仪式短语；instant 默认真奖名。
                与 experienceType 解耦：同一转盘可换「壳文案策略」。
              -->
              <section
                v-if="form.activityKind === 'lottery' && editorVisibility.prizeShell"
                class="form-section form-section--nested"
                aria-labelledby="lottery-prize-shell"
              >
                <header class="form-section-head">
                  <h4 id="lottery-prize-shell" class="form-section-title">{{ $t('lottery.adminPrizeShellSection') }}</h4>
                  <p class="form-section-desc">{{ $t('lottery.adminPrizeShellSectionDesc') }}</p>
                </header>
                <div class="form-grid two-cols">
                  <!-- 壳策略下拉已并入「体验类型」section 与体验同行（2026-08 紧凑化），此处只留仪式短语 -->
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

              <!-- 秒杀壳配置（docs/130/131）：默认展示/导流；paymentRequired=true 时走 cf-lottery 直付发卡；docs/145 不可见时隐藏 -->
              <section v-if="editorVisibility.flashSale" class="form-section form-section--nested" aria-labelledby="lottery-flash-sale">
                <header class="form-section-head">
                  <h4 id="lottery-flash-sale" class="form-section-title">{{ $t('lottery.adminFlashSaleSection') }}</h4>
                  <p class="form-section-desc">{{ $t('lottery.adminFlashSaleSectionDesc') }}</p>
                </header>
                <div class="form-grid two-cols">
                  <!-- 开关 + 场次文案同排（2026-08 紧凑化）：秒杀开关不再占满行 -->
                  <div class="field-span-2 toggle-with-param">
                    <label class="checkbox-label-inline">
                      <input v-model="form.enableFlashSale" type="checkbox" />
                      <span>{{ $t('lottery.adminEnableFlashSale') }}</span>
                    </label>
                    <label v-if="form.enableFlashSale" class="param-inline flash-session-param">
                      <span>{{ $t('lottery.adminFlashSaleSessionLabel') }}</span>
                      <input v-model="form.flashSaleSessionLabel" maxlength="32" :placeholder="$t('lottery.adminFlashSaleSessionPlaceholder')" />
                    </label>
                  </div>
                  <template v-if="form.enableFlashSale">
                    <div class="field-span-2 flash-sale-core-fields">
                      <label>
                        <span>{{ $t('lottery.adminFlashSaleCtaLabel') }}</span>
                        <input v-model="form.flashSaleCtaLabel" maxlength="12" placeholder="抢" />
                      </label>
                      <label>
                        <span>{{ $t('lottery.adminFlashSaleStockLimit') }}</span>
                        <input v-model.number="form.flashSaleStockLimit" type="number" min="1" max="1000000" :placeholder="$t('lottery.adminFlashSaleStockPlaceholder')" />
                        <small class="field-hint">{{ $t('lottery.adminFlashSaleStockHint') }}</small>
                      </label>
                      <label v-if="form.flashSaleSalesMode !== 'redirect'">
                        <span>{{ $t('lottery.adminFlashSaleMaxPerUser') }}</span>
                        <input v-model.number="form.flashSaleMaxPerUser" type="number" min="1" max="100" />
                      </label>
                    </div>
                    <div class="field-span-2">
                      <span class="field-label-text">{{ $t('lottery.adminFlashSaleSalesMode') }}</span>
                      <div class="sales-mode-options">
                        <label class="radio-label-inline">
                          <input v-model="form.flashSaleSalesMode" type="radio" value="redirect" @change="handleFlashSaleSalesModeChange" />
                          <span>{{ $t('lottery.adminFlashSaleModeRedirect') }}</span>
                        </label>
                        <label class="radio-label-inline">
                          <input v-model="form.flashSaleSalesMode" type="radio" value="direct_single" @change="handleFlashSaleSalesModeChange" />
                          <span>{{ $t('lottery.adminFlashSaleModeDirectSingle') }}</span>
                        </label>
                        <label class="radio-label-inline">
                          <input v-model="form.flashSaleSalesMode" type="radio" value="direct_bulk" @change="handleFlashSaleSalesModeChange" />
                          <span>{{ $t('lottery.adminFlashSaleModeDirectBulk') }}</span>
                        </label>
                      </div>
                    </div>
                    <!-- 3c：lottery + 直付秒杀 组合不硬阻断（后端发布预检会拒），但内联提示避免运营保存必拒组合 -->
                    <p
                      v-if="form.activityKind === 'lottery' && form.flashSaleSalesMode !== 'redirect'"
                      class="field-span-2 flash-sale-warn-inline"
                      role="alert"
                    >{{ $t('lottery.adminFlashSaleLotteryConflict') }}</p>
                    <template v-if="form.flashSaleSalesMode !== 'redirect'">
                      <div class="field-span-2 flash-sale-checklist" aria-live="polite">
                        <div class="flash-sale-checklist-head">
                          <strong>{{ $t('lottery.adminFlashSaleDirectChecklistTitle') }}</strong>
                          <span>{{ $t('lottery.adminFlashSaleDirectChecklistDesc') }}</span>
                        </div>
                        <ul>
                          <li
                            v-for="item in flashSaleDirectChecklist"
                            :key="item.key"
                            :class="{ done: item.done && !item.error, error: item.error }"
                          >
                            <span class="check-dot">{{ item.error ? '✕' : (item.done ? '✓' : '!') }}</span>
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
                      <template v-if="form.flashSaleSalesMode === 'direct_bulk'">
                        <div class="field-span-2 flash-sale-tier-editor">
                          <div class="flash-sale-tier-editor__head">
                            <span>{{ $t('lottery.adminFlashSalePricingTiers') }}</span>
                            <button type="button" class="btn btn-ghost btn-xs" :disabled="form.flashSalePricingTiers.length >= 8" @click="addFlashSalePricingTier">
                              {{ $t('lottery.adminFlashSaleAddPricingTier') }}
                            </button>
                          </div>
                          <div v-if="form.flashSalePricingTiers.length" class="flash-sale-tier-list">
                            <div v-for="(tier, idx) in form.flashSalePricingTiers" :key="idx" class="flash-sale-tier-row">
                              <label>
                                <span>{{ $t('lottery.adminFlashSaleTierMinQuantity') }}</span>
                                <input v-model.number="tier.minQuantity" type="number" min="1" :max="form.flashSaleMaxPerUser || 100" />
                              </label>
                              <label>
                                <span>{{ $t('lottery.adminFlashSaleTierUnitPriceYuan') }}</span>
                                <input :value="flashSaleTierPriceYuan(idx)" type="number" min="0.01" step="0.01" max="1000000" @input="onFlashSaleTierPriceInput(idx, $event)" />
                              </label>
                              <label>
                                <span>{{ $t('lottery.adminFlashSaleTierLabel') }}</span>
                                <input v-model="tier.label" maxlength="32" :placeholder="$t('lottery.adminFlashSaleTierLabelPlaceholder')" />
                              </label>
                              <button type="button" class="btn btn-ghost btn-xs" :disabled="form.flashSalePricingTiers.length <= 1" @click="removeFlashSalePricingTier(idx)">{{ $t('lottery.adminFlashSaleRemovePricingTier') }}</button>
                            </div>
                          </div>
                        </div>
                        <small class="field-hint">{{ $t('lottery.adminFlashSalePricingTierHint') }}</small>
                      </template>
                      <div class="field-span-2 flash-sale-payment-fields">
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
                        <label>
                          <span>{{ $t('lottery.adminFlashSalePaymentTitle') }}</span>
                          <input v-model="form.flashSaleTitle" maxlength="100" />
                        </label>
                        <label class="field-span-2">
                          <span>{{ $t('lottery.adminFlashSaleImageUrl') }}</span>
                          <input v-model="form.flashSaleImageUrl" type="url" :placeholder="$t('lottery.adminFlashSaleImagePlaceholder')" />
                        </label>
                      </div>
                    </template>
                    <!-- docs/222 P0 预览区：展示最终生效值（可售件数/限购/价格/阶梯/支付方式） -->
                    <div v-if="form.enableFlashSale" class="field-span-2 flash-sale-preview" role="note">
                      <strong>{{ $t('lottery.adminFlashSalePreviewTitle') }}</strong>
                      <div class="flash-sale-preview-grid">
                        <span class="preview-item">
                          <span class="preview-label">{{ $t('lottery.adminFlashSalePreviewStock') }}</span>
                          <span class="preview-value">{{ form.flashSaleStockLimit || form.maxParticipants || $t('lottery.adminFlashSalePreviewUnlimited') }}{{ $t('lottery.adminFlashSalePreviewUnit') }}</span>
                        </span>
                        <span class="preview-item">
                          <span class="preview-label">{{ $t('lottery.adminFlashSalePreviewMaxPerUser') }}</span>
                          <span class="preview-value">{{ form.flashSaleMaxPerUser }}{{ $t('lottery.adminFlashSalePreviewUnit') }}</span>
                        </span>
                        <span v-if="form.flashSaleSalesMode !== 'redirect'" class="preview-item">
                          <span class="preview-label">{{ $t('lottery.adminFlashSalePreviewPrice') }}</span>
                          <span class="preview-value">{{ flashSalePriceYuan || '—' }}{{ $t('lottery.adminCurrencyUnit') }}</span>
                        </span>
                        <span v-if="form.flashSaleSalesMode === 'direct_bulk' && form.flashSalePricingTiers.length > 0" class="preview-item preview-item-full">
                          <span class="preview-label">{{ $t('lottery.adminFlashSalePreviewTiers') }}</span>
                          <span class="preview-value">{{ form.flashSalePricingTiers.map((t, idx) => `${t.minQuantity}${$t('lottery.adminFlashSalePreviewUnit')} ${flashSaleTierPriceYuan(idx) || '—'}${$t('lottery.adminCurrencyUnit')}`).join('; ') }}</span>
                        </span>
                        <span class="preview-item">
                          <span class="preview-label">{{ $t('lottery.adminFlashSalePreviewPayment') }}</span>
                          <span class="preview-value">{{ form.flashSaleSalesMode === 'redirect' ? $t('lottery.adminFlashSaleModeRedirect') : (form.flashSaleSalesMode === 'direct_single' ? $t('lottery.adminFlashSaleModeDirectSingle') : $t('lottery.adminFlashSaleModeDirectBulk')) }}</span>
                        </span>
                      </div>
                    </div>
                    <!-- 三个展示开关同排（2026-08 打磨）：不各自占行 -->
                    <div class="field-span-2 flash-sale-show-row">
                      <label class="checkbox-label-inline">
                        <input v-model="form.flashSaleShowCountdown" type="checkbox" />
                        <span>{{ $t('lottery.adminFlashSaleShowCountdown') }}</span>
                      </label>
                      <label class="checkbox-label-inline">
                        <input v-model="form.flashSaleShowProgress" type="checkbox" />
                        <span>{{ $t('lottery.adminFlashSaleShowProgress') }}</span>
                      </label>
                      <label class="checkbox-label-inline">
                        <input v-model="form.flashSaleShowStock" type="checkbox" />
                        <span>{{ $t('lottery.adminFlashSaleShowStock') }}</span>
                      </label>
                    </div>
                    <p class="field-span-2 field-hint">{{ $t('lottery.adminFlashSaleShopHint') }}</p>
                  </template>
                </div>
              </section>

              <!-- 导流配置：关联商品推广 -->
              <section v-if="editorVisibility.productLink" class="form-section form-section--nested" aria-labelledby="lottery-traffic">
                <header class="form-section-head">
                  <h4 id="lottery-traffic" class="form-section-title">{{ $t('lottery.adminTrafficSection') }}</h4>
                  <p class="form-section-desc">{{ $t('lottery.adminTrafficSectionDesc') }}</p>
                </header>
                <div class="form-grid two-cols">
                  <!-- 开关 + 商品链接同排（2026-08 紧凑化）：不再「开关整行 + 链接另起一行」 -->
                  <div class="field-span-2 toggle-with-param">
                    <label class="checkbox-label-inline">
                      <input v-model="form.enableProductLink" type="checkbox" />
                      <span>{{ $t('lottery.adminEnableProductLink') }}</span>
                    </label>
                    <label v-if="form.enableProductLink" class="param-inline product-link-param">
                      <span>{{ $t('lottery.adminProductLink') }}</span>
                      <input v-model="form.productLink.url" type="url" placeholder="https://shop.example.com/product/123" />
                    </label>
                  </div>
                  <template v-if="form.enableProductLink">
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
              <section v-if="editorVisibility.viral" class="form-section form-section--nested" aria-labelledby="lottery-viral">
                <header class="form-section-head">
                  <h4 id="lottery-viral" class="form-section-title">
                    {{ form.activityKind === 'claim' ? $t('lottery.adminSocialSection') : $t('lottery.adminViralSection') }}
                  </h4>
                  <p class="form-section-desc">
                    {{ form.activityKind === 'claim' ? $t('lottery.adminSocialSectionDesc') : $t('lottery.adminViralSectionDesc') }}
                  </p>
                </header>
                <div class="form-grid two-cols">
                  <!-- 开关并排（2026-08 紧凑化）：裂变总开关 + 邀请排行榜开关同行，不再各占满行 -->
                  <label :class="form.enableViral ? '' : 'field-span-2'">
                    <input v-model="form.enableViral" type="checkbox" class="checkbox-inline" />
                    <span>{{ form.activityKind === 'claim' ? $t('lottery.adminEnableSocial') : $t('lottery.adminEnableViral') }}</span>
                  </label>
                  <label v-if="form.enableViral" class="checkbox-label-inline-with-hint">
                    <input v-model="form.viralLeaderboardEnabled" type="checkbox" class="checkbox-inline" />
                    <span>{{ $t('lottery.adminViralLeaderboard') }}</span>
                    <small class="checkbox-hint-inline">{{ $t('lottery.adminViralLeaderboardHint') }}</small>
                  </label>
                  <template v-if="form.enableViral">
                    <!-- 邀请加次/加权参数仅对抽奖（lottery）有意义（instant 加 spins / delayed 加权开奖）；
                         接龙/问卷/投票/签到/审批/预约等类型无 spins 与开奖加权语义，
                         只保留「邀请排行榜」传播能力（publish-check 同步仅 lottery 校验数值）。 -->
                    <template v-if="form.activityKind === 'lottery'">
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
                    </template>

                  </template>
                </div>
                <!-- docs/218 增长玩法：保底 / 每日免费 / 排行榜奖励（仅即时开奖） -->
                <template v-if="form.resultMode === 'instant' && form.activityKind === 'lottery'">
                  <div class="form-grid two-cols">
                    <!-- 开关+参数同排（2026-08 打磨）：保底/每日免费不再「开关整行 + 参数单列半空」 -->
                    <div class="field-span-2 toggle-with-param">
                      <label class="checkbox-label-inline">
                        <input v-model="form.enablePity" type="checkbox" />
                        <span>{{ $t('lottery.adminPity') }}</span>
                      </label>
                      <label v-if="form.enablePity" class="param-inline">
                        <span>{{ $t('lottery.adminPityThreshold') }}</span>
                        <input v-model.number="form.pityThreshold" type="number" min="2" max="100" />
                        <small>{{ $t('lottery.adminPityThresholdSuffix') }}</small>
                      </label>
                    </div>
                    <p v-if="form.enablePity" class="field-span-2 field-hint">{{ $t('lottery.adminPityHint') }}</p>
                    <div class="field-span-2 toggle-with-param">
                      <label class="checkbox-label-inline">
                        <input v-model="form.enableDailyFreeSpins" type="checkbox" />
                        <span>{{ $t('lottery.adminDailyFree') }}</span>
                      </label>
                      <label v-if="form.enableDailyFreeSpins" class="param-inline">
                        <span>{{ $t('lottery.adminDailyFreeCount') }}</span>
                        <input v-model.number="form.dailyFreeSpinsCount" type="number" min="1" max="10" />
                        <small>{{ $t('lottery.adminDailyFreeCountSuffix') }}</small>
                      </label>
                    </div>
                    <p v-if="form.enableDailyFreeSpins" class="field-span-2 field-hint">{{ $t('lottery.adminDailyFreeHint') }}</p>
                    <label class="field-span-2">
                      <span>{{ $t('lottery.adminLeaderboardRewards') }}</span>
                      <textarea v-model="form.leaderboardRewardsText" rows="3" :placeholder="$t('lottery.adminLeaderboardRewardsPlaceholder')"></textarea>
                      <small>{{ $t('lottery.adminLeaderboardRewardsHint') }}</small>
                    </label>
                    <!-- docs/250/254 引擎推荐奖励：支持 bonus_spin / bonus_coupon 双出口（行编辑器，docs/255 ③），
                         旧 referralRewards 里程碑 textarea 已收敛删除（docs/255 P1-2） -->
                    <label class="field-span-2">
                      <span>{{ $t('lottery.adminReferralRewardDefs') }}</span>
                      <div class="referral-def-rows">
                        <div
                          v-for="(row, ri) in referralRewardDefsRows"
                          :key="ri"
                          class="referral-def-row"
                        >
                          <input
                            v-model.number="row.requireCount"
                            type="number" min="1" max="100"
                            class="input input-sm referral-def-count"
                            :placeholder="$t('lottery.adminReferralRewardDefsCount')"
                            @change="onReferralRewardDefRowChange"
                          />
                          <select
                            v-model="row.rewardExit"
                            class="input input-sm referral-def-exit"
                            @change="onReferralRewardDefRowChange"
                          >
                            <option value="bonus_spin">{{ $t('lottery.adminReferralRewardDefsSpin') }}</option>
                            <option value="bonus_coupon">{{ $t('lottery.adminReferralRewardDefsCoupon') }}</option>
                          </select>
                          <input
                            v-model.number="row.rewardValue"
                            type="number" min="1" max="1000"
                            class="input input-sm referral-def-value"
                            :placeholder="$t('lottery.adminReferralRewardDefsValue')"
                            @change="onReferralRewardDefRowChange"
                          />
                          <small v-if="Number(row.rewardValue || 0) < 1" class="field-hint field-hint--warn">{{ $t('lottery.adminReferralRewardDefsValueWarning') }}</small>
                          <input
                            v-if="row.rewardExit === 'bonus_coupon'"
                            v-model="row.couponLabel"
                            type="text"
                            class="input input-sm referral-def-label"
                            :placeholder="$t('lottery.adminReferralRewardDefsLabel')"
                            @change="onReferralRewardDefRowChange"
                          />
                          <button
                            type="button"
                            class="btn btn-ghost btn-sm referral-def-remove"
                            :aria-label="$t('lottery.adminReferralRewardDefsRemove')"
                            @click="removeReferralRewardDefRow(ri)"
                          >✕</button>
                        </div>
                        <button
                          type="button"
                          class="btn btn-ghost btn-sm"
                          @click="addReferralRewardDefRow"
                        >+ {{ $t('lottery.adminReferralRewardDefsAdd') }}</button>
                      </div>
                      <small>{{ $t('lottery.adminReferralRewardDefsHint') }}</small>
                    </label>
                  </div>
                </template>
              </section>

              <!-- 多状态 CTA 承接：中奖/未中奖不同导流 -->
              <section v-if="editorVisibility.cta" class="form-section form-section--nested" aria-labelledby="lottery-ctas">
                <header class="form-section-head">
                  <h4 id="lottery-ctas" class="form-section-title">{{ $t('lottery.adminCtaSection') }}</h4>
                  <p class="form-section-desc">{{ $t('lottery.adminCtaSectionDesc') }}</p>
                </header>
                <div class="form-grid two-cols">
                  <label class="checkbox-label-inline-with-hint">
                    <input v-model="form.enableAfterWinCta" type="checkbox" class="checkbox-inline" />
                    <span>{{ $t('lottery.adminAfterWinCta') }}</span>
                    <small class="checkbox-hint-inline">{{ $t('lottery.adminAfterWinCtaHint') }}</small>
                  </label>
                  <template v-if="form.enableAfterWinCta">
                    <!-- url 与按钮文案同排（2026-08 打磨）：消除标题列半空；url 需全宽时在窄屏自动换行 -->
                    <label><span>{{ $t('lottery.adminCtaUrl') }}</span><input v-model="form.afterWinCtaUrl" type="url" placeholder="https://..." /></label>
                    <label><span>{{ $t('lottery.adminCtaTitle') }}</span><input v-model="form.afterWinCtaTitle" maxlength="60" :placeholder="$t('lottery.adminAfterWinCtaTitlePlaceholder')" /></label>
                  </template>
                  <label class="checkbox-label-inline-with-hint">
                    <input v-model="form.enableAfterLossCta" type="checkbox" class="checkbox-inline" />
                    <span>{{ $t('lottery.adminAfterLossCta') }}</span>
                    <small class="checkbox-hint-inline">{{ $t('lottery.adminAfterLossCtaHint') }}</small>
                  </label>
                  <template v-if="form.enableAfterLossCta">
                    <label><span>{{ $t('lottery.adminCtaUrl') }}</span><input v-model="form.afterLossCtaUrl" type="url" placeholder="https://..." /></label>
                    <label><span>{{ $t('lottery.adminCtaTitle') }}</span><input v-model="form.afterLossCtaTitle" maxlength="60" :placeholder="$t('lottery.adminAfterLossCtaTitlePlaceholder')" /></label>
                  </template>
                </div>
              </section>

              <!-- 未中奖自动发券：次要承接，默认不在主路径（仅抽奖） -->
              <section
                v-if="form.activityKind === 'lottery' && editorVisibility.loserReward"
                class="form-section form-section--nested"
                aria-labelledby="lottery-loserreward"
              >
                <header class="form-section-head">
                  <h4 id="lottery-loserreward" class="form-section-title">{{ $t('lottery.adminLoserRewardSection') }}</h4>
                  <p class="form-section-desc">{{ $t('lottery.adminLoserRewardDesc') }}</p>
                </header>
                <div class="form-grid two-cols">
                  <!-- 发券开关 + 券文案同排（2026-08 紧凑化）：off/on 小 select 不再占满行 -->
                  <div class="field-span-2 toggle-with-param">
                    <label>
                      <span>{{ $t('lottery.adminLoserRewardLabel') }}</span>
                      <select v-model="loserRewardEnabled" @change="syncLoserReward">
                        <option :value="false">{{ $t('lottery.adminOff') }}</option>
                        <option :value="true">{{ $t('lottery.adminOn') }}</option>
                      </select>
                    </label>
                    <label v-if="loserRewardEnabled" class="param-inline loser-coupon-param">
                      <span>{{ $t('lottery.adminCouponLabel') }}</span>
                      <input v-model="loserRewardCouponLabel" maxlength="50" :placeholder="$t('lottery.adminCouponLabelPlaceholder')" @change="syncLoserReward" />
                    </label>
                  </div>
                  <p class="field-span-2 field-hint">{{ $t('lottery.adminLoserRewardHint') }} {{ $t('lottery.adminCouponLabelHint') }}</p>
                </div>
              </section>

              <!-- 邀请奖励配置（docs/259 P1-3）：每邀请金额 / 货币 / 配额 -->
              <section
                v-if="form.activityKind === 'lottery'"
                class="form-section form-section--nested"
                aria-labelledby="lottery-reward-config"
              >
                <header class="form-section-head">
                  <h4 id="lottery-reward-config" class="form-section-title">{{ $t('lottery.adminRewardConfigSection') }}</h4>
                  <p class="form-section-desc">{{ $t('lottery.adminRewardConfigDesc') }}</p>
                </header>
                <div class="form-grid two-cols">
                  <label>
                    <span>{{ $t('lottery.adminRewardPerInviteAmount') }}</span>
                    <input v-model.number="rewardPerInviteAmount" type="number" min="0" max="10000" step="1" />
                    <small>{{ $t('lottery.adminRewardPerInviteAmountSuffix') }}</small>
                    <small v-if="Number(rewardPerInviteAmount || 0) === 0" class="field-hint field-hint--warn">{{ $t('lottery.adminRewardPerInviteAmountWarning') }}</small>
                  </label>
                  <label>
                    <span>{{ $t('lottery.adminRewardCurrency') }}</span>
                    <input v-model="rewardCurrency" maxlength="10" placeholder="USD" />
                  </label>
                  <label>
                    <span>{{ $t('lottery.adminRewardPerUserPerDay') }}</span>
                    <input v-model.number="rewardPerUserPerDay" type="number" min="0" max="1000" step="1" />
                    <small>{{ $t('lottery.adminRewardQuotaSuffix') }}</small>
                  </label>
                  <label>
                    <span>{{ $t('lottery.adminRewardGlobalPerDay') }}</span>
                    <input v-model.number="rewardGlobalPerDay" type="number" min="0" max="10000" step="1" />
                    <small>{{ $t('lottery.adminRewardQuotaSuffix') }}</small>
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
              <!-- 字段可折叠（2026-08 打磨）：字段多时减少滚动；label/类型常显保证核心必填可见，
                   详情（长度/必填/选项）收起；新字段自动展开 -->
              <div
                v-for="(field, index) in form.activityConfig.fields"
                :key="field.id"
                class="activity-config-row"
                :class="{ 'is-collapsed': isSurveyFieldCollapsed(field.id) }"
              >
                <div class="survey-field-head">
                  <div class="form-grid two-cols survey-field-main">
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
                  </div>
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs survey-field-toggle"
                    :aria-expanded="!isSurveyFieldCollapsed(field.id)"
                    @click="toggleSurveyField(field.id)"
                  >
                    {{ isSurveyFieldCollapsed(field.id) ? $t('lottery.adminSurveyFieldExpand') : $t('lottery.adminSurveyFieldCollapse') }}
                  </button>
                </div>
                <div v-show="!isSurveyFieldCollapsed(field.id)" class="survey-field-detail">
                  <div class="form-grid two-cols">
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
              <div v-if="editorVisibility.tiers && needsTiersActivity(form.activityKind, form.experienceType || '')" class="field-span-2">
                <span class="field-label-text">{{ $t(tierCopy.config) }}</span>
                <!-- 奖项配置表头（docs/206）：与阶梯价对齐，让运营者清楚每列含义 -->
                <div v-if="form.tiers.length > 0" class="tier-header" :class="{ 'tier-grid--instant': form.resultMode === 'instant' }">
                  <span class="tier-header-prize">{{ $t(tierCopy.prize) }}</span>
                  <span class="tier-header-name">{{ $t(tierCopy.name) }}</span>
                  <span class="tier-header-count">{{ $t(tierCopy.count) }}</span>
                  <template v-if="form.resultMode === 'instant'">
                    <span class="tier-header-count">{{ $t(tierCopy.weight) }}</span>
                    <span class="tier-header-probability">{{ $t(tierCopy.probability) }}</span>
                  </template>
                  <span class="tier-header-actions"></span>
                </div>
                <div class="tier-list">
                  <div v-for="(tier, idx) in form.tiers" :key="idx" class="tier-row" :class="{ 'tier-grid--instant': form.resultMode === 'instant' }">
                    <!-- docs/225 P0：服务端搜索选择器替换原生下拉框（避免只看到前 50 个奖品） -->
                    <div class="tier-prize-picker">
                      <template v-if="tierPrizeSummary(tier)">
                        <div class="tier-prize-summary" :class="{ 'is-inactive': !tierPrizeSummary(tier)!.active }">
                          <span class="tier-prize-name">{{ tierPrizeSummary(tier)!.name }}</span>
                          <span v-if="tierPrizeSummary(tier)!.valueText" class="tier-prize-value">{{ tierPrizeSummary(tier)!.valueText }}</span>
                          <span v-if="tierPrizeSummary(tier)!.availableCount != null" class="tier-prize-stock">{{ $t('lottery.adminPrizeAvailable', { n: tierPrizeSummary(tier)!.availableCount }) }}</span>
                          <span v-if="!tierPrizeSummary(tier)!.active" class="tier-prize-inactive">{{ $t('lottery.adminPrizeInactive') }}</span>
                        </div>
                      </template>
                      <button type="button" class="btn btn-ghost btn-xs" :disabled="creating" @click="openPrizePicker(idx, $event)">
                        {{ tierPrizeSummary(tier) ? $t(tierCopy.changePrize) : $t(tierCopy.selectPrize) }}
                      </button>
                    </div>
                    <input v-model="tier.tierName" class="tier-name" :placeholder="$t(tierCopy.namePlaceholder)" maxlength="50" />
                    <!-- docs/239 方案 B：直付批发模式的「可售份数」为只读——由卡密库存决定（预检自动校验
                         available ≥ stockLimit），不接受运营输入，消除「可售份数≠截单名额」的误导。 -->
                    <input
                      v-if="isDirectBulkFlashSale"
                      class="tier-count"
                      type="text"
                      :value="tierPrizeSummary(tier)?.availableCount != null ? `${tierPrizeSummary(tier)!.availableCount} 张` : '—'"
                      disabled
                      :title="$t('lottery.adminWholesaleStockReadonlyHint')"
                    />
                    <input
                      v-else
                      v-model.number="tier.winnerCount"
                      type="number"
                      class="tier-count"
                      min="1"
                      max="1000"
                      :placeholder="$t(tierCopy.countPlaceholder)"
                    />
                    <input
                      v-if="form.resultMode === 'instant'"
                      v-model.number="tier.weight"
                      type="number"
                      class="tier-count"
                      min="0"
                      :max="MAX_TIER_WEIGHT"
                      :placeholder="$t(tierCopy.weightPlaceholder)"
                      :title="$t(tierCopy.weightHint)"
                    />
                    <span
                      v-if="form.resultMode === 'instant'"
                      class="tier-probability"
                      :class="{ 'is-zero': tierProbabilities[idx]?.weight === 0 }"
                      :title="$t(tierCopy.probabilityHint)"
                    >
                      <span
                        class="tier-probability-bar"
                        :class="{ 'is-zero': tierProbabilities[idx]?.weight === 0 }"
                        aria-hidden="true"
                      >
                        <span
                          class="tier-probability-bar-fill"
                          :style="{ width: `${Math.max(0, Math.min(100, tierProbabilities[idx]?.percent || 0))}%` }"
                        />
                      </span>
                      {{ $t(tierCopy.probabilityLabel) }} {{ tierProbabilities[idx]?.label || '0%' }}
                    </span>
                    <button type="button" class="btn btn-ghost btn-xs tier-remove" :aria-label="$t('lottery.adminDelete')" :title="$t('lottery.adminDelete')" @click="removeTier(idx)">✕</button>
                  </div>
                  <!-- 奖项名额合计（docs/220 优化）：开奖按各档中奖份数合计发放，与活动「中奖人数」不一致时提前提示 -->
                  <div
                    v-if="tierCountSummary"
                    class="tier-summary"
                    :class="{ 'is-warning': tierCountSummary.match === false }"
                    role="note"
                  >
                    <span>{{ $t('lottery.adminTierTotalWinnerCount', { n: tierCountSummary.total }) }}</span>
                    <span v-if="tierCountSummary.match === false" class="tier-summary-hint">
                      {{ $t('lottery.adminTierWinnerCountMismatch', { m: tierCountSummary.drawWinnerCount }) }}
                    </span>
                  </div>
                  <p
                    v-if="shouldShowTierProbability"
                    class="tier-probability-summary"
                    :class="{ 'is-warning': !hasPositiveTierWeight }"
                  >
                    {{
                      hasPositiveTierWeight
                        ? $t('lottery.adminTierProbabilityHint')
                        : $t('lottery.adminTierProbabilityUnavailable')
                    }}
                  </p>
                  <div class="tier-actions">
                    <button type="button" class="btn btn-ghost btn-xs" :disabled="!canAddTier" @click="addTier">
                      {{ $t(tierCopy.addTier) }}
                    </button>
                    <!-- 始终提供快速创建：无奖品库时是主 CTA（手动履约，可过发布门禁）；有奖品时仍可一键加新奖 -->
                    <button
                      v-if="!isDirectPayFlashSale"
                      type="button"
                      class="btn btn-xs"
                      :class="prizeOptions.length === 0 ? 'btn-primary' : 'btn-ghost'"
                      :disabled="quickPrizeLoading"
                      @click="quickCreatePrize"
                    >
                      {{ quickPrizeLoading ? $t('lottery.adminCreating') : $t(tierCopy.quickCreatePrize) }}
                    </button>
                    <button v-if="prizeOptions.length > 0" type="button" class="btn btn-ghost btn-xs" @click="goToPrizes">
                      {{ $t('lottery.adminManagePrizes') }}
                    </button>
                    <small class="field-hint">
                      {{ prizeOptions.length === 0
                        ? $t(isDirectPayFlashSale ? 'lottery.adminDirectPayEmptyProductHint' : tierCopy.emptyHint)
                        : $t(tierCopy.limitHint) }}
                    </small>
                  </div>
                  <!-- docs/225 P0：服务端搜索奖品选择器面板（Teleport 到 body，避免被 modal 裁剪） -->
                  <Teleport to="body">
                    <div v-if="prizePickerOpen" class="prize-picker-overlay" @click.self="closePrizePicker">
                      <div
                        class="prize-picker-panel"
                        role="dialog"
                        aria-modal="true"
                        :aria-label="$t('lottery.adminSelectPrize')"
                        @keydown.esc.prevent.stop="closePrizePicker"
                      >
                        <div class="prize-picker-head">
                          <input
                            ref="prizePickerSearchInput"
                            v-model="prizeSearchQuery"
                            type="text"
                            :placeholder="$t('lottery.adminSearchPrize')"
                            :aria-label="$t('lottery.adminSearchPrize')"
                            @input="onPrizeSearchInput"
                          />
                          <button type="button" class="btn btn-ghost btn-xs" :aria-label="$t('lottery.adminClose')" :title="$t('lottery.adminClose')" @click="closePrizePicker">✕</button>
                        </div>
                        <div v-if="prizeSearchLoading" class="prize-picker-loading">{{ $t('lottery.loadingText') }}</div>
                        <ul v-else class="prize-picker-list">
                          <li
                            v-for="p in prizeSearchResults"
                            :key="p.id"
                          >
                            <button
                              type="button"
                              class="prize-picker-option"
                              :disabled="p.directSaleConflict === true"
                              @click="selectPrize(p)"
                            >
                              <span class="prize-picker-name">{{ p.name }}</span>
                              <span v-if="p.valueText" class="prize-picker-value">{{ p.valueText }}</span>
                              <span class="prize-picker-type">{{ p.prizeType === 'code' ? $t('lottery.adminPrizeTypeCode') : $t('lottery.adminPrizeTypeManual') }}</span>
                              <span v-if="p.availableCount != null" class="prize-picker-stock">{{ $t('lottery.adminPrizeAvailable', { n: p.availableCount }) }}</span>
                              <span v-if="p.directSaleConflict" class="prize-picker-ineligible">{{ $t('lottery.adminPrizeSharedCodePool') }}</span>
                            </button>
                          </li>
                          <li v-if="prizeSearchResults.length === 0 && !prizeSearchLoading" class="prize-picker-empty">
                            {{ $t('lottery.adminNoPrizeMatch') }}
                          </li>
                        </ul>
                        <div class="prize-picker-pagination">
                          <button type="button" class="btn btn-ghost btn-xs" :disabled="prizeSearchPage === 0" @click="searchPrizes(prizeSearchPage - 1)">
                            {{ $t('lottery.adminPrevPage') }}
                          </button>
                          <span>{{ prizeSearchPage + 1 }} / {{ Math.max(1, Math.ceil(prizeSearchTotal / prizeSearchLimit)) }}</span>
                          <button type="button" class="btn btn-ghost btn-xs" :disabled="(prizeSearchPage + 1) * prizeSearchLimit >= prizeSearchTotal" @click="searchPrizes(prizeSearchPage + 1)">
                            {{ $t('lottery.adminNextPage') }}
                          </button>
                        </div>
                      </div>
                    </div>
                  </Teleport>
                </div>
              </div>
              <label v-if="form.activityKind === 'lottery'">
                <span>{{ $t('lottery.winnerCount') }}</span>
                <input v-model.number="form.winnerCount" type="number" min="1" max="9999" step="1" required />
                <small class="field-hint">{{ $t('lottery.winnerCountHint') }}</small>
              </label>
              <label v-if="form.activityKind === 'lottery' && form.resultMode === 'instant' && editorVisibility.maxSpins">
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
                  :disabled="editLocked || form.enableFlashSale === true"
                  :placeholder="form.enableFlashSale === true ? $t('lottery.adminFlashSaleStockFollowPlaceholder') : $t('lottery.maxParticipantsPlaceholder')"
                />
                <small class="field-hint">{{ form.enableFlashSale === true ? $t('lottery.adminFlashSaleStockFollowHint', { n: form.flashSaleStockLimit || form.maxParticipants || '—' }) : (editLocked ? $t('lottery.adminEditLiveLockHint') : $t('lottery.maxParticipantsHint')) }}</small>
              </label>
              <label>
                <span>{{ $t('lottery.expectedCount') }}</span>
                <input v-model.number="form.expectedParticipants" type="number" min="0" max="999999" step="1" />
                <small class="field-hint">{{ $t('lottery.expectedCountHint') }}</small>
              </label>
              <label class="field-span-2">
                <span>{{ $t('lottery.adminShowWinners') }}</span>
                <label class="checkbox-label checkbox-inline-label">
                  <input v-model="form.showWinners" type="checkbox" />
                  <span>{{ $t('lottery.adminShowWinnersOn') }}</span>
                </label>
                <small class="field-hint">
                  {{ $t('lottery.adminShowWinnersHint') }} {{ $t('lottery.adminLimitHint') }}
                </small>
              </label>
            </div>
          </section>
        </div>

        <div class="lottery-editor-footer modal-actions">
          <p v-if="!isEditing && createReadinessLabel" class="create-readiness" role="status">{{ createReadinessLabel }}</p>
          <span v-else class="lottery-editor-footer-spacer" aria-hidden="true" />
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
      <!-- 加载中：骨架卡（docs/162 P1-A：弹窗先开，必须给反馈，不能空网格） -->
      <div v-if="templatesLoading" class="template-grid" aria-busy="true">
        <div v-for="i in 6" :key="i" class="template-card template-card--skeleton" aria-hidden="true">
          <span class="template-skel-icon" />
          <span class="template-skel-line" />
          <span class="template-skel-line template-skel-line--short" />
        </div>
      </div>
      <!-- 加载失败：诚实提示 + 重试 + 空白创建兜底（恢复 1f8e6a0 丢失的空白入口） -->
      <div
        v-else-if="templatesLoadFailed"
        class="template-load-failed"
        role="alert"
      >
        <p class="template-load-failed-text">{{ $t('lottery.adminTemplatesLoadFailed') }}</p>
        <div class="template-load-failed-actions">
          <button type="button" class="btn btn-primary btn-sm" @click="fetchTemplates">{{ $t('lottery.retry') }}</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="startBlankCreate">{{ $t('lottery.adminTemplateBlankName') }}</button>
        </div>
      </div>
      <!-- 模板网格（docs/162 P1-D / P2-B）：名称/描述按语言解析 + 参数 chips + 末尾空白卡始终可见 -->
      <div v-else class="template-grid">
        <button
          v-for="tpl in templates"
          :key="tpl.id"
          class="template-card"
          @click="applyTemplate(tpl)"
        >
          <span class="template-icon">{{ tpl.icon }}</span>
          <span class="template-name">{{ templateDisplayName(tpl, tplI18n) }}</span>
          <span class="template-desc">{{ templateDisplayDesc(tpl, tplI18n) }}</span>
          <span v-if="templateChips(tpl).length" class="template-chips">
            <span v-for="(chip, ci) in templateChips(tpl)" :key="ci" class="template-chip">{{ $t(chip) }}</span>
          </span>
          <span class="template-category tag" :class="'tag-' + tpl.category">{{ categoryLabel(tpl.category) }}</span>
        </button>
        <!-- docs/162 P1-B：空白创建（1f8e6a0 大重构丢失，CSS .template-card--blank 仍在） -->
        <button
          type="button"
          class="template-card template-card--blank"
          @click="startBlankCreate"
        >
          <span class="template-icon">🆕</span>
          <span class="template-name">{{ $t('lottery.adminTemplateBlankName') }}</span>
          <span class="template-desc">{{ $t('lottery.adminTemplateBlankDesc') }}</span>
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

    <!-- 奖励发放失败记录（docs/259 P1-2） -->
    <AdminModal v-model="showRewardFailuresModal" :title="$t('lottery.adminRewardFailures')" max-width="720px">
      <div v-if="rewardFailuresLoading" class="empty-text">{{ $t('lottery.adminLoading') }}</div>
      <div v-else>
        <div class="toolbar" style="margin-bottom: 12px">
          <div class="filters">
            <div class="notice-card" role="status">
              <div class="notice-card-body">
                <strong>{{ $t('lottery.adminRewardFailuresHint') }}</strong>
              </div>
            </div>
            <!-- P1-2：运营可按 entryId 过滤，指定补发某人的失败记录 -->
            <label style="display:flex;align-items:center;gap:6px;margin-top:8px;font-size:13px;color:var(--tg-hint)">
              {{ $t('lottery.adminEntryId') }}：
              <input
                v-model="reissueEntryId"
                type="text"
                class="form-input"
                style="max-width:260px"
                :placeholder="$t('lottery.adminEntryIdFilterPlaceholder')"
              />
            </label>
          </div>
          <div class="toolbar-actions">
            <button
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="operatingId === rewardFailuresDrawId || rewardFailures.length === 0"
              @click="handleReissueReward(rewardFailuresDrawId, false)"
            >{{ operatingId === rewardFailuresDrawId ? $t('lottery.loadingText') : $t('lottery.adminReissueReward') }}</button>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="operatingId === rewardFailuresDrawId || rewardFailures.length === 0"
              @click="handleReissueReward(rewardFailuresDrawId, true)"
            >{{ operatingId === rewardFailuresDrawId ? $t('lottery.loadingText') : $t('lottery.adminReissueRewardAll') }}</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>{{ $t('lottery.adminCreatedAt') }}</th>
                <th>{{ $t('lottery.adminRefCode') }}</th>
                <th>{{ $t('lottery.adminFailureUser') }}</th>
                <th>{{ $t('lottery.adminEntryId') }}</th>
                <th>{{ $t('lottery.adminPath') }}</th>
                <th>{{ $t('lottery.adminError') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in rewardFailures" :key="item.id">
                <td>{{ formatDate(item.createdAt) }}</td>
                <td>{{ item.refCode || '-' }}</td>
                <td>{{ item.identityDisplay || item.entryId?.slice(0, 8) || '-' }}</td>
                <td class="mono-text" style="font-size: 12px">{{ item.entryId }}</td>
                <td>{{ item.path || '-' }}</td>
                <td class="mono-text" style="max-width: 320px; word-break: break-all">{{ item.error || '-' }}</td>
              </tr>
              <tr v-if="rewardFailures.length === 0">
                <td colspan="6" class="empty-text">{{ $t('lottery.adminNoData') }}</td>
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
      :require-phrase="confirmRequirePhrase"
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
          <!-- 排行榜奖励发放：仅 instant 模式 lottery 活动，且活动已结束（endAt 已过或已开奖）才允许手动触发。
               活动进行中发放会锁定当前排名快照，之后的邀请不再计入（后端端点有同语义校验） -->
          <button
            v-if="expandedActionDraw.activityKind === 'lottery' && expandedActionDraw.resultMode === 'instant' && isDrawEndedForLeaderboard(expandedActionDraw)"
            type="button"
            class="btn btn-ghost btn-xs table-actions-menu-item"
            role="menuitem"
            :disabled="operatingId === expandedActionDraw.id"
            @click="runMoreAction(d => handleGrantLeaderboardRewards(d.id))"
          >{{ operatingId === expandedActionDraw.id ? $t('lottery.loadingText') : $t('lottery.adminGrantLeaderboard') }}</button>
          <!-- 奖励发放失败记录（docs/259 P1-2）；modal 内含补发一条/全部补发按钮，无需单独入口 -->
          <button
            type="button"
            class="btn btn-ghost btn-xs table-actions-menu-item"
            role="menuitem"
            :disabled="operatingId === expandedActionDraw.id"
            @click="runMoreAction(d => openRewardFailuresModal(d.id))"
          >{{ $t('lottery.adminRewardFailures') }}</button>
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

          <!-- ★ P1-3: 未中奖承接看板 —— 安慰券发放与核销 -->
          <div class="analytics-section">
            <h4>{{ $t('lottery.adminConsolationTitle') }}</h4>
            <div class="analytics-grid">
              <div v-for="item in consolationCards" :key="item.key" class="analytics-card">
                <span class="analytics-value">{{ item.value }}</span>
                <span class="analytics-label">{{ item.label }}</span>
              </div>
            </div>
            <div class="analytics-rates">
              <div>
                <span>{{ consolationRedeemRate }}</span>
                <small>{{ $t('lottery.adminConsolationRedeemRate') }}</small>
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
            <template v-else>
              <!-- ★ P0-4: ROI/转化接入引导 —— 空态给出可执行的回传示例（docs/211） -->
              <p class="empty-text">{{ $t('lottery.adminNoConversions') }}</p>
              <div class="analytics-setup-guide">
                <p class="muted-text">{{ $t('lottery.adminConversionSetupHint') }}</p>
                <pre><code>curl -X POST https://{{ $t('lottery.adminApiHost') }}/api/integration/conversions \
  -H "Authorization: Bearer &lt;API_KEY&gt;" \
  -H "Content-Type: application/json" \
  -d '{
    "publicSlug": "{{ analyticsDraw?.publicSlug || 'your-activity-slug' }}",
    "externalEventId": "order_10001",
    "conversionType": "purchase",
    "amountCents": 9900,
    "currency": "CNY",
    "identityType": "email",
    "identityValue": "user@example.com"
  }'</code></pre>
              </div>
            </template>
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

    <!-- 按 ID 批量删除弹窗（方便粘贴测试数据 ID 一键清场，docs/257） -->
    <AdminModal v-model="showDeleteByIdsModal" :title="$t('lottery.adminDeleteByIdsTitle')" max-width="480px" hide-actions>
      <div class="modal-form">
        <textarea
          v-model="deleteByIdsText"
          class="delete-by-ids-input"
          rows="6"
          :placeholder="$t('lottery.adminDeleteByIdsPlaceholder')"
          :aria-label="$t('lottery.adminDeleteByIdsTitle')"
          spellcheck="false"
        ></textarea>
        <p class="delete-by-ids-hint">{{ $t('lottery.adminDeleteByIdsHint') }}</p>
        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" type="button" @click="showDeleteByIdsModal = false">{{ $t('lottery.adminCancel') }}</button>
          <button
            class="btn btn-danger btn-sm"
            type="button"
            :disabled="!deleteByIdsParsed.length || deletingByIds"
            @click="handleDeleteByIds"
          >{{ deletingByIds ? $t('lottery.loadingText') : $t('lottery.adminDeleteByIdsConfirm') }}</button>
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
import { readAdminToken } from '@/composables/useAdminAuth'
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
  PublishCheckResult,
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
  grantLeaderboardRewards,
  reissueReward,
  fetchRewardFailures,
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
import {
  buildPromotionConfigPayload,
  growthFieldsFromDraw,
  inferFlashSaleSalesMode,
  sanitizeRitualPhrasesForSave,
  parseReferralRewardDefsText,
  formatReferralRewardDefRows,
  sanitizeCouponLabel,
  type ReferralRewardDefEntry,
} from './lottery/growth-config'
import {
  MAX_TIER_WEIGHT,
  buildTierProbabilities,
  normalizeTierWeight,
  buildTierWinnerCountSummary,
} from './lottery/tier-probability'
import {
  isFieldScopedTemplate,
  resolveEditorFieldVisibility,
  shouldAutoExpandAdvancedForTemplate,
} from './lottery/template-field-visibility'
import {
  templateChips,
  templateDisplayDesc,
  templateDisplayHints,
  templateDisplayName,
  type TemplateI18nSource,
} from './lottery/template-i18n'
import {
  buildLotteryDrawConfirmMessage,
  buildLotteryDuplicateDraft as buildLotteryDuplicateDraftRaw,
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
  isFlashSaleApplicable,
  winnersPollSettleKind,
  formatLotteryEntryProgress,
  formatLotteryVisibilityLabel,
  formatPublishCheckItems as formatPublishCheckItemsRaw,
  needsTiersActivity,
  needsTiersMandatory,
  maxTierRowsForSalesMode,
  publishFixSectionTargetId,
  resolveLotteryScheduleFields,
  statusClass,
} from './lottery/ops-utils'
import { usePosterQr } from './lottery/usePosterQr'
import { useDrawAnalytics } from './lottery/useDrawAnalytics'


const { t, locale, te, tm } = useI18n()

/**
 * 模板文案 i18n 适配器（docs/162 P1-D）：
 * 以结构子集注入纯函数 template-i18n.ts，模板名/描述/要点按当前语言解析，
 * key 缺失时回退 API 中文（后端新模板无需等前端发版）。
 */
const tplI18n: TemplateI18nSource = {
  t: (key) => t(key),
  te: (key) => te(key),
  tm: (key) => tm(key),
}
const route = useRoute()
const router = useRouter()
const { showToast } = useToast()
useAdminAuth()
const {
  confirmVisible,
  confirmMessage,
  confirmOptionDefs,
  confirmOptionValues,
  confirmRequirePhrase,
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

/**
 * 草稿保存后只检查当前活动一次，把服务端事实（支付凭据、码池占用、可用卡密等）前移到列表。
 * 不在 loadData 中批量请求，避免列表 N+1；正式发布仍会重新检查，防止保存后库存或渠道状态变化。
 */
async function refreshDraftPublishBlocker(drawId: string): Promise<PublishCheckResult | null> {
  try {
    const check = await fetchPublishCheck(drawId)
    if (check.canPublish) clearDraftPublishBlocker(drawId)
    else setDraftPublishBlocker(drawId, check.errors[0]?.message)
    return check
  } catch {
    // 保存已成功时，预检暂时不可用不能伪装成保存失败；用户点击发布仍会得到服务端最终裁决。
    return null
  }
}

function showSavedDraftPublishIssues(check: PublishCheckResult | null) {
  if (!check || check.canPublish || check.errors.length === 0) return
  showToast(formatPublishCheckItems(check.errors, t('lottery.adminPublishErrorsPrefix')), 'info')
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

/**
 * 高级区折叠摘要（2026-08 体验优化）：列出已启用的配置块标签。
 * 基于表单当前状态实时计算（与保存 payload 同源字段），折叠时展示在高级区标题下，
 * 让运营不展开也能感知「这个活动配了什么」（裂变/保底/每日免费/里程碑/排行榜/秒杀/CTA/发券）。
 */
const advancedConfigSummary = computed((): string[] => {
  const chips: string[] = []
  const growth = form.value as unknown as Record<string, unknown>
  if (growth.enableViral === true) chips.push(t('lottery.adminChipViral'))
  if (growth.enablePity === true && Number(growth.pityThreshold || 0) >= 2) chips.push(t('lottery.adminChipPity'))
  if (growth.enableDailyFreeSpins === true && Number(growth.dailyFreeSpinsCount || 0) >= 1) chips.push(t('lottery.adminChipDailyFree'))
  if (String(growth.referralRewardDefsText || '').trim()) chips.push(t('lottery.adminChipReferralDefs'))
  if (String(growth.leaderboardRewardsText || '').trim()) chips.push(t('lottery.adminChipLeaderboard'))
  if (growth.enableFlashSale === true) {
    chips.push(growth.flashSalePaymentRequired === true
      ? t('lottery.adminChipFlashSalePaid')
      : t('lottery.adminChipFlashSale'))
  }
  if (growth.enableProductLink === true) chips.push(t('lottery.adminChipProductLink'))
  if (growth.enableAfterWinCta === true) chips.push(t('lottery.adminChipAfterWin'))
  if (growth.enableAfterLossCta === true) chips.push(t('lottery.adminChipAfterLoss'))
  const loser = (form.value.activityConfig as { loserReward?: { enabled?: boolean } } | null)?.loserReward
  if (loser?.enabled === true) chips.push(t('lottery.adminChipLoserReward'))
  return chips
})
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
/** docs/162 P1-C：套用模板后展示在创建表单顶部的配置要点（按当前语言解析） */
const activeTemplateHints = ref<string[]>([])
const showTemplateModal = ref(false)
const templates = ref<any[]>([])
/** docs/162 P1-A：模板弹窗加载/失败态——弹窗先开、请求后回，必须给用户可见反馈 */
const templatesLoading = ref(false)
const templatesLoadFailed = ref(false)
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
const showRewardFailuresModal = ref(false)
const rewardFailures = ref<Array<{ id: string; entryId: string; refCode: string; createdAt: string; path: string; error: string; shareRecordId: string; identityDisplay?: string }>>([])
const rewardFailuresLoading = ref(false)
const rewardFailuresDrawId = ref('')
/** P1-2：运营可指定补发某人的失败记录，而非全部重试 */
const reissueEntryId = ref('')
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
  consolationCards,
  consolationRedeemRate,
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

/**
 * 游标分页状态（docs/154 P2-1）。
 *
 * cursorMap 记录每页的游标：page → cursor，
 * 顺序翻页（prev/next）时复用已有游标，避免 OFFSET 大偏移量性能退化。
 * 跳页（@jump）时，若目标页游标未知则回退到 offset 分页。
 * 筛选变更时 resetCursorMap 清空所有游标回到第一页。
 */
const cursorMap = new Map<number, string>()
cursorMap.set(1, '')  // 第一页游标为空，表示从头开始

/** 重置游标映射（筛选变更/刷新时调用） */
function resetCursorMap() {
  cursorMap.clear()
  cursorMap.set(1, '')
}
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
/** docs/223：进行中/暂停活动编辑时锁定破坏性字段（类型/参与模式/体验/结果模式/容量/开始时间） */
const editLocked = ref(false)

/**
 * 引擎推荐奖励行编辑器（docs/255 ③）：把裸文本 textarea 升级为可视化行编辑器。
 * 每行 = 邀请数 + 奖励类型 + 数量（+ 可选券 label），运营通过"添加/删除行"操作，
 * 提交时仍转成 referralRewardDefsText 文本格式（与后端契约不变）。
 * 双向绑定：改行 → 同步 text；打开编辑 → 从 text 解析回行。
 */
const referralRewardDefsRows = ref<ReferralRewardDefEntry[]>([])
/** 从当前 text 解析行（打开编辑/复制时调用） */
function syncReferralRewardDefsRowsFromText() {
  referralRewardDefsRows.value = parseReferralRewardDefsText(form.value.referralRewardDefsText)
}
/** 行变更 → 同步回 text（提交时 buildPromotionConfigPayload 读取 text） */
function syncReferralRewardDefsTextFromRows() {
  form.value.referralRewardDefsText = formatReferralRewardDefRows(referralRewardDefsRows.value)
}
/** 添加一行（默认邀请 1 人 + bonus_spin + 1 次） */
function addReferralRewardDefRow() {
  referralRewardDefsRows.value.push({ requireCount: 1, rewardExit: 'bonus_spin', rewardValue: 1 })
  syncReferralRewardDefsTextFromRows()
}
/** 删除一行 */
function removeReferralRewardDefRow(index: number) {
  referralRewardDefsRows.value.splice(index, 1)
  syncReferralRewardDefsTextFromRows()
}
/**
 * 行内字段变更 → 同步回 text。
 *
 * docs/259 §9.5：券 label 里的 `#` 与文本格式的 rewardId 分隔符冲突，会把 label 截断、
 * 并把 `#` 后的片段误当成发放幂等键。序列化层已会清除，这里同时把输入框里的值就地规范化，
 * 让运营立刻看到"`#` 不被接受"，而不是界面显示 vip#a、实际保存 vipa。
 */
function onReferralRewardDefRowChange() {
  for (const row of referralRewardDefsRows.value) {
    if (row.couponLabel != null) {
      const cleaned = sanitizeCouponLabel(row.couponLabel)
      if (cleaned !== row.couponLabel) row.couponLabel = cleaned
    }
  }
  syncReferralRewardDefsTextFromRows()
}

const flashSalePriceYuan = computed({
  get: () => {
    const v = form.value.flashSalePriceCents
    return v != null && v > 0 ? (v / 100).toFixed(2) : ''
  },
  set: (val: string) => {
    const n = parseFloat(val)
    // 显式拦截负数/超大值（浏览器 type=number 的 min/max 非强制，不能依赖）
    // 上限 1,000,000 元（100,000,000 分），防止无意输入过长数字导致存储/显示异常
    form.value.flashSalePriceCents = isNaN(n) || n <= 0 ? null : Math.max(1, Math.min(100000000, Math.round(n * 100)))
  },
})

function flashSaleTierPriceYuan(index: number): string {
  const tier = form.value.flashSalePricingTiers[index]
  const cents = Number(tier?.unitPriceCents || 0)
  return cents > 0 ? (cents / 100).toFixed(2) : ''
}

function setFlashSaleTierPriceYuan(index: number, value: string) {
  const tier = form.value.flashSalePricingTiers[index]
  if (!tier) return
  const n = parseFloat(value)
  tier.unitPriceCents = isNaN(n) || n <= 0 ? 0 : Math.max(1, Math.round(n * 100))
}

function onFlashSaleTierPriceInput(index: number, event: Event) {
  setFlashSaleTierPriceYuan(index, (event.target as HTMLInputElement | null)?.value || '')
}

/**
 * 对齐每人限购数与阶梯档位：flashSaleMaxPerUser 必须 >= 最大档位起步数。
 * 否则模板预置档位（如 1/5 件起 → minQuantity=5）超过 max=1 时，浏览器原生
 * min/max 校验在提交时尝试聚焦该输入框，控件不可聚焦会抛
 * "An invalid form control with name='' is not focusable"，表单静默提交失败。
 * 模板应用 / 编辑回填 / 复制回填三处入口统一调用，保证初始数据自洽。
 */
function alignFlashSaleMaxPerUser(
  tiers: Array<{ minQuantity?: unknown }> | null | undefined,
  current: number | null | undefined,
): number {
  const maxTier = (tiers || []).reduce((acc, t) => {
    const n = Math.floor(Number(t?.minQuantity) || 1)
    return n > acc ? n : acc
  }, 1)
  return Math.max(1, Math.floor(Number(current) || 1), maxTier)
}

function addFlashSalePricingTier() {
  if (form.value.flashSalePricingTiers.length >= 8) return
  const lastMin = form.value.flashSalePricingTiers
    .reduce((max, tier) => Math.max(max, Number(tier.minQuantity || 0)), 0)
  form.value.flashSalePricingTiers.push({
    minQuantity: form.value.flashSalePricingTiers.length === 0 ? 1 : Math.min(100, lastMin + 1),
    unitPriceCents: form.value.flashSalePriceCents || 0,
    label: '',
  })
  // 每人限购同步扩容：新档位起步数可能超过当前限购（默认限购 1 时新增「2 件起」档），
  // 否则 minQuantity > max 触发浏览器原生校验失败（"An invalid form control ... not focusable"）
  form.value.flashSaleMaxPerUser = alignFlashSaleMaxPerUser(form.value.flashSalePricingTiers, form.value.flashSaleMaxPerUser)
}

function removeFlashSalePricingTier(index: number) {
  form.value.flashSalePricingTiers.splice(index, 1)
}
const rosterInput = ref('')
const inviteCodeCount = ref(10)
/** 奖品库（用于奖项配置下拉选择） */
const prizeOptions = ref<any[]>([])
/** docs/225 P0：已加载奖品映射（id → prize），用于奖项行摘要与开奖确认弹窗，避免只依赖前 50 条 */
const prizeMap = ref<Record<string, any>>({})

/** docs/225 P0：服务端搜索选择器状态 */
const prizePickerOpen = ref(false)
const prizePickerIdx = ref(-1)
const prizeSearchQuery = ref('')
const prizeSearchResults = ref<any[]>([])
const prizeSearchTotal = ref(0)
const prizeSearchPage = ref(0)
const prizeSearchLoading = ref(false)
const prizeSearchLimit = 20
let prizeSearchSeq = 0 // 竞态防护：忽略过期搜索结果
const prizePickerSearchInput = ref<HTMLInputElement>()
let prizePickerTrigger: HTMLElement | null = null

/** 打开奖品选择器（docs/225 P0：服务端检索 + 分页 + 业务摘要，替换原生下拉框） */
async function openPrizePicker(idx: number, event?: MouseEvent) {
  prizePickerTrigger = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null
  prizePickerIdx.value = idx
  prizePickerOpen.value = true
  prizeSearchQuery.value = ''
  prizeSearchPage.value = 0
  void searchPrizes(0)
  await nextTick()
  prizePickerSearchInput.value?.focus()
}

/** 服务端搜索奖品（防抖 + 竞态防护） */
async function searchPrizes(page: number) {
  const seq = ++prizeSearchSeq
  prizeSearchLoading.value = true
  try {
    const params = new URLSearchParams()
    if (prizeSearchQuery.value.trim()) params.set('search', prizeSearchQuery.value.trim())
    params.set('limit', String(prizeSearchLimit))
    params.set('offset', String(page * prizeSearchLimit))
    params.set('active', '1')
    params.set('includeAvailability', '1')
    // 直付场景：只显示卡密奖品 + 占用判定；普通抽奖：默认启用奖品
    if (form.value.activityKind === 'claim' && form.value.experienceType === 'flash_sale') {
      params.set('prizeType', 'code')
      params.set('directSaleDrawId', form.value.id || 'new')
    }
    const data = await adminRequest<{ prizes: any[]; total: number }>(`/api/admin/prizes?${params.toString()}`)
    if (seq !== prizeSearchSeq) return // 过期请求丢弃
    prizeSearchResults.value = data.prizes || []
    prizeSearchTotal.value = data.total || 0
    prizeSearchPage.value = page
    // 合并到 prizeMap，供奖项行摘要显示
    for (const p of prizeSearchResults.value) prizeMap.value[p.id] = p
  } catch {
    if (seq === prizeSearchSeq) prizeSearchResults.value = []
  } finally {
    if (seq === prizeSearchSeq) prizeSearchLoading.value = false
  }
}

/** 选择奖品并绑定到当前奖项行 */
function selectPrize(prize: any) {
  const idx = prizePickerIdx.value
  if (idx >= 0 && form.value.tiers[idx]) {
    form.value.tiers[idx].prizeId = prize.id
    if (!form.value.tiers[idx].tierName) {
      form.value.tiers[idx].tierName = prize.name || ''
    }
    prizeMap.value[prize.id] = prize
  }
  closePrizePicker()
}

/** 关闭选择器 */
function closePrizePicker() {
  // 让关闭后才返回的旧请求失效，避免下次打开时短暂显示上次搜索结果。
  prizeSearchSeq += 1
  if (prizeSearchTimer) {
    clearTimeout(prizeSearchTimer)
    prizeSearchTimer = null
  }
  prizePickerOpen.value = false
  prizePickerIdx.value = -1
  const trigger = prizePickerTrigger
  prizePickerTrigger = null
  void nextTick(() => trigger?.focus())
}

/** 搜索防抖（docs/225 P0：输入防抖 + 竞态防护） */
let prizeSearchTimer: ReturnType<typeof setTimeout> | null = null
function onPrizeSearchInput() {
  if (prizeSearchTimer) clearTimeout(prizeSearchTimer)
  prizeSearchTimer = setTimeout(() => {
    prizeSearchPage.value = 0
    searchPrizes(0)
  }, 300)
}

/** 按 ids 回填已绑定奖品（编辑旧活动时，即使奖品已停用/不在当前页也要显示名称） */
async function loadBoundPrizes(ids: string[]) {
  const valid = ids.filter(Boolean)
  if (valid.length === 0) return
  try {
    const data = await adminRequest<{ prizes: any[] }>(`/api/admin/prizes?ids=${encodeURIComponent(valid.join(','))}&includeAvailability=1`)
    for (const p of data.prizes || []) prizeMap.value[p.id] = p
  } catch { /* 回填失败不阻塞编辑 */ }
}

/** 奖项行已绑定奖品摘要（名称 + 价值 + 库存） */
function tierPrizeSummary(tier: any): { name: string; valueText: string; availableCount: number | null; active: boolean } | null {
  if (!tier?.prizeId) return null
  const p = prizeMap.value[tier.prizeId]
  if (!p) return null
  return {
    name: p.name || '',
    valueText: p.valueText || '',
    availableCount: p.availableCount == null ? null : Number(p.availableCount),
    active: Number(p.active ?? 1) === 1,
  }
}

const flashSaleDirectChecklist = computed(() => {
  return buildFlashSaleDirectChecklist({
    enableFlashSale: form.value.enableFlashSale,
    flashSaleSalesMode: form.value.flashSaleSalesMode,
    flashSalePaymentRequired: form.value.flashSalePaymentRequired,
    flashSalePriceCents: form.value.flashSalePriceCents,
    flashSaleStockLimit: form.value.flashSaleStockLimit,
    flashSaleTitle: form.value.flashSaleTitle,
    maxParticipants: form.value.maxParticipants,
    // 3a：lottery + 直付秒杀 是发布红线，清单需按活动类型给出 error 级冲突条目
    activityKind: form.value.activityKind,
    // 3b：导流 URL 安全判定——destination 即表单商品链接（提交时同源写入 promotion.destination）
    productLink: form.value.productLink,
    destination: { url: form.value.productLink.url },
    // after_win CTA 也是后端认可的导流落地页（promotion.ctas.after_win.url）
    afterWin: form.value.enableAfterWinCta ? { url: form.value.afterWinCtaUrl } : undefined,
    tiers: form.value.tiers,
    // prizeOptions 仅是首屏目录，prizeMap 还包含服务端搜索/旧活动回填的奖品。
    // 合并后清单才能正确识别“从第 2 页以后选择的卡密奖品”；纯函数内部再按 id 去重。
    prizeOptions: [...prizeOptions.value, ...Object.values(prizeMap.value)],
  })
})

/**
 * 创建底部就绪提示与直付发布清单共用同一组阻塞项。
 *
 * 这里仅在「已开启秒杀 + 选择直付」时生效；导流模式不应被价格、
 * 卡密等站内支付条件阻塞。支付渠道凭据、卡密库存等服务端事实仍由
 * publish-check 负责，前端只提前提示表单中可以确定的缺项。
 */
const flashSaleDirectChecklistBlockers = computed(() => {
  if (!form.value.enableFlashSale || form.value.flashSaleSalesMode === 'redirect') return []
  return flashSaleDirectChecklist.value.filter((item) => !item.done || item.error)
})

// ── 活动后承接：未中奖自动发券开关（表单编辑用，保存时同步进 activityConfig.loserReward） ──
const loserRewardEnabled = ref(false)
const loserRewardCouponLabel = ref('')

// ── 邀请奖励配置（docs/259 P1-3）：表单编辑用，保存时同步进 activityConfig.reward ──
const rewardPerInviteAmount = ref(0)
const rewardCurrency = ref('USD')
const rewardPerUserPerDay = ref<number | undefined>(undefined)
const rewardGlobalPerDay = ref<number | undefined>(undefined)

// 编辑「已设访问密码」的活动时为 true：表单内提示「留空保持不变」。
// 为什么：后端 detail 只返回 hasAccessPassword 布尔、不返回哈希（也不能返回），
// 编辑时密码框为空容易让运营误以为密码丢了而重新设置；后端 PATCH 已改为空串跳过、null 清空，
// 留空即「保持原密码不变」。
const editingHasAccessPassword = ref(false)

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

/**
 * 把 reward 配置同步进 form.activityConfig。
 *
 * 数据结构约定（对齐后端 triggerRewardEarned 的读取路径）：
 * - activityConfig.reward：每邀请金额/货币（reward.ts:73 config?.reward）
 * - activityConfig.quota：个人/全局每日上限（reward.ts:84-85 config?.quota）
 *
 * ⚠️ 为什么 quota 必须在顶层而非 reward 内部：
 * 后端 triggerRewardEarned 从 config?.quota?.perUserPerDay 读取配额，
 * 若 quota 嵌套在 reward.quota 下则永远读到 undefined，配额限制完全失效。
 */
function syncRewardConfig() {
  const config = form.value.activityConfig as any
  // perInviteAmount 写入 reward 对象（per-invite 维度配置）
  config.reward = {
    perInviteAmount: Number(rewardPerInviteAmount.value || 0),
    currency: String(rewardCurrency.value || 'USD'),
  }
  // quota 写入 activityConfig 顶层（活动级全局配额），与后端 triggerRewardEarned 读取路径对齐
  const quota: Record<string, number> = {}
  if (rewardPerUserPerDay.value != null) quota.perUserPerDay = rewardPerUserPerDay.value
  if (rewardGlobalPerDay.value != null) quota.globalPerDay = rewardGlobalPerDay.value
  config.quota = Object.keys(quota).length > 0 ? quota : undefined
}

/**
 * 从 form.activityConfig 回填表单状态（编辑活动时调用）。
 * 读取路径与 syncRewardConfig 写入路径对齐：reward 在 activityConfig.reward，quota 在 activityConfig.quota。
 */
function initRewardFromConfig() {
  const config = form.value.activityConfig as any
  const r = config?.reward
  rewardPerInviteAmount.value = Number(r?.perInviteAmount || 0)
  rewardCurrency.value = String(r?.currency || 'USD')
  // quota 从 activityConfig 顶层读取（对齐后端 triggerRewardEarned 读取路径）
  rewardPerUserPerDay.value = config?.quota?.perUserPerDay != null ? Number(config.quota.perUserPerDay) : undefined
  rewardGlobalPerDay.value = config?.quota?.globalPerDay != null ? Number(config.quota.globalPerDay) : undefined
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
      // instant：尊重运营显式填写的 0，0 表示该档暂不进入随机分配。
      // 不能用 `Number(weight) || 1`，否则会把 0 悄悄改成 1，造成超出运营预期的发放风险。
      ...(isInstant
        ? { weight: normalizeTierWeight(tier.weight) }
        : {}),
    }))
  if (validTiers.length === 0) return
  try {
    await adminRequest(`/api/admin/draws/${drawId}/tiers`, {
      method: 'POST',
      body: JSON.stringify({ tiers: validTiers }),
    })
  } catch (e) {
    // 奖项保存失败必须中断主流程（throw），否则外层 handleCreate 会误报「创建成功」，
    // 而活动实际无奖项，无法通过发布门禁（P0，docs/202 §5.1）。
    showToast(t('lottery.adminFailed'), 'error')
    throw new Error(`保存奖项失败: ${toErrorMessage(e, '')}`)
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
  } catch (e) {
    // 名单导入失败不应静默；否则活动创建后无可用名单，roster 模式用户无法参与（P0）。
    showToast(`名单导入失败: ${toErrorMessage(e, '')}`, 'error')
    throw new Error(`名单导入失败: ${toErrorMessage(e, '')}`)
  }
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
  } catch (e) {
    // 邀请码生成失败不应静默；否则活动创建后无可用邀请码，invite_code 模式用户无法参与（P0）。
    showToast(`邀请码生成失败: ${toErrorMessage(e, '')}`, 'error')
    throw new Error(`邀请码生成失败: ${toErrorMessage(e, '')}`)
  }
}

/** 添加一个奖项（最多 10 个） */
function addTier() {
  if (!canAddTier.value) return
  form.value.tiers.push({
    prizeId: '',
    tierName: isDirectBulkFlashSale.value
      ? t('lottery.adminWholesaleDefaultName')
      : t('lottery.adminTierName', { n: form.value.tiers.length + 1 }),
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

/**
 * docs/145 P2 接线（docs/162 发现此前从未接入 UI）：
 * 高频模板只展示相关区块；编辑已有活动/空白创建 → 全量可见。
 * 隐藏仅影响 UI 展示，不改提交 payload（开关关闭时保存仍写默认关）。
 */
const editorVisibility = computed(() =>
  resolveEditorFieldVisibility(activeTemplateId.value, { isEditing: isEditing.value }),
)

/** 高级区「体验类型 + 壳策略」是否两列并排（lottery 且壳配置可见时；非 lottery 体验 select 占满行） */
const showPrizeShellSelector = computed(() =>
  form.value.activityKind === 'lottery' && editorVisibility.value.prizeShell,
)

const tierProbabilities = computed(() => buildTierProbabilities(form.value.tiers))
// instant 模式（即时大转盘 / 直付秒杀）：结果由用户 spin/购买即时产生，无需设置开奖时间。
// 表单不显示开奖时间输入框、创建步骤不要求 drawTime、payload 不写 drawAt（docs/116）。
const isInstantMode = computed(() => String(form.value.resultMode || '') === 'instant')
/** 直付批发仍复用 lottery_prize_tiers 存储“发货商品绑定”，但运营界面不能继续说奖项/中奖。 */
const isDirectBulkFlashSale = computed(() => (
  form.value.enableFlashSale === true
  && form.value.flashSaleSalesMode === 'direct_bulk'
))
const isDirectPayFlashSale = computed(() => (
  form.value.enableFlashSale === true
  && form.value.flashSaleSalesMode !== 'redirect'
))
const tierCopy = computed(() => {
  if (!isDirectBulkFlashSale.value) {
    return {
      config: 'lottery.adminTierConfig',
      prize: 'lottery.adminTierHeaderPrize',
      name: 'lottery.adminTierHeaderName',
      count: 'lottery.adminTierHeaderWinnerCount',
      weight: 'lottery.adminTierHeaderWeight',
      probability: 'lottery.adminTierHeaderProbability',
      selectPrize: 'lottery.adminSelectPrize',
      changePrize: 'lottery.adminChangePrize',
      namePlaceholder: 'lottery.adminTierNamePlaceholder',
      countPlaceholder: 'lottery.adminTierSlotsPlaceholder',
      weightPlaceholder: 'lottery.adminTierWeightPlaceholder',
      weightHint: 'lottery.adminTierWeightHint',
      probabilityHint: 'lottery.adminTierProbabilityHint',
      probabilityLabel: 'lottery.adminTierProbabilityLabel',
      addTier: 'lottery.adminAddTier',
      quickCreatePrize: 'lottery.adminQuickCreatePrize',
      emptyHint: 'lottery.adminEmptyPrizeHint',
      limitHint: 'lottery.adminTierLimitHint',
    }
  }
  return {
    config: 'lottery.adminWholesaleProductConfig',
    prize: 'lottery.adminWholesaleHeaderProduct',
    name: 'lottery.adminWholesaleHeaderName',
    count: 'lottery.adminWholesaleHeaderStock',
    weight: 'lottery.adminWholesaleHeaderWeight',
    probability: 'lottery.adminWholesaleHeaderShare',
    selectPrize: 'lottery.adminSelectWholesaleProduct',
    changePrize: 'lottery.adminChangeWholesaleProduct',
    namePlaceholder: 'lottery.adminWholesaleNamePlaceholder',
    countPlaceholder: 'lottery.adminWholesaleStockPlaceholder',
    weightPlaceholder: 'lottery.adminWholesaleWeightPlaceholder',
    weightHint: 'lottery.adminWholesaleWeightHint',
    probabilityHint: 'lottery.adminWholesaleShareHint',
    probabilityLabel: 'lottery.adminWholesaleShareLabel',
    addTier: 'lottery.adminAddWholesaleProduct',
    quickCreatePrize: 'lottery.adminQuickCreateWholesaleProduct',
    emptyHint: 'lottery.adminWholesaleEmptyProductHint',
    limitHint: 'lottery.adminWholesaleProductLimitHint',
  }
})
const canAddTier = computed(() => {
  const max = maxTierRowsForSalesMode(form.value.flashSaleSalesMode || '')
  return form.value.tiers.length < max
})
const hasPositiveTierWeight = computed(() => tierProbabilities.value.some((item) => item.weight > 0))
const shouldShowTierProbability = computed(() => (
  form.value.activityKind === 'lottery'
  && form.value.resultMode === 'instant'
  && editorVisibility.value.tiers
  && form.value.tiers.length > 0
))

/** 奖项名额合计（各档中奖份数之和）：与后端开奖逻辑一致（draw-execution 按奖项合计发放） */
const tierCountSummary = computed(() => {
  if (!editorVisibility.value.tiers || form.value.tiers.length === 0) return null
  return buildTierWinnerCountSummary(form.value.tiers, form.value.winnerCount, form.value.activityKind || 'lottery')
})

watch(isDirectBulkFlashSale, (enabled) => {
  if (!enabled || form.value.tiers.length <= 1) return
  // 批发/阶梯价是一种“同一商品多件下单”的价格策略，不是多商品购物车；多商品会让发卡库存与订单履约语义失真。
  form.value.tiers = [form.value.tiers[0]!]
})

// docs/239 方案 C 温和版：秒杀启用且设置展示名额上限时，参与上限（maxParticipants）自动跟随，
// 与后端创建/编辑路由的联动写库同源，避免「名额 200 但 6 单截单」的运营误解。
watch(
  () => [form.value.enableFlashSale, form.value.flashSaleStockLimit],
  () => {
    if (form.value.enableFlashSale === true && form.value.flashSaleStockLimit) {
      form.value.maxParticipants = form.value.flashSaleStockLimit
    }
  },
  { immediate: true },
)

/** 当前高亮步骤（点击步骤条时更新；不强制线性 Wizard） */
const createStepFocus = ref(1)

/**
 * 各步完成态：驱动步骤条 ✓，与 createReadiness 同源规则。
 * 第 4 步：抽奖看奖项；非抽奖有时间即可（名额可选）。
 */
const createStepDone = computed(() => {
  const nameOk = Boolean(String(form.value.name || '').trim())
  // instant 模式无需开奖时间（结果即时产生），只要求开始/结束时间
  const timeFilled = isInstantMode.value
    ? Boolean(form.value.startTime && form.value.endTime)
    : Boolean(form.value.startTime && form.value.endTime && form.value.drawTime)
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
  } else if (needsTiersMandatory(form.value.activityKind, form.value.experienceType || '', form.value.enableFlashSale, form.value.flashSaleSalesMode !== 'redirect')) {
    // 直付秒杀必须同时满足前端清单中的可确定条件，尤其是唯一可用卡密奖品；
    // 支付渠道凭据和实际卡密库存仍由服务端 publish-check 最终判定。
    prizesOk = flashSaleDirectChecklistBlockers.value.length === 0
  } else {
    prizesOk = timeOk // 非 lottery/claim 直付：名额可选，时间齐即视为第 4 步可过
  }
  return { basic: nameOk, time: timeOk, join: joinOk, prizes: prizesOk }
})

const createReadinessLabel = computed(() => {
  if (isEditing.value) return ''
  const missing: string[] = []
  if (!createStepDone.value.basic) missing.push(t('lottery.adminCreateNeedName'))
  if (!form.value.startTime || !form.value.endTime || (!isInstantMode.value && !form.value.drawTime)) {
    missing.push(t('lottery.adminCreateNeedTime'))
  } else if (timeOrderError.value) {
    missing.push(t('lottery.adminCreateNeedTimeOrder'))
  }
  if (form.value.activityKind === 'lottery' && !createStepDone.value.prizes) {
    missing.push(t('lottery.adminCreateNeedPrize'))
  }
  const directChecklistBlockers = flashSaleDirectChecklistBlockers.value
  if (needsTiersMandatory(form.value.activityKind, form.value.experienceType || '', form.value.enableFlashSale, form.value.flashSaleSalesMode !== 'redirect')) {
    for (const item of directChecklistBlockers) {
      missing.push(t(`lottery.${item.labelKey}`))
    }
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

function handleExperienceChange() {
  // 源头扼杀：切换体验类型时，若新组合（kind × experienceType）不再适用秒杀壳，自动关闭秒杀配置，
  // 避免「experienceType=reveal 但 flashSale 配置残留」导致奖档区隐藏、发布检查仍要求卡密奖品而卡死。
  if (!isFlashSaleApplicable(form.value.activityKind || 'lottery', form.value.experienceType || '') && form.value.enableFlashSale) {
    form.value.enableFlashSale = false
    form.value.flashSalePaymentRequired = false
  }
}

function handleFlashSaleSalesModeChange() {
  const mode = form.value.flashSaleSalesMode
  if (mode === 'redirect') {
    form.value.flashSalePaymentRequired = false
    form.value.flashSalePriceCents = null
    form.value.flashSaleMaxPerUser = 1
    form.value.flashSalePricingTiers = []
    return
  }

  form.value.flashSalePaymentRequired = true
  if (mode === 'direct_single') {
    form.value.flashSaleMaxPerUser = 1
    form.value.flashSalePricingTiers = []
    return
  }

  // 批发模式至少允许 2 件；若没有阶梯档位，先建立覆盖 1 件的基础档。
  form.value.flashSaleMaxPerUser = Math.max(2, Number(form.value.flashSaleMaxPerUser || 1))
  if (form.value.flashSalePricingTiers.length === 0) {
    form.value.flashSalePricingTiers.push({
      minQuantity: 1,
      unitPriceCents: form.value.flashSalePriceCents || 0,
      label: '单件',
    })
  }
  // 防御：限购必须 >= 最大档位起步数，否则提交时该档会被 buildPromotionConfigPayload 过滤
  form.value.flashSaleMaxPerUser = alignFlashSaleMaxPerUser(form.value.flashSalePricingTiers, form.value.flashSaleMaxPerUser)
}

function handleActivityKindChange() {
  const kind = form.value.activityKind || 'lottery'
  // 切换活动类型时保护直付秒杀配置：仅当目标类型为 claim 且当前体验已是 flash_sale 时保留，
  // 避免用户切一下活动类型就把「限时抢购」的体验壳悄悄改成 reveal（奖项/秒杀配置随之失联）。
  const currentExp = form.value.experienceType
  if (!(kind === 'claim' && currentExp === 'flash_sale')) {
    form.value.experienceType = defaultExperienceForActivity(kind, form.value.participationMode || 'open')
  }
  // 交叉组合死角修复（2026-08 体验优化）：切换活动类型后，若新组合不适用秒杀壳
  // （如 lottery 开秒杀壳后切到 survey），清理 enableFlashSale/paymentRequired，
  // 避免「survey 活动残留 flashSale.enabled=true」导致发布预检要求卡密奖品而卡死。
  if (!isFlashSaleApplicable(kind, form.value.experienceType || '')) {
    form.value.enableFlashSale = false
    form.value.flashSalePaymentRequired = false
  }
  form.value.resultMode = defaultResultModeForActivity(kind)
  form.value.allocationPolicy = kind === 'signup_chain' ? 'waitlist' : kind === 'approval' ? 'approval' : 'capacity'
  form.value.winnerCount = kind === 'lottery' ? Math.max(1, Number(form.value.winnerCount) || 1) : 0
  form.value.activityConfig = normalizeActivityConfig(kind, form.value.activityConfig) as any
}

function handleParticipationModeChange() {
  form.value.experienceType = defaultExperienceForActivity(form.value.activityKind || 'lottery', form.value.participationMode || 'open')
  // 交叉组合死角修复：参与模式切换可能把体验从 flash_sale 重置为默认（如 password→scratch），
  // 同步清理不适用的秒杀配置（与 handleActivityKindChange 同策略）。
  if (!isFlashSaleApplicable(form.value.activityKind || 'lottery', form.value.experienceType || '')) {
    form.value.enableFlashSale = false
    form.value.flashSalePaymentRequired = false
  }
}

/**
 * 问卷字段折叠状态（2026-08 打磨）：collapsed 集合存「已折叠」字段 id；
 * 默认全部展开（新字段自动展开），字段多时运营可逐个收起减少滚动。
 */
const collapsedSurveyFieldIds = ref<Set<string>>(new Set())

function isSurveyFieldCollapsed(id: string): boolean {
  return collapsedSurveyFieldIds.value.has(id)
}

function toggleSurveyField(id: string) {
  const next = new Set(collapsedSurveyFieldIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsedSurveyFieldIds.value = next
}

function addSurveyField() {
  const config = normalizeActivityConfig('survey', form.value.activityConfig) as Extract<ActivityConfigForm, { kind: 'survey' }>
  const field: SurveyFieldForm = {
    id: makeStableId('field'),
    label: t('lottery.adminNewField'),
    type: 'text',
    required: false,
    maxLength: 120,
    options: [],
  }
  config.fields.push(field)
  form.value.activityConfig = config as any
  // 新字段默认展开（便于立即配置；收起是用户主动行为）
  const next = new Set(collapsedSurveyFieldIds.value)
  next.delete(field.id)
  collapsedSurveyFieldIds.value = next
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

/**
 * 判断活动是否为「支付类活动」（秒杀直付，promotionConfig.flashSale.paymentRequired）。
 * 与后端 isFlashSaleDirect / parseFlashSaleConfig 的判定同源（三态），
 * 用于批量删除时提示运营：此类活动可能残留 expired 支付订单，需勾选 force 测试清场
 * （docs/255 测试清场；前端无法精确感知订单存在，用支付配置近似触发 force 选项）。
 */
function isPaymentDraw(draw: LotteryDraw): boolean {
  const pc = draw.promotionConfig
  if (!pc) return false
  try {
    const parsed = typeof pc === 'string' ? JSON.parse(pc) : pc
    const flashSale = (parsed as Record<string, unknown>)?.flashSale as Record<string, unknown> | undefined
    const pr = flashSale?.paymentRequired ?? flashSale?.payment_required
    return pr === true || pr === 1 || pr === 'true'
  } catch {
    return false
  }
}

/** 筛选变更回第 1 页，避免页码卡在空页 */
function reloadFromFirstPage() {
  resetCursorMap()  // 筛选条件变化，清空游标缓存从头开始
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

/** CSV 导出：复用当前筛选条件，下载 UTF-8 BOM CSV */
async function exportCsv() {
  const params = new URLSearchParams()
  if (statusFilter.value) params.set('status', statusFilter.value)
  if (activityKindFilter.value) params.set('activityKind', activityKindFilter.value)
  if (listQuery.value) params.set('query', listQuery.value)
  if (createdFromFilter.value) params.set('createdFrom', createdFromFilter.value)
  if (createdToFilter.value) params.set('createdTo', createdToFilter.value)
  const url = `/api/admin/draws/export?${params.toString()}`
  try {
    const token = readAdminToken()
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`导出失败 (${res.status})`)
    const blob = await res.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `activities_${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(a.href)
  } catch (e: any) {
    showToast(`导出失败: ${e.message}`, 'error')
  }
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

async function handleExportWinners() {
  if (winners.value.length === 0) {
    showToast(t('lottery.adminExportWinnersEmpty'), 'error')
    return
  }
  const idPart = (winnersModalDrawId.value || 'winners').slice(0, 40)
  try {
    const token = readAdminToken()
    const headers: Record<string, string> = {}
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(`/api/admin/draws/${encodeURIComponent(winnersModalDrawId.value)}/export?scope=winners`, { headers })
    if (!res.ok) throw new Error(`导出失败 (${res.status})`)
    const blob = await res.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `lottery-winners-${idPart}-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(a.href)
    showToast(t('lottery.adminExportWinnersDone'), 'success')
  } catch (e: any) {
    showToast(`导出失败: ${e.message}`, 'error')
  }
}

async function handleDuplicate(draw: LotteryDraw) {
  const draft = buildLotteryDuplicateDraft(draw, { nameSuffix: t('lottery.adminDuplicateSuffix'), defaultName: t('lottery.adminNewActivity') })
  // 调详情 API 获取完整数据（含 tiers + promotionConfig），与 handleEdit 同一真相源
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
  } catch { /* 详情加载失败时使用列表行上的字段 */ }
  // 详情优先（含完整 promotionConfig）；列表行作 fallback
  const source = detailDraw || (draw as Record<string, any>)
  const growth = growthFieldsFromDraw(source)
  form.value = {
    ...emptyForm(),
    id: '',
    name: draft.name,
    description: draft.description,
    startTime: draft.startTime,
    endTime: draft.endTime,
    drawTime: draft.drawTime,
    winnerCount: draft.winnerCount,
    maxParticipants: draft.maxParticipants,
    expectedParticipants: Number(source.expectedParticipants ?? 0),
    participationMode: draft.participationMode,
    activityKind: draft.activityKind || 'lottery',
    allocationPolicy: draft.allocationPolicy || 'capacity',
    experienceType: draft.experienceType,
    resultMode: draft.resultMode,
    activityConfig: normalizeActivityConfig(draft.activityKind || 'lottery', draft.activityConfig),
    // 复制活动不携带访问密码：明确置空，运营为新副本重新设置。
    // 为什么不能带源密码：detail 已不再返回哈希，且把旧密码复制给新活动等于把访问权泄露给不知情的新参与者。
    accessPassword: '',
    // 奖项配置（复制源活动，与 handleEdit 一致）
    tiers,
    // 展示开关（从源活动回填）
    showWinners: Number(source.showWinnerList ?? source.showWinnerCount ?? 0) === 1,
    showParticipantCount: (Number(source.showParticipantCount ?? 1) === 1 ? 1 : 0) as 0 | 1,
    maxSpinsPerEntry: Math.max(1, Number(source.maxSpinsPerEntry || 1)),
    // 增长配置（growthFieldsFromDraw 解析源活动 promotionConfig，与 handleEdit 同一真相源）
    enableProductLink: growth.enableProductLink,
    productLink: growth.productLink,
    enableViral: growth.enableViral,
    viralExtraEntriesPerInvite: growth.viralExtraEntriesPerInvite,
    viralMaxExtraEntries: growth.viralMaxExtraEntries,
    viralLeaderboardEnabled: growth.viralLeaderboardEnabled,
    // docs/218 保底/每日免费/排行榜奖励：编辑回填防整包覆盖擦掉配置
    enablePity: growth.enablePity,
    pityThreshold: growth.pityThreshold,
    enableDailyFreeSpins: growth.enableDailyFreeSpins,
    dailyFreeSpinsCount: growth.dailyFreeSpinsCount,
    leaderboardRewardsText: growth.leaderboardRewardsText,
    // docs/250/254 引擎推荐奖励：编辑回填防整包覆盖擦掉配置
    referralRewardDefsText: growth.referralRewardDefsText,
    enableAfterWinCta: growth.enableAfterWinCta,
    afterWinCtaUrl: growth.afterWinCtaUrl,
    afterWinCtaTitle: growth.afterWinCtaTitle,
    enableAfterLossCta: growth.enableAfterLossCta,
    afterLossCtaUrl: growth.afterLossCtaUrl,
    afterLossCtaTitle: growth.afterLossCtaTitle,
    // 游戏壳展示（growthFieldsFromDraw 解析 promotion.experience）
    prizePanelMode: growth.prizePanelMode || 'auto',
    ritualPhrasesText: growth.ritualPhrasesText || '',
    // 秒杀壳（growthFieldsFromDraw 解析 promotion.flashSale）
    enableFlashSale: growth.enableFlashSale,
    flashSaleSessionLabel: growth.flashSaleSessionLabel || '',
    flashSaleSalesMode: growth.flashSaleSalesMode,
    flashSaleStockLimit: growth.flashSaleStockLimit,
    flashSaleMaxPerUser: alignFlashSaleMaxPerUser(growth.flashSalePricingTiers, growth.flashSaleMaxPerUser),
    flashSaleCtaLabel: growth.flashSaleCtaLabel,
    flashSaleShowCountdown: growth.flashSaleShowCountdown !== false,
    flashSaleShowProgress: growth.flashSaleShowProgress !== false,
    flashSaleShowStock: growth.flashSaleShowStock !== false,
    flashSalePaymentRequired: growth.flashSalePaymentRequired === true,
    flashSalePriceCents: growth.flashSalePriceCents,
    flashSaleCurrency: growth.flashSaleCurrency || 'cny',
    flashSaleTitle: growth.flashSaleTitle || '',
    flashSaleImageUrl: growth.flashSaleImageUrl || '',
    flashSalePricingTiers: growth.flashSalePricingTiers || [],
  }
  isEditing.value = false
  // 复制不是编辑：不显示「留空保持原密码」提示
  editingHasAccessPassword.value = false
  // 引擎推荐奖励行编辑器：从回填的 text 解析行（docs/255 ③）
  syncReferralRewardDefsRowsFromText()
  showAdvancedGrowth.value = growth.hasGrowthConfig
  activeTemplateId.value = ''
  activeTemplateName.value = ''
  activeTemplateHints.value = []
  rosterInput.value = ''
  inviteCodeCount.value = 10
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
  // 关闭即清除「编辑已设密码」提示，避免下次打开创建表单时残留误导
  editingHasAccessPassword.value = false
  activeTemplateId.value = ''
  activeTemplateName.value = ''
  activeTemplateHints.value = []
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
  // 加载模板列表（首次打开或上次失败重试时）；弹窗立即打开，由 loading/失败态承接等待
  if (templates.value.length === 0 && !templatesLoading.value) {
    void fetchTemplates()
  }
  showTemplateModal.value = true
}

async function fetchTemplates() {
  templatesLoading.value = true
  templatesLoadFailed.value = false
  try {
    const data = await adminRequest<any>('/api/admin/templates')
    templates.value = data.templates || []
    enabledKinds.value = data.enabledKinds || []
    enabledParticipationModes.value = data.enabledParticipationModes || []
  } catch {
    // 加载失败：弹窗展示重试 + 空白创建出口（docs/162 P1-A），不再静默空网格
    templates.value = []
    enabledKinds.value = []
    enabledParticipationModes.value = []
    templatesLoadFailed.value = true
  } finally {
    templatesLoading.value = false
  }
}

/**
 * 空白创建（docs/162 P1-B）：
 * 1f8e6a0 大重构时模板弹窗里的「空白创建」卡丢失（CSS 仍在），
 * 导致所有创建必须过模板——误选「限时抢购」会默认带入 paymentRequired=true 直付配置。
 * 恢复入口：空白 = emptyForm + activeTemplateId 为空 → 字段可见性 FULL（不藏能力）。
 */
function startBlankCreate() {
  showTemplateModal.value = false
  form.value = emptyForm()
  isEditing.value = false
  // 空白创建非编辑：不残留「已设密码」提示
  editingHasAccessPassword.value = false
  showAdvancedGrowth.value = false
  activeTemplateId.value = ''
  activeTemplateName.value = ''
  activeTemplateHints.value = []
  createStepFocus.value = 1
  showCreateModal.value = true
  nextTick(() => focusCreateStep(1))
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
    // 预填可改标题，避免「空名 + 时间已填」却仍无法保存的落差；使用当前语言解析名称
    name: templateDisplayName(tpl, tplI18n),
    // docs/162 P1-E：模板 description 是写给运营者的说明文，不再预填为公开活动描述
    // （线上 af8fec27 实测证实运营未改直接发布，C 端看到的就是运营向文档原文）。
    // 描述留空，placeholder 引导运营者写面向参与者的文案。
    description: '',
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
    flashSaleSalesMode: tpl.defaults?.flashSaleSalesMode
      || inferFlashSaleSalesMode(
        tpl.defaults?.flashSalePaymentRequired === true,
        Number(tpl.defaults?.flashSaleMaxPerUser || 1),
        tpl.defaults?.flashSalePricingTiers || [],
      ),
    flashSaleStockLimit: tpl.defaults?.flashSaleStockLimit ?? null,
    flashSaleMaxPerUser: Number(tpl.defaults?.flashSaleMaxPerUser || 1),
    flashSalePaymentRequired: tpl.defaults?.flashSalePaymentRequired === true,
    flashSalePriceCents: tpl.defaults?.flashSalePriceCents ?? null,
    flashSaleCurrency: String(tpl.defaults?.flashSaleCurrency || 'cny'),
    flashSaleTitle: String(tpl.defaults?.flashSaleTitle || ''),
    flashSalePricingTiers: (tpl.defaults?.flashSalePricingTiers || []).map((tier: any) => ({
      minQuantity: Number(tier.minQuantity || 1),
      unitPriceCents: Number(tier.unitPriceCents || 0),
      label: String(tier.label || ''),
    })),
  }
  // 秒杀阶梯自洽：模板预置档位（如 1/5 件起）要求每人限购 >= 最大档位起步数，
  // 否则 min=1 max=1（默认限购 1）下 minQuantity=5 触发表单原生校验失败
  if (form.value.flashSalePricingTiers.length > 0) {
    form.value.flashSaleMaxPerUser = alignFlashSaleMaxPerUser(form.value.flashSalePricingTiers, form.value.flashSaleMaxPerUser)
  }
  // 模板强制体验类型：确保用户更改类别后模板的 experienceType 仍被保留（如 claim+flash_sale）。
  // 否则 handleActivityKindChange 先于模板应用执行，会把 experienceType 重置为默认（如 "reveal"），
  // 导致后端保存奖项时拒绝（"只有抽奖活动或直付秒杀需要配置奖项"）。
  if (tpl.defaults?.experienceType) {
    form.value.experienceType = tpl.defaults.experienceType
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
  // docs/225 P0：模板不再自动绑定任何奖品——「最新创建」不等于「适用」，自动绑定可能选到
  // 停用/空码池/被占用/名称不符的奖品，造成误配置。奖品绑定必须由运营者显式确认。
  isEditing.value = false
  // 套模板创建非编辑：不残留「已设密码」提示
  editingHasAccessPassword.value = false
  // docs/162 P1-C：模板配置要点展示在创建表单顶部；docs/145：flash-sale 自动展开高级区
  showAdvancedGrowth.value = shouldAutoExpandAdvancedForTemplate(tpl.id)
  activeTemplateId.value = String(tpl.id || '')
  activeTemplateName.value = templateDisplayName(tpl, tplI18n)
  activeTemplateHints.value = templateDisplayHints(tpl, tplI18n)
  // 根据活动类型选择合理的时间预设，减少运营反复调整（docs/213 #8）
  if (kind === 'checkin' || kind === 'vote' || kind === 'survey') {
    applyTimePreset('1h')  // 短互动默认 1 小时
  } else if (kind === 'signup_chain' || kind === 'reservation') {
    applyTimePreset('3d')  // 报名/预约默认 3 天
  } else {
    applyTimePreset('1d')  // 抽奖/秒杀/领取默认 1 天
  }
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
      const page = pagination.page.value
      // 游标分页：优先使用 cursorMap 中记录的游标（顺序翻页时高效），
      // 跳页时若目标页游标未知则回退到 offset（兼容旧版 AdminPagination 的 @jump）
      const knownCursor = cursorMap.get(page)
      const data = await fetchLotteryDraws({
        limit: pagination.limit.value,
        cursor: knownCursor ?? undefined,  // 已知游标时使用游标模式
        offset: knownCursor === undefined  // 未知游标时回退到 offset 模式
          ? (page - 1) * pagination.limit.value
          : undefined,
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
      // 存储下一页游标，供顺序翻页时复用
      if (data.nextCursor) {
        cursorMap.set(page + 1, data.nextCursor)
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
    // 发布成功后展示 info 级提示（errors/warnings 之外的非阻断信息：奖品默认图、未配置 Webhook 等）。
    // 随成功 toast 一并展示、不打断发布（warnings 才需要确认）；此前 check.infos 无展示通道，运营看不到这些提示。
    const publishNotes = formatPublishCheckItems(check.infos, t('lottery.adminPublishInfosPrefix'))
    const openedMessage = publishNotes ? `${publishNotes}\n${t('lottery.adminOpenedWithLink')}` : t('lottery.adminOpenedWithLink')
    // 发布后复制公开 slug 链接，避免把内部活动 id 发给参与者导致公开页 404。
    // docs/075：默认勾选「打开用户页」，确认即预览，少一次「是否打开？」心智负担。
    try {
      await writeClipboardText(publicShareUrl(draw.publicSlug))
      showToast(openedMessage, 'success')
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
 * 按 ID 批量删除（粘贴测试数据 ID 一键清场，docs/257）。
 * 与 selectedIds 批量删除共用 batch-delete 接口与审计；ID 列表来自粘贴框，
 * 不依赖列表选中态，方便批量清理跨页/跨筛选条件的测试数据。
 */
const showDeleteByIdsModal = ref(false)
const deleteByIdsText = ref('')
const deletingByIds = ref(false)

/** 从粘贴文本中提取 UUID：兼容逗号 / 换行 / 空格分隔，忽略非 UUID 噪音 */
const deleteByIdsParsed = computed(() => {
  const raw = deleteByIdsText.value.trim()
  if (!raw) return []
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
  return Array.from(new Set(raw.match(uuidRe) ?? []))
})

function openDeleteByIds() {
  deleteByIdsText.value = ''
  showDeleteByIdsModal.value = true
}

async function handleDeleteByIds() {
  const ids = deleteByIdsParsed.value
  if (ids.length === 0 || deletingByIds.value) return
  // 先关粘贴弹窗，再走统一的确认流程（复选框确认，与批量删除一致）
  showDeleteByIdsModal.value = false
  const decision = await askConfirmWithOptions(
    t('lottery.adminConfirmBatchDelete', { count: ids.length, drawnCount: 0 }),
    {
      options: [
        {
          key: 'confirmDelete',
          label: t('lottery.adminBatchDeleteConfirmCheckbox', { count: ids.length }),
          defaultChecked: false,
        },
      ],
    },
  )
  if (!decision.confirmed) return
  // ConfirmDialog 确认按钮不受复选框禁用（phraseOk 仅管 requirePhrase），
  // 调用方必须显式校验勾选态，否则"复选框防误删"形同虚设（docs/255 审查修复）
  if (decision.options.confirmDelete !== true) {
    showToast(t('lottery.adminBatchDeleteRequireCheckbox'), 'info')
    return
  }

  deletingByIds.value = true
  try {
    const data = await batchDeleteLotteryDraws(ids, false)
    if (data.deleted === 0 && data.failed === 0) {
      showToast(t('lottery.adminBatchNothingDone'), 'info')
    } else if (data.failed > 0) {
      showToast(t('lottery.adminBatchDeleteResult', { success: data.deleted, failed: data.failed }), 'error')
    } else {
      showToast(t('lottery.adminBatchDeleteSuccess', { count: data.deleted }), 'success')
    }
  } catch {
    showToast(t('lottery.adminBatchDeleteFailed'), 'error')
  } finally {
    deletingByIds.value = false
    await loadData()
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

  // 调试/测试清场（docs/241）：以下两类场景提供 force 复选框，默认不勾选（安全删除）：
  // ① 选中含 open/drawing（进行中）；② 选中含支付类活动（秒杀直付，可能残留 expired 订单）。
  // 勾选后 force=true → 后端放行 open/drawing，并对「所有订单均为 expired」的测试残留
  // 先清理订单链再删除；有任一非 expired 订单（paid/refunded 等资金痕迹）仍 fail-closed 拒绝。
  const hasLive = selectedDraws.some((draw) => draw.status === 'open' || draw.status === 'drawing')
  const hasPaymentActivity = selectedDraws.some((draw) => isPaymentDraw(draw))
  const needForceOption = hasLive || hasPaymentActivity
  let force = false
  if (needForceOption) {
    const liveCount = selectedDraws.filter((d) => d.status === 'open' || d.status === 'drawing').length
    const decision = await askConfirmWithOptions(
      t('lottery.adminConfirmBatchDeleteForce', { count: selectedDraws.length, liveCount }),
      { options: [{ key: 'force', label: t('lottery.adminBatchDeleteForceOption') }] },
    )
    if (!decision.confirmed) return
    force = decision.options.force === true
  } else {
    // 非进行中（draft/drawn/cancelled/paused）：复选框确认，防误删
    const decision = await askConfirmWithOptions(
      t('lottery.adminConfirmBatchDelete', { count: selectedDraws.length, drawnCount }),
      {
        options: [
          {
            key: 'confirmDelete',
            label: t('lottery.adminBatchDeleteConfirmCheckbox', { count: selectedDraws.length }),
            defaultChecked: false,
          },
        ],
      },
    )
    if (!decision.confirmed) return
    // 同上：复选框防误删需调用方显式校验勾选态（ConfirmDialog 确认按钮不检查复选框）
    if (decision.options.confirmDelete !== true) {
      showToast(t('lottery.adminBatchDeleteRequireCheckbox'), 'info')
      return
    }
  }

  const targetIds = selectedDraws.map((d) => d.id)
  // 标记 busy 供 bulk-bar；勿与 runBatchSequential 重叠占用 operating
  batchOperating.value = true
  batchCompleted.value = 0
  batchTotal.value = targetIds.length
  try {
    const data = await batchDeleteLotteryDraws(targetIds, force)
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
  // docs/223：是否锁定结构字段取决于是否已有 entry/order/winner 事实，而非仅看活动状态。
  // 详情请求失败时先 fail closed，避免把不完整的数据当成可安全修改。
  const isLive = draw.status === 'open' || draw.status === 'paused'
  editLocked.value = isLive
  if (!['draft', 'open', 'paused'].includes(draw.status)) {
    showToast(t('lottery.adminEditNonDraft'), 'error')
    return
  }
  // 调详情 API 获取完整活动数据（含奖项配置 tiers + promotionConfig）
  let tiers: Array<{ prizeId: string; tierName: string; winnerCount: number; weight?: number }> = []
  let detailDraw: Record<string, any> | null = null
  try {
    const detail = await adminRequest<{
      draw: any
      tiers: Array<{ prizeId: string; tierName: string; winnerCount: number; weight?: number }>
      editPolicy?: { structuralFieldsLocked?: boolean }
    }>(`/api/admin/draws/${draw.id}`)
    if (detail.tiers) {
      tiers = detail.tiers.map(t => ({
        prizeId: t.prizeId || '',
        tierName: t.tierName || '',
        winnerCount: t.winnerCount || 1,
        weight: Number(t.weight) || 0,
      }))
    }
    if (detail.draw) detailDraw = detail.draw
    editLocked.value = Boolean(detail.editPolicy?.structuralFieldsLocked)
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
    expectedParticipants: Number(draw.expectedParticipants ?? 0),
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
    // docs/218 保底/每日免费/排行榜奖励：编辑回填防整包覆盖擦掉配置
    enablePity: growth.enablePity,
    pityThreshold: growth.pityThreshold,
    enableDailyFreeSpins: growth.enableDailyFreeSpins,
    dailyFreeSpinsCount: growth.dailyFreeSpinsCount,
    leaderboardRewardsText: growth.leaderboardRewardsText,
    // docs/250/254 引擎推荐奖励：编辑回填防整包覆盖擦掉配置
    referralRewardDefsText: growth.referralRewardDefsText,
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
    flashSaleSalesMode: growth.flashSaleSalesMode,
    flashSaleStockLimit: growth.flashSaleStockLimit,
    flashSaleMaxPerUser: alignFlashSaleMaxPerUser(growth.flashSalePricingTiers, growth.flashSaleMaxPerUser),
    flashSaleCtaLabel: growth.flashSaleCtaLabel,
    flashSaleShowCountdown: growth.flashSaleShowCountdown !== false,
    flashSaleShowProgress: growth.flashSaleShowProgress !== false,
    flashSaleShowStock: growth.flashSaleShowStock !== false,
    flashSalePaymentRequired: growth.flashSalePaymentRequired === true,
    flashSalePriceCents: growth.flashSalePriceCents,
    flashSaleCurrency: growth.flashSaleCurrency || 'cny',
    flashSaleTitle: growth.flashSaleTitle || '',
    flashSaleImageUrl: growth.flashSaleImageUrl || '',
    flashSalePricingTiers: growth.flashSalePricingTiers || [],
  }
  isEditing.value = true
  // 引擎推荐奖励行编辑器：从回填的 text 解析行（docs/255 ③）
  syncReferralRewardDefsRowsFromText()
  // docs/225 P0：按 ids 回填已绑定奖品（即使停用/不在当前页也要显示名称）
  loadBoundPrizes(tiers.map(t => t.prizeId))
  // 回填未中奖自动发券开关状态
  initLoserRewardFromConfig()
  // 回填邀请奖励配置（docs/259 P1-3）
  initRewardFromConfig()
  // 编辑已设访问密码的 password 活动：表单内提示「留空保持不变」，
  // 避免运营看到空密码框以为密码丢了（后端只回 hasAccessPassword 布尔，不回哈希）
  editingHasAccessPassword.value =
    source.hasAccessPassword === true && form.value.participationMode === 'password'
  // 已有裂变/导流时展开高级增长区，否则运营看不到「已开启」状态（易二次保存擦掉）
  showAdvancedGrowth.value = growth.hasGrowthConfig
  activeTemplateId.value = ''
  activeTemplateName.value = ''
  activeTemplateHints.value = []
  // 缺奖项时焦点落在步骤 4，方便门禁失败后的补齐路径
  const needPrizes = (draw.activityKind || 'lottery') === 'lottery'
    && !tiers.some((tier) => Boolean(tier.prizeId))
  createStepFocus.value = needPrizes ? 4 : 1
  showCreateModal.value = true
  if (needPrizes) nextTick(() => focusCreateStep(4))

  // ── 修复 #10：编辑 roster 模式时加载已有名单成员，供运营确认/追加 ──
  if (draw.participationMode === 'roster') {
    loadRosterForEdit(draw.id).catch(() => { /* 加载失败不阻塞编辑流程 */ })
  }
  // ── 修复 #11：编辑 invite_code 模式时加载已有邀请码数量，避免重复生成 ──
  if (draw.participationMode === 'invite_code') {
    loadInviteCodeCountForEdit(draw.id).catch(() => { /* 加载失败不阻塞编辑流程 */ })
  }
}

/**
 * 加载已有名单成员到 rosterInput（编辑回显用）。
 * 不阻塞编辑流程，失败时保持空输入框。
 */
async function loadRosterForEdit(drawId: string) {
  try {
    const data = await adminRequest<{ members: Array<{ identityValue: string; displayName: string }>; totalCount: number }>(
      `/api/admin/draws/${drawId}/roster`,
    )
    if (data.members?.length > 0) {
      // 把名单成员转换为「每行一个邮箱」的格式，与 saveDrawRoster 的 split/join 一致
      rosterInput.value = data.members.map((m) => m.identityValue).join('\n')
    }
  } catch {
    // roster 加载失败不阻断编辑主流程
    rosterInput.value = ''
  }
}

/**
 * 加载已有邀请码数量到 inviteCodeCount（编辑回显用）。
 * 不阻塞编辑流程，失败时保持默认值 10。
 */
async function loadInviteCodeCountForEdit(drawId: string) {
  try {
    const data = await adminRequest<{ codes: Array<unknown>; totalCount: number }>(
      `/api/admin/draws/${drawId}/invite-codes`,
    )
    if (data.totalCount > 0) {
      inviteCodeCount.value = data.totalCount
    }
  } catch {
    // 邀请码加载失败不阻断编辑主流程
    inviteCodeCount.value = 10
  }
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
 * 排行榜奖励可发放判定：instant 活动须「已结束」才允许手动发放。
 * 活动进行中发放会锁定当前排名快照，之后的邀请不再计入（与后端端点 endAt 校验同语义）。
 * - drawn/closed：已开奖/已关闭 → 已结束
 * - 无 endAt：视为可发放（与后端 endAt 为空时放行一致）
 * - 否则 endAt 已过 → 已结束
 */
function isDrawEndedForLeaderboard(draw: { status?: string; endAt?: string | null }): boolean {
  const status = String(draw.status || '')
  if (status === 'drawn' || status === 'closed') return true
  if (!draw.endAt) return true
  return Date.now() >= new Date(draw.endAt).getTime()
}

/**
 * 发放排行榜奖励（docs/218 模式三）。
 * 仅对 instant 模式手动调用；delayed 模式在 performDraw 时自动发放。
 * 后端幂等：已发放的 shareRecord 自动跳过。
 */
async function handleGrantLeaderboardRewards(id: string) {
  operatingId.value = id
  try {
    const result = await grantLeaderboardRewards(id)
    if (result.granted > 0 || result.skipped > 0) {
      showToast(t('lottery.adminGrantLeaderboardSuccess', { granted: result.granted, skipped: result.skipped }), 'success')
    } else {
      showToast(t('lottery.adminGrantLeaderboardNone'), 'info')
    }
    await loadData()
  } catch (e) {
    showToast(toErrorMessage(e, t('lottery.adminFailed')), 'error')
  } finally {
    operatingId.value = ''
  }
}

/**
 * 打开奖励发放失败记录弹窗（docs/259 P1-2）。
 *
 * 数据来源：后端 GET /draws/:id/rewards/failures 查询 activity_events 中
 * eventType='reward_failed' 的记录。每条记录包含：
 * - entryId：触发奖励的分享者参与 ID（用于 entryId 过滤补发）
 * - refCode：分享码（用于关联分享链路）
 * - path：失败路径（grantViralSpinsToSharer / processReferralRewardsEngine / triggerRewardEarned）
 * - error：错误信息（供运营判断是否需要人工介入）
 *
 * 重置逻辑：每次打开弹窗重置 entryId 过滤条件，避免上次过滤条件残留。
 */
async function openRewardFailuresModal(id: string) {
  rewardFailuresDrawId.value = id
  reissueEntryId.value = '' // 重置 entryId 过滤条件
  rewardFailuresLoading.value = true
  rewardFailures.value = []
  showRewardFailuresModal.value = true
  try {
    const data = await fetchRewardFailures(id)
    rewardFailures.value = data.failures || []
  } catch (e) {
    showToast(toErrorMessage(e, t('lottery.adminFailed')), 'error')
    showRewardFailuresModal.value = false
  } finally {
    rewardFailuresLoading.value = false
  }
}

/**
 * 补发奖励（docs/259 P1-2）。
 *
 * 两种调用模式：
 * - all=false（默认）：仅重试最近一条失败记录，适用于"单个用户反馈未收到奖励"
 * - all=true：批量重试该活动所有失败记录，适用于"活动结束后批量补发"
 *
 * entryId 过滤：若运营在弹窗中输入了 entryId，仅补发该用户的失败记录。
 * 适用于客服场景："用户 A 投诉未收到邀请奖励"→ 输入 A 的 entryId → 精确补发。
 *
 * 安全保障：后端 triggerRewardEarned 内部有 perUserPerDay / globalPerDay 配额检查，
 * 即使前端重复调用或后端重试，也不会超发。
 */
async function handleReissueReward(id: string, all = false) {
  if (!(await askConfirm(t('lottery.adminConfirmReissueReward')))) return
  operatingId.value = id
  try {
    const result = await reissueReward(id, all, reissueEntryId.value || undefined)
    if (result.reissued) {
      showToast(t('lottery.adminReissueRewardSuccess'), 'success')
      // 若弹窗开启，刷新失败列表
      if (showRewardFailuresModal.value && rewardFailuresDrawId.value === id) {
        await openRewardFailuresModal(id)
      }
    } else {
      showToast(t('lottery.adminReissueRewardFailed', { reason: result.reason || '-' }), 'error')
    }
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
  // 创建/复制时无锁定；仅 handleEdit 对 open/paused 设置 editLocked
  editLocked.value = false
  if (creating.value) return
  if (!form.value.name || !form.value.startTime || !form.value.endTime) {
    showToast(t('lottery.adminFillNameTime'), 'error')
    return
  }
  if (timeOrderError.value) {
    showToast(timeOrderError.value, 'error')
    return
  }
  // 原生约束校验已禁用（novalidate），补全必填项检查——否则 v-show 折叠区内
  // 的 required/min/max 控件在值非法时浏览器会抛 "is not focusable" 崩溃。
  if (form.value.activityKind === 'lottery') {
    const wc = Number(form.value.winnerCount)
    if (!wc || wc < 1 || wc > 9999 || !Number.isFinite(wc)) {
      showToast(t('lottery.adminFillRequired'), 'error')
      return
    }
    if (form.value.resultMode === 'instant') {
      const ms = Number(form.value.maxSpinsPerEntry)
      if (!ms || ms < 1 || ms > 100 || !Number.isFinite(ms)) {
        showToast(t('lottery.adminFillRequired'), 'error')
        return
      }
    }
  }
  creating.value = true
  try {
    // 注意：后端 API 使用 title/startAt/endAt/drawAt/winnerCount 字段名
    // 前端 form 使用 name/startTime/endTime/drawTime 需要映射
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
      winnerCount: (activityKind === 'lottery' || (activityKind === 'claim' && form.value.experienceType === 'flash_sale'))
        ? Number(form.value.winnerCount) || 1 : 0,
      maxParticipants: form.value.maxParticipants ? Number(form.value.maxParticipants) : undefined,
      // 预计参与人数（运营参考值，仅展示用）：非负数时发送，0 表示未设置
      expectedParticipants: form.value.expectedParticipants >= 0 ? Number(form.value.expectedParticipants) : 0,
      participationMode: form.value.participationMode || 'open',
      experienceType: form.value.experienceType || defaultExperienceForActivity(activityKind, form.value.participationMode || 'open'),
      activityKind,
      // lottery delayed：resultMode 跟 drawTrigger；instant 由 schedule 保留；非 lottery 保留表单默认
      resultMode: schedule.resultMode,
      // instant：每人 spin 次数硬顶（后端仅 lottery+instant 写入；claim 等默认 instant 的类型不适用）
      ...(activityKind === 'lottery' && schedule.resultMode === 'instant'
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
          syncRewardConfig()
          const config = form.value.activityConfig as any
          return {
            version: 1,
            kind: 'lottery',
            loserReward: config?.loserReward || { enabled: false, couponLabel: '' },
            // reward 存在即写入，不以 perInviteAmount > 0 为门槛——amount=0 由后端 triggerRewardEarned
            // 的 `perInviteAmount <= 0 → no_reward_config` 分支处理，前端不应提前丢弃配置。
            ...(config?.reward ? { reward: config.reward } : {}),
            // quota 在 activityConfig 顶层，与后端 triggerRewardEarned 的 config?.quota 读取路径对齐
            ...(config?.quota ? { quota: config.quota } : {}),
          }
        }
        // 其他活动类型（checkin/signup_chain/claim/approval/reservation/waitlist 等）：
        // 如果表单有 activityConfig.kind，透传以保留配置；否则留空
        const cfg = form.value.activityConfig as any
        if (cfg && cfg.kind) {
          return normalizeActivityConfig(form.value.activityKind || 'lottery', cfg)
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
      if (current && !['draft', 'open', 'paused'].includes(current.status)) {
        showToast(t('lottery.adminEditNonDraft'), 'error')
        closeEditor()
        form.value = emptyForm()
        return
      }
      // 已有参与事实的 live 编辑只提交后端明确允许的安全字段；不能让完整表单
      // 隐式携带 promotionConfig、奖项或支付配置，破坏已经生效的用户合同。
      const updatePayload = editLocked.value
        ? {
            title: payload.title,
            description: payload.description,
            endAt: payload.endAt,
            expectedParticipants: payload.expectedParticipants,
            showParticipantCount: payload.showParticipantCount,
            showWinnerCount: payload.showWinnerCount,
            showWinnerList: payload.showWinnerList,
            productLink: payload.productLink,
          }
        : payload
      await updateLotteryDraw(form.value.id, updatePayload)
      // ★ 创建与编辑共用：名单导入 / 邀请码生成 / 奖项配置（防止编辑分支遗漏）
      // 已有参与/支付事实时，这些资源也是规则的一部分，不能再通过后续接口绕过 PATCH 白名单。
      if (!editLocked.value) {
        await saveDrawRoster(form.value.id)
        await saveDrawInviteCodes(form.value.id)
      }
      // 仅抽奖或直付秒杀需要奖项配置；资料领取/领券等 claim 活动不调用（后端会拒绝）
      if (!editLocked.value && needsTiersActivity(form.value.activityKind, form.value.experienceType || '')) {
        await saveDrawTiers(form.value.id)
      }
      // P1 体验：保存成功后回显清洗后的仪式短语，运营者立即看到哪些被保留/被拒。
      // sanitizeRitualPhrasesForSave 与提交清洗同源（docs/128）；不回显会显得「填的短语丢了」。
      form.value.ritualPhrasesText = sanitizeRitualPhrasesForSave(
        form.value.ritualPhrasesText ?? '',
      ).join('\n')
      showToast(t('lottery.adminDrawUpdated'), 'success')
      // draft 已有完整的活动、奖项与卡密绑定事实，保存后立即取一次服务端预检。
      // 这样支付渠道/库存等无法由本地表单判定的问题，不必等到运营点击“开启”活动才暴露。
      if (current?.status === 'draft') {
        showSavedDraftPublishIssues(await refreshDraftPublishBlocker(form.value.id))
      }
    } else {
      const created = await createLotteryDraw(payload)
      if (created?.id) {
        // 如果是 roster 模式，导入名单
        await saveDrawRoster(created.id)
        // 如果是 invite_code 模式，生成邀请码
        await saveDrawInviteCodes(created.id)
        // 仅抽奖或直付秒杀保存奖项配置；资料领取/领券等 claim 活动不调用（后端会拒绝）
        if (needsTiersActivity(form.value.activityKind, form.value.experienceType || '')) {
          await saveDrawTiers(created.id)
        }
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
        // 所有关联资源保存完成后再预检，否则会把尚未保存的奖项/名单误判为缺失。
        const publishCheck = await refreshDraftPublishBlocker(created.id)
        if (lotteryMissingTier) {
          showToast(t('lottery.adminCreatedNeedPrizeHint'), 'success')
          showSavedDraftPublishIssues(publishCheck)
          if (previewSlug && await askOpenPublicPreview(t('lottery.adminCreateNeedPrizeWithPreview'))) {
            handleOpenPublic({ publicSlug: previewSlug } as LotteryDraw)
          }
        } else {
          showToast(t('lottery.adminCreateDoneWithLink'), 'success')
          showSavedDraftPublishIssues(publishCheck)
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
  if (prizeSearchTimer) clearTimeout(prizeSearchTimer)
  window.removeEventListener('scroll', onMoreMenuScroll, true)
  window.removeEventListener('resize', onMoreMenuResize)
  window.removeEventListener('keydown', onMoreMenuKeydown)
  moreBtnRefs.clear()
})
</script>
<style>
@import '@/assets/admin.css';
@import './lottery/admin-lottery-page.css';

/* 按 ID 批量删除弹窗（docs/257）：粘贴框等宽字体，便于核对 UUID */
.delete-by-ids-input {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
  border-radius: var(--r-md, 8px);
  background: var(--tg-secondary-bg, #151b28);
  color: var(--tg-text, #f0f2f5);
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  line-height: 1.6;
  resize: vertical;
}

.delete-by-ids-input:focus {
  outline: 2px solid rgba(239, 68, 68, 0.45);
  outline-offset: 1px;
}

.delete-by-ids-hint {
  font-size: 12px;
  color: var(--tg-hint, #9aa4b2);
  line-height: 1.6;
  margin: 8px 0 0;
}
</style>
