<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="loadData">
          {{ loading ? '加载中…' : '刷新' }}
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" type="button" :disabled="loading" @click="showCreate = true">
          创建奖品
        </button>
      </div>
    </div>

    <div v-if="loadError" class="table-error" role="alert">
      <span>{{ loadError }}</span>
      <button class="btn btn-ghost btn-xs" :disabled="loading" @click="loadData">重试</button>
    </div>

    <div class="table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>图片</th>
            <th>名称</th>
            <th>类型</th>
            <th>价值</th>
            <th>描述</th>
            <th>码池余量</th>
            <th>创建时间</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 3" :key="'sk' + i" class="skeleton-row">
            <td :colspan="8"><div class="skeleton-cell" /></td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="prize in prizes" :key="prize.id">
            <td>
              <img :src="prizeImageUrl(prize.imageUrl)" :alt="prize.name || '奖品'" class="prize-thumb" />
            </td>
            <td>
              {{ prize.name }}
              <small v-if="prize.fulfillmentNote" class="field-hint" style="display:block;max-width:200px">📋 {{ prize.fulfillmentNote }}</small>
            </td>
            <td>{{ prize.prizeType === 'code' ? '卡密' : '手动发放' }}</td>
            <td>{{ prize.valueText || '-' }}</td>
            <td>{{ prize.description || '-' }}</td>
            <td>
              <template v-if="prize.prizeType === 'code'">
                <span :class="{ 'tag-danger': (prize.totalCount - prize.usedCount) <= 0, 'tag-success': (prize.totalCount - prize.usedCount) > 0 }">
                  {{ prize.usedCount || 0 }}/{{ prize.totalCount || 0 }}
                </span>
                <small class="field-hint" style="display:block">剩余 {{ Math.max(0, (prize.totalCount || 0) - (prize.usedCount || 0)) }}</small>
              </template>
              <template v-else>—</template>
            </td>
            <td>{{ prize.createdAt }}</td>
            <td class="col-actions">
              <button v-if="prize.prizeType === 'code'" class="btn btn-ghost btn-xs" @click="showImport(prize)">导入码</button>
              <button v-if="prize.prizeType === 'code'" class="btn btn-ghost btn-xs" @click="showCodes(prize)">查看码</button>
              <button class="btn btn-ghost btn-xs" @click="showEdit(prize)">编辑</button>
              <button class="btn btn-ghost btn-xs" :title="prize.active ? '停用后活动不可选用此奖品' : '启用后活动可选用此奖品'" @click="toggleActive(prize)">
                {{ prize.active !== 0 ? '停用' : '启用' }}
              </button>
            </td>
          </tr>
          <tr v-if="prizes.length === 0">
            <td colspan="8" class="empty-text">暂无奖品</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 创建奖品弹窗 -->
    <AdminModal v-model="showCreate" title="创建奖品" max-width="480px">
      <form @submit.prevent="handleCreate">
        <div class="modal-form">
          <label>
            <span>奖品名称</span>
            <input v-model="form.name" required maxlength="100" placeholder="请输入奖品名称" />
          </label>
          <label>
            <span>奖品类型</span>
            <select v-model="form.prizeType">
              <option value="code">卡密/券码</option>
              <option value="manual_fulfillment">手动发放</option>
            </select>
          </label>
          <label>
            <span>描述</span>
            <textarea v-model="form.description" maxlength="500" rows="2" placeholder="奖品说明（可选）" />
          </label>
          <label>
            <span>图片 URL</span>
            <div class="prize-image-editor">
              <img :src="prizeImageUrl(form.imageUrl)" alt="奖品图片预览" class="prize-preview" />
              <div class="prize-image-fields">
                <div class="image-upload-row">
                  <label class="btn btn-ghost btn-sm image-upload-button" :class="{ 'is-disabled': uploadingImage }">
                    {{ uploadingImage ? '上传中...' : '上传图片' }}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/avif"
                      :disabled="uploadingImage"
                      @change="uploadPrizeImage"
                    />
                  </label>
                  <small class="field-hint">JPEG、PNG、WebP、AVIF，最大 2MiB</small>
                </div>
                <input v-model="form.imageUrl" maxlength="500" placeholder="不上传则使用默认图" />
              </div>
            </div>
          </label>
          <label>
            <span>价值</span>
            <input v-model="form.valueText" maxlength="50" placeholder="展示文案，如 50 USDT（可选）" />
            <small class="field-hint">只作为奖品吸引力展示，不参与金额计算</small>
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="showCreate = false">取消</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="submitting">
            {{ submitting ? '创建中…' : '创建' }}
          </button>
        </div>
      </form>
    </AdminModal>

    <!-- 编辑奖品弹窗（复用创建表单） -->
    <AdminModal v-model="showEditModal" title="编辑奖品" max-width="480px">
      <form @submit.prevent="handleEdit">
        <div class="modal-form">
          <label>
            <span>奖品名称</span>
            <input v-model="editForm.name" required maxlength="100" placeholder="请输入奖品名称" />
          </label>
          <label>
            <span>描述</span>
            <textarea v-model="editForm.description" maxlength="500" rows="2" placeholder="奖品说明（可选）" />
          </label>
          <label>
            <span>图片 URL</span>
            <div class="prize-image-editor">
              <img :src="prizeImageUrl(editForm.imageUrl)" alt="奖品图片预览" class="prize-preview" />
              <div class="prize-image-fields">
                <div class="image-upload-row">
                  <label class="btn btn-ghost btn-sm image-upload-button" :class="{ 'is-disabled': uploadingImage }">
                    {{ uploadingImage ? '上传中...' : '上传图片' }}
                    <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" :disabled="uploadingImage" @change="uploadEditImage" />
                  </label>
                </div>
                <input v-model="editForm.imageUrl" maxlength="500" placeholder="不上传则使用默认图" />
              </div>
            </div>
          </label>
          <label>
            <span>价值</span>
            <input v-model="editForm.valueText" maxlength="50" placeholder="展示文案，如 50 USDT（可选）" />
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="showEditModal = false">取消</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="submitting">
            {{ submitting ? '保存中…' : '保存' }}
          </button>
        </div>
      </form>
    </AdminModal>

    <!-- 导入码弹窗 -->
    <AdminModal v-model="showImportModal" :title="'导入码 - ' + (importPrize?.name || '')" max-width="600px">
      <div class="tabs" style="margin-bottom:12px">
        <button type="button" class="tab" :class="{ active: importTab === 'paste' }" @click="importTab = 'paste'">粘贴导入</button>
        <button type="button" class="tab" :class="{ active: importTab === 'generate' }" @click="importTab = 'generate'">自动生成</button>
      </div>

      <div v-if="importTab === 'paste'" class="modal-form">
        <label>
          <span>卡密列表（每行一个）</span>
          <textarea v-model="codesText" rows="8" placeholder="code1&#10;code2&#10;code3" />
        </label>
        <p class="field-hint">每行一个码，支持格式：code 或 code:secret</p>
      </div>

      <div v-if="importTab === 'generate'" class="modal-form">
        <label>
          <span>生成数量</span>
          <input v-model.number="genCount" type="number" min="1" max="1000" placeholder="100" />
        </label>
        <label>
          <span>码前缀（可选）</span>
          <input v-model="genPrefix" maxlength="20" placeholder="如 LUCKY-" />
          <small class="field-hint">便于区分不同活动和奖品</small>
        </label>
        <label>
          <span>码长度</span>
          <input v-model.number="genCodeLen" type="number" min="4" max="32" placeholder="8" />
          <small class="field-hint">默认 8 位，自动排除易混淆字符（0/O/1/I/l）</small>
        </label>
      </div>

      <div class="modal-actions">
        <button type="button" class="btn btn-ghost btn-sm" @click="showImportModal = false">取消</button>
        <button v-if="importTab === 'paste'" type="button" class="btn btn-primary btn-sm" :disabled="importing" @click="handleImport">
          {{ importing ? '导入中…' : '导入' }}
        </button>
        <button v-if="importTab === 'generate'" type="button" class="btn btn-primary btn-sm" :disabled="importing" @click="handleGenerate">
          {{ importing ? '生成中…' : '生成' }}
        </button>
      </div>
    </AdminModal>

    <!-- 查看码弹窗 -->
    <AdminModal v-model="showCodesModal" :title="'码池 - ' + (codesPrize?.name || '')" max-width="800px">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <select v-model="codesFilter" @change="loadCodes(true)">
          <option value="">全部状态</option>
          <option value="available">可用</option>
          <option value="issued">已发放</option>
        </select>
        <span class="field-hint">共 {{ codesTotal }} 条（可用 {{ totalAvailable }} / 已发放 {{ totalIssued }}）</span>
        <button class="btn btn-ghost btn-xs" :disabled="codesLoading" @click="loadCodes(true)">刷新</button>
        <button class="btn btn-primary btn-xs" @click="exportCodes">📥 导出 CSV</button>
        <button v-if="codesFilter === 'available' && codesList.length > 0" class="btn btn-ghost btn-xs" style="color:var(--tg-danger)" @click="batchDeleteCodes">批量删除本页</button>
      </div>
      <div v-if="codesLoading" class="skeleton-list">
        <div v-for="i in 5" :key="'sk' + i" class="skeleton-line" />
      </div>
      <div v-else-if="codesList.length === 0" class="empty-text">暂无码</div>
      <div v-else class="table-wrap" style="max-height:400px;overflow-y:auto">
        <table class="admin-table">
          <thead>
            <tr>
              <th>卡密</th>
              <th>密钥</th>
              <th>状态</th>
              <th>领取人</th>
              <th>发放时间</th>
              <th class="col-actions">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in codesList" :key="c.id">
              <td>
                <code class="code-cell">{{ c.code }}</code>
              </td>
              <td>
                <code v-if="c.secret" class="code-cell" style="font-size:11px">{{ c.secret }}</code>
                <span v-else class="field-hint">—</span>
              </td>
              <td>
                <span :class="c.status === 'available' ? 'tag-success' : 'tag-muted'">
                  {{ c.status === 'available' ? '可用' : '已发放' }}
                </span>
              </td>
              <td>{{ c.winnerId || '—' }}</td>
              <td>{{ c.issuedAt || '—' }}</td>
              <td class="col-actions">
                <button class="btn btn-ghost btn-xs" @click="copyCode(c.code, c.secret)">复制</button>
                <button v-if="c.status === 'available'" class="btn btn-ghost btn-xs" style="color:var(--tg-danger)" @click="deleteCode(c)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="codesTotal > 50" style="margin-top:8px;display:flex;gap:8px;align-items:center;justify-content:center">
        <button class="btn btn-ghost btn-xs" :disabled="codesPage <= 0" @click="codesPage--; loadCodes()">上一页</button>
        <span class="field-hint">{{ codesPage * 50 + 1 }}-{{ Math.min((codesPage + 1) * 50, codesTotal) }} / {{ codesTotal }}</span>
        <button class="btn btn-ghost btn-xs" :disabled="(codesPage + 1) * 50 >= codesTotal" @click="codesPage++; loadCodes()">下一页</button>
      </div>
    </AdminModal>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useToast } from '@/composables/useToast'
