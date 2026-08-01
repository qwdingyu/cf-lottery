<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <select v-model="statusFilter" :aria-label="$t('lottery.adminStatus')">
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
        <button class="btn btn-primary btn-sm" type="button" :disabled="loading || creating" @click="openCreate">
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
            <th>{{ $t('lottery.product') }}</th>
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
                <span class="draw-name">{{ draw.name }}</span>
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
                <span>{{ draw.title }}</span>
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
                  @click="handleOpen(draw.id)"
                >{{ operatingId === draw.id ? '加载中…' : $t('lottery.adminDrawOpen') }}</button>
                <button
                  v-if="draw.status === 'open'"
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
                  v-if="draw.status === 'drawn' || draw.status === 'drawing'"
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

    <!-- 创建/编辑活动：对齐商品编辑分区布局 + 时间快捷与校验 -->
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
              <label class="field-span-2">
                <span>{{ $t('lottery.product') }}</span>
                <input
                  v-model="form.productName"
                  placeholder="奖品名称（选填）"
                  maxlength="100"
                />
                <small class="field-hint">{{ $t('lottery.adminProductHint') }}</small>
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
                <span>参与模式</span>
                <select v-model="form.participationMode">
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
                  <option value="submit">普通提交</option>
                </select>
                <small class="field-hint">互动体验只影响活动页展示，不决定参与资格或开奖结果</small>
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

          <section class="form-section" aria-labelledby="lottery-prizes">
            <header class="form-section-head">
              <h4 id="lottery-prizes" class="form-section-title">{{ $t('lottery.adminSectionPrizes') }}</h4>
              <p class="form-section-desc">{{ $t('lottery.adminSectionPrizesDesc') }}</p>
            </header>
            <div class="form-grid two-cols">
              <label>
                <span>{{ $t('lottery.winnerCount') }}</span>
                <input v-model.number="form.winnerCount" type="number" min="1" max="9999" step="1" required />
                <small class="field-hint">{{ $t('lottery.winnerCountHint') }}</small>
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
  </div>
</template>

<script setup lang="ts">
/**
 * 抽奖管理页 — cf-lottery 适配版。
 */
import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { useAdminAuth } from '@/composables/useAdminAuth'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useTableSelection } from '@/composables/useTableSelection'
import { formatDate, dateTimeLocalToIso, toDateTimeLocalValue } from '@/composables/useFormat'
import { writeClipboardText } from '@/composables/useClipboard'
import AdminModal from '@/components/AdminModal.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

/** 管理端 API 请求封装 */
async function adminRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const token = (() => { try { return localStorage.getItem('admin_token') || ''; } catch { return ''; } })();
  const headers: Record<string,string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json();
  if (!data.ok) throw new Error(data.message || `请求失败: ${res.status}`);
  return data as T;
}

type LotteryDraw = {
  id: string; tenantId: string; publicSlug: string; title: string; name?: string; description: string;
  status: string; activityKind: string; participationMode: string; experienceType: string; drawTrigger: string; resultMode: string; policyVersion: number;
  startAt: string; startTime?: string; endAt: string; endTime?: string; drawAt: string | null; drawTime?: string | null;
  winnerCount: number; maxParticipants: number | null;
  maxWinners?: number; expectedParticipants?: number; entryCount?: number; visible?: number;
  showParticipantCount: number; showWinnerCount: number; showWinnerList: number;
  drawnAt: string | null; failureReason: string;
  createdAt: string; updatedAt: string;
};

type LotteryWinner = {
  id: string; drawId: string; tierId: string; entryId: string;
  identityType: string; identityValue: string; prizeCodeId: string;
  drawnAt: string; notificationStatus: string; notificationError: string;
  email?: string; orderNo?: string; cardAccountLabel?: string; cardDeliverySecret?: string;
  emailSent?: number; emailError?: string;
};

const { t, locale } = useI18n()
const { showToast } = useToast()
useAdminAuth()
const { confirmVisible, confirmMessage, askConfirm, onConfirm } = useConfirmDialog()