import { adminRequest } from '@/composables/useAdminRequest'
import AdminModal from '@/components/AdminModal.vue'

const { showToast } = useToast()

const loading = ref(false)
const loadError = ref('')
const submitting = ref(false)
const importing = ref(false)
const uploadingImage = ref(false)
const showCreate = ref(false)
const showEditModal = ref(false)
const editingPrize = ref<any>(null)
const editForm = ref({ name: '', description: '', imageUrl: '', valueText: '' })
const showCodesModal = ref(false)
const codesPrize = ref<any>(null)
const codesList = ref<any[]>([])
const codesLoading = ref(false)
const codesFilter = ref('')
const codesPage = ref(0)
const codesTotal = ref(0)
const totalAvailable = ref(0)
const totalIssued = ref(0)
const importPrize = ref<any>(null)
const codesText = ref('')
const importTab = ref<'paste' | 'generate'>('paste')
const genCount = ref(100)
const genPrefix = ref('')
const genCodeLen = ref(8)
const prizes = ref<any[]>([])

const form = ref({
  name: '',
  description: '',
  prizeType: 'code',
  imageUrl: '',
  valueText: '',
})

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

async function uploadPrizeImage(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || uploadingImage.value) return
  if (file.size <= 0) {
    showToast('请选择非空图片文件', 'error')
    return
  }
  if (file.size > 2 * 1024 * 1024) {
    showToast('图片不能超过 2MiB', 'error')
    return
  }

  uploadingImage.value = true
  try {
    const body = new FormData()
    body.append('file', file)
    const data = await adminRequest<{ url: string }>('/api/admin/media/images', {
      method: 'POST',
      body,
    })
    form.value.imageUrl = data.url || ''
    showToast('奖品图片已上传', 'success')
  } catch (err: any) {
    showToast(err?.message || '图片上传失败', 'error')
  } finally {
    uploadingImage.value = false
  }
}