// ── 兼容旧 API 调用（适配到新后端） ──
const requireToken = () => { try { return localStorage.getItem('admin_token') || ''; } catch { return ''; } };
const fetchLotteryDraws = async (_token: string) => adminRequest<{ draws: LotteryDraw[] }>('/api/admin/draws');
const createLotteryDraw = async (_token: string, body: any) => adminRequest<{ id: string; publicSlug: string }>('/api/admin/draws', { method: 'POST', body: JSON.stringify(body) });
const updateLotteryDraw = async (_token: string, id: string, body: any) => adminRequest(`/api/admin/draws/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
const openLotteryDraw = async (_token: string, id: string) => adminRequest(`/api/admin/draws/${id}/publish`, { method: 'POST' });
const performLotteryDraw = async (_token: string, id: string) => adminRequest(`/api/admin/draws/${id}/draw`, { method: 'POST' });
const cancelLotteryDraw = async (_token: string, id: string) => adminRequest(`/api/admin/draws/${id}/cancel`, { method: 'POST' });
const deleteLotteryDraw = async (_token: string, id: string) => adminRequest(`/api/admin/draws/${id}`, { method: 'DELETE' });
const fetchLotteryWinners = async (_token: string, id: string) => adminRequest<{ winners: LotteryWinner[] }>(`/api/admin/draws/${id}/winners`);
const fetchAdminLottery = async (_token: string, path: string, method: string) => adminRequest(path, { method });
const retryAdminLotteryEmail = async (_token: string, id: string) => adminRequest<{ sent: number; failed: number }>(`/api/admin/draws/${id}/retry-email`, { method: 'POST' });
const recoverLotteryDraw = async (_token: string, id: string) => adminRequest<{ healed: 'drawn' | 'open' }>(`/api/admin/draws/${id}/recover`, { method: 'POST' });

// ── 内联 lottery-ops 函数 ──
const filterAndSortLotteryDraws = (draws: LotteryDraw[], opts: { status: string; query: string }) => {
  let r = draws;
  if (opts.status) r = r.filter(d => d.status === opts.status);
  if (opts.query) { const q = opts.query.toLowerCase(); r = r.filter(d => d.title.toLowerCase().includes(q) || d.id.toLowerCase().includes(q)); }
  return r.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};
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
  experienceType: draw.experienceType || defaultExperienceForParticipation(draw.participationMode || 'open'),
  accessPassword: '',
});
const buildLotteryDrawConfirmMessage = (draw: any, labels: any) => `${labels.title}\n${labels.name}${draw.title}\n${labels.pool}${draw.entryCount || 0}\n${labels.willDraw}${Math.min(Number(draw.entryCount)||0, draw.winnerCount)}`;

/** 下载 CSV */
function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
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
const showWinnersModal = ref(false)
const showQrModal = ref(false)
const qrImageUrl = ref('')
const qrDrawUrl = ref('')
const winners = ref<LotteryWinner[]>([])
const winnersLoading = ref(false)
/** 中奖弹窗对应的活动 id，便于弹窗内一键重发失败邮件 */
const winnersModalDrawId = ref('')
const creating = ref(false)
const operatingId = ref('')
// batchOperating 必须在 useTableSelection 之前声明，确保模板访问时已初始化
const batchOperating = ref(false)
let loadSequence = 0
let winnersStatusTimer: ReturnType<typeof setInterval> | null = null
let winnersStatusRefreshes = 0
let winnersStatusInFlight = false
const MAX_WINNERS_STATUS_REFRESHES = 10

const filteredDraws = computed(() =>
  filterAndSortLotteryDraws(draws.value, {
    status: statusFilter.value,
    query: listQuery.value,
  }),
)

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
  participationMode: 'open',
  experienceType: 'wheel',
  accessPassword: '',
  showWinners: false,
  // 导流配置
  enableProductLink: false,
  productLink: { url: '', title: '', imageUrl: '', price: '' },
})

const form = ref(emptyForm())
const isEditing = ref(false)
const rosterInput = ref('')
const inviteCodeCount = ref(10)

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
    const data = await fetchLotteryWinners(requireToken(), id)
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
function handleShowQrCode(draw: LotteryDraw) {
  const url = `${window.location.origin}/lottery/${draw.publicSlug}`
  qrDrawUrl.value = url
  qrImageUrl.value = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}`
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
    experienceType: draft.experienceType,
    accessPassword: draft.accessPassword,
    enableProductLink: false,
    productLink: { url: '', title: '', imageUrl: '', price: '' },
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

function openCreate() {
  const base = emptyForm()
  form.value = base
  isEditing.value = false
  // 默认填 1 天档，避免空白 datetime-local 难用；再保留 emptyForm 的业务默认值
  applyTimePreset('1d')
  form.value = {
    ...form.value,
    id: '',
    name: '',
    description: '',
    maxWinners: 1,
    maxParticipants: null,
    expectedParticipants: 0,
  }
  showCreateModal.value = true
}

async function loadData() {
  const sequence = ++loadSequence
  loading.value = true
  loadError.value = ''
  try {
    const data = await fetchLotteryDraws(requireToken())
    if (sequence !== loadSequence) return
    draws.value = data.draws || []
  } catch (e: any) {
    if (sequence !== loadSequence) return
    draws.value = []
    loadError.value = e?.message || t('lottery.adminLoadFailed')
    showToast(loadError.value, 'error')
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function handleOpen(id: string) {
  operatingId.value = id
  try {
    await openLotteryDraw(requireToken(), id)
    // 开启后立刻把投放链接放进剪贴板，少一步手动复制
    try {
      await writeClipboardText(publicShareUrl(id))
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
    await performLotteryDraw(requireToken(), draw.id)
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
    const data = await fetchLotteryWinners(requireToken(), id)
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
    await cancelLotteryDraw(requireToken(), id)
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
    await deleteLotteryDraw(requireToken(), id)
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
        await deleteLotteryDraw(requireToken(), id)
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
    await fetchAdminLottery(requireToken(), `lottery/draws/${id}/pause`, 'POST')
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
    await fetchAdminLottery(requireToken(), `lottery/draws/${id}/resume`, 'POST')
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
    experienceType: draw.experienceType || defaultExperienceForParticipation(draw.participationMode || 'open'),
  }
  isEditing.value = true
  showCreateModal.value = true
}

async function handleToggleVisibility(id: string, visible: number | undefined) {
  if (!(await askConfirm(t('lottery.adminConfirmToggleVisibility')))) return
  operatingId.value = id
  try {
    await updateLotteryDraw(requireToken(), id, { visible: visible ? 0 : 1 })
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
    const result = await retryAdminLotteryEmail(requireToken(), id)
    if (result.sent > 0 || result.failed === 0) {
      showToast(t('lottery.adminRetrySuccess', { sent: result.sent }), 'success')
    } else {
      showToast(t('lottery.adminRetryFailed', { failed: result.failed }), 'error')
    }
    // 若中奖弹窗正打开同一活动，刷新名单上的发送态
    if (showWinnersModal.value && winnersModalDrawId.value === id) {
      try {
        const data = await fetchLotteryWinners(requireToken(), id)
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
    const result = await recoverLotteryDraw(requireToken(), id)
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
      winnerCount: Number(form.value.winnerCount) || 1,
      maxParticipants: form.value.maxParticipants ? Number(form.value.maxParticipants) : undefined,
      participationMode: form.value.participationMode || 'open',
      experienceType: form.value.experienceType || defaultExperienceForParticipation(form.value.participationMode || 'open'),
      activityKind: 'lottery',
      resultMode: 'manual',
      accessPassword: form.value.accessPassword || '',
      // 导流：商品链接（启用时发送，关闭时发送 undefined）
      productLink: form.value.enableProductLink && form.value.productLink.url
        ? form.value.productLink
        : undefined,
      // 导流：版本化配置（PromotionConfigV1）
      promotionConfig: form.value.enableProductLink && form.value.productLink.url
        ? {
            version: 1,
            enabled: true,
            kind: 'destination',
            placement: 'after_join',
            destination: {
              url: form.value.productLink.url,
              title: form.value.productLink.title,
              imageUrl: form.value.productLink.imageUrl || '',
              priceText: form.value.productLink.price || '',
            },
            tracking: { enabled: true },
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
      await updateLotteryDraw(requireToken(), form.value.id, payload)
      showToast('活动已更新', 'success')
    } else {
      const created = await createLotteryDraw(requireToken(), payload)
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
        try {
          await writeClipboardText(publicShareUrl(created.publicSlug || created.id))
          showToast('活动已创建，链接已复制', 'success')
        } catch {
          showToast('活动已创建', 'success')
        }
      } else {
        showToast('活动已创建', 'success')
      }
    }
    closeEditor()
    form.value = emptyForm()
    await loadData()
  } catch (e: any) {
    showToast(e?.message || '创建失败', 'error')
  } finally {
    creating.value = false
  }
}

onMounted(loadData)
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
</style>