async function loadData() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await adminRequest<{ prizes: any[] }>('/api/admin/prizes')
    prizes.value = data.prizes || []
  } catch (err: any) {
    loadError.value = err.message || '加载失败'
  } finally {
    loading.value = false
  }
}

async function handleCreate() {
  submitting.value = true
  try {
    await adminRequest('/api/admin/prizes', {
      method: 'POST',
      body: JSON.stringify(form.value),
    })
    showToast('创建成功', 'success')
    showCreate.value = false
    form.value = { name: '', description: '', prizeType: 'code', imageUrl: '', valueText: '' }
    await loadData()
  } catch (err: any) {
    showToast(err?.message || '创建失败', 'error')
  } finally {
    submitting.value = false
  }
}

function showImport(prize: any) {
  importPrize.value = prize
  codesText.value = ''
  showImportModal.value = true
}

async function showCodes(prize: any) {
  codesPrize.value = prize
  codesFilter.value = ''
  codesPage.value = 0
  totalAvailable.value = 0
  totalIssued.value = 0
  showCodesModal.value = true
  await loadCodes()
}

async function loadCodes(resetPage = false) {
  if (!codesPrize.value) return
  if (resetPage) codesPage.value = 0
  codesLoading.value = true
  try {
    const params = new URLSearchParams()
    if (codesFilter.value) params.set('status', codesFilter.value)
    params.set('limit', '50')
    params.set('offset', String(codesPage.value * 50))
    const data = await adminRequest<any>(`/api/admin/prizes/${codesPrize.value.id}/codes?${params}`)
    codesList.value = data.codes || []
    codesTotal.value = data.total ?? 0
    totalAvailable.value = data.totalAvailable ?? 0
    totalIssued.value = data.totalIssued ?? 0
  } catch (err: any) {
    showToast(err?.message || '加载失败', 'error')
  } finally {
    codesLoading.value = false
  }
}

async function copyCode(code: string, secret?: string) {
  const text = secret ? `${code}:${secret}` : code
  try {
    await navigator.clipboard.writeText(text)
    showToast('已复制', 'success')
  } catch {
    showToast('复制失败，请手动选择复制', 'error')
  }
}

async function deleteCode(code: any) {
  if (!confirm(`确认删除卡密 ${code.code}？此操作不可恢复。`)) return
  try {
    await adminRequest(`/api/admin/prizes/codes/${code.id}`, { method: 'DELETE' })
    showToast('已删除', 'success')
    await loadCodes()
    // 刷新奖品列表（更新码池余量）
    await loadData()
  } catch (err: any) {
    showToast(err?.message || '删除失败', 'error')
  }
}

async function exportCodes() {
  if (!codesPrize.value) return
  const params = new URLSearchParams()
  if (codesFilter.value) params.set('status', codesFilter.value)
  const token = localStorage.getItem('admin_token') || ''
  const url = `/api/admin/prizes/${codesPrize.value.id}/codes/export?${params}`
  // 直接用 fetch 下载文件，绕过 adminRequest 的 JSON 解析
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) { showToast('导出失败', 'error'); return }
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${codesPrize.value.name}-码池.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

async function batchDeleteCodes() {
  if (!codesPrize.value) return
  if (!confirm(`确认删除本页 ${codesList.value.length} 个可用码？此操作不可恢复。`)) return
  codesLoading.value = true
  let deleted = 0
  let failed = 0
  for (const c of codesList.value) {
    try {
      await adminRequest(`/api/admin/prizes/codes/${c.id}`, { method: 'DELETE' })
      deleted++
    } catch { failed++ }
  }
  showToast(`删除完成：${deleted} 成功${failed > 0 ? `，${failed} 失败` : ''}`, failed > 0 ? 'error' : 'success')
  codesLoading.value = false
  await loadCodes(true)
  await loadData()
}

function showEdit(prize: any) {
  editingPrize.value = prize
  editForm.value = {
    name: prize.name || '',
    description: prize.description || '',
    imageUrl: prize.imageUrl || '',
    valueText: prize.valueText || '',
  }
  showEditModal.value = true
}

async function handleEdit() {
  submitting.value = true
  try {
    await adminRequest(`/api/admin/prizes/${editingPrize.value.id}`, {
      method: 'PATCH',
      body: JSON.stringify(editForm.value),
    })
    showToast('保存成功', 'success')
    showEditModal.value = false
    await loadData()
  } catch (err: any) {
    showToast(err?.message || '保存失败', 'error')
  } finally {
    submitting.value = false
  }
}

async function uploadEditImage(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || uploadingImage.value) return
  if (file.size > 2 * 1024 * 1024) { showToast('图片不能超过 2MiB', 'error'); return }
  uploadingImage.value = true
  try {
    const body = new FormData(); body.append('file', file)
    const data = await adminRequest<{ url: string }>('/api/admin/media/images', { method: 'POST', body })
    editForm.value.imageUrl = data.url || ''
    showToast('图片已上传', 'success')
  } catch (err: any) {
    showToast(err?.message || '上传失败', 'error')
  } finally { uploadingImage.value = false }
}

async function handleImport() {
  importing.value = true
  try {
    const codes = codesText.value
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const [code, secret] = l.split(':')
        return { code: code.trim(), secret: (secret || '').trim() }
      })

    if (codes.length === 0) {
      showToast('请至少输入一个码', 'error')
      return
    }

    const data = await adminRequest<{ imported?: number; skipped?: number }>(`/api/admin/prizes/${importPrize.value.id}/codes/import`, {
      method: 'POST',
      body: JSON.stringify({ codes }),
    })
    showToast(`成功导入 ${data.imported ?? codes.length} 个码${data.skipped ? `，跳过 ${data.skipped} 个重复码` : ''}`, 'success')
    showImportModal.value = false
    await loadData()
    // 自动打开码池查看
    showCodes(importPrize.value)
  } catch (err: any) {
    showToast(err?.message || '导入失败', 'error')
  } finally {
    importing.value = false
  }
}

async function toggleActive(prize: any) {
  try {
    const newActive = prize.active !== 0 ? 0 : 1;
    await adminRequest(`/api/admin/prizes/${prize.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: newActive }),
    });
    prize.active = newActive;
    showToast(newActive ? '奖品已启用' : '奖品已停用', 'success');
  } catch (err: any) {
    showToast(err?.message || '操作失败', 'error');
  }
}

async function handleGenerate() {
  if (!importPrize.value) return
  importing.value = true
  try {
    const data = await adminRequest<{ generated: number }>(`/api/admin/prizes/${importPrize.value.id}/codes/generate`, {
      method: 'POST',
      body: JSON.stringify({
        count: genCount.value || 100,
        prefix: genPrefix.value.trim(),
        codeLength: genCodeLen.value || 8,
      }),
    })
    showToast(`成功生成 ${data.generated} 个码`, 'success')
    showImportModal.value = false
    await loadData()
    showCodes(importPrize.value)
  } catch (err: any) {
    showToast(err?.message || '生成失败', 'error')
  } finally {
    importing.value = false
  }
}

onMounted(loadData)
</script>

<style scoped>
.prize-thumb,
.prize-preview {
  display: block;
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 8px;
  background: var(--tg-secondary-bg, #151b28);
}

.prize-preview {
  width: 72px;
  height: 72px;
  flex: 0 0 auto;
}

.prize-image-editor {
  display: flex;
  gap: 12px;
  align-items: center;
}

.prize-image-fields {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.image-upload-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.image-upload-button {
  position: relative;
  overflow: hidden;
  cursor: pointer;
}

.image-upload-button.is-disabled {
  cursor: wait;
  opacity: 0.65;
}

.image-upload-button input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.code-cell { font-size: 13px; font-family: monospace; word-break: break-all; }
</style>
