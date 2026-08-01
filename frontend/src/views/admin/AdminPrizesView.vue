<template>
  <div class="admin-page">
    <div class="toolbar">
      <div class="filters">
        <button class="btn btn-ghost btn-sm" type="button" :disabled="loading" @click="loadData">
          刷新
        </button>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary btn-sm" type="button" :disabled="loading" @click="showCreate = true">
          创建奖品
        </button>
      </div>
    </div>

    <div class="table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>图片</th>
            <th>名称</th>
            <th>类型</th>
            <th>描述</th>
            <th>创建时间</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="prize in prizes" :key="prize.id">
            <td>
              <img v-if="prize.imageUrl" :src="prize.imageUrl" :alt="prize.name" class="prize-thumb" />
              <span v-else class="prize-thumb-placeholder">🎁</span>
            </td>
            <td>{{ prize.name }}</td>
            <td>{{ prize.prizeType === 'code' ? '卡密' : '手动发放' }}</td>
            <td>{{ prize.description || '-' }}</td>
            <td>{{ prize.createdAt }}</td>
            <td class="col-actions">
              <button class="btn btn-ghost btn-xs" @click="showImport(prize)">导入码</button>
            </td>
          </tr>
          <tr v-if="prizes.length === 0">
            <td colspan="5" class="empty-text">暂无奖品</td>
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
            <input v-model="form.imageUrl" maxlength="500" placeholder="奖品图片链接（可选）" />
            <small class="field-hint">建议使用正方形图片，将在活动页面展示</small>
          </label>
          <label>
            <span>价值</span>
            <input v-model="form.value" maxlength="50" placeholder="奖品价值，如 50 USDT（可选）" />
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

    <!-- 导入码弹窗 -->
    <AdminModal v-model="showImportModal" :title="'导入码 - ' + (importPrize?.name || '')" max-width="600px">
      <div class="modal-form">
        <label>
          <span>卡密列表（每行一个）</span>
          <textarea v-model="codesText" rows="8" placeholder="code1&#10;code2&#10;code3" />
        </label>
        <p class="field-hint">每行一个码，支持格式：code 或 code:secret</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost btn-sm" @click="showImportModal = false">取消</button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="importing" @click="handleImport">
          {{ importing ? '导入中…' : '导入' }}
        </button>
      </div>
    </AdminModal>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useToast } from '@/composables/useToast'
import AdminModal from '@/components/AdminModal.vue'

const { showToast } = useToast()

const loading = ref(false)
const submitting = ref(false)
const importing = ref(false)
const showCreate = ref(false)
const showImportModal = ref(false)
const importPrize = ref<any>(null)
const codesText = ref('')
const prizes = ref<any[]>([])

const form = ref({
  name: '',
  description: '',
  prizeType: 'code',
  imageUrl: '',
  value: '',
})

async function loadData() {
  loading.value = true
  try {
    const res = await fetch('/api/admin/prizes', {
      headers: { Authorization: `Bearer ${localStorage.getItem('admin_token') || ''}` },
    })
    const data = await res.json()
    if (data.ok) {
      prizes.value = data.prizes || []
    }
  } catch {
    showToast('加载失败', 'error')
  } finally {
    loading.value = false
  }
}

async function handleCreate() {
  submitting.value = true
  try {
    const res = await fetch('/api/admin/prizes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('admin_token') || ''}`,
      },
      body: JSON.stringify(form.value),
    })
    const data = await res.json()
    if (data.ok) {
      showToast('创建成功', 'success')
      showCreate.value = false
      form.value = { name: '', description: '', prizeType: 'code' }
      await loadData()
    } else {
      showToast(data.message || '创建失败', 'error')
    }
  } catch {
    showToast('创建失败', 'error')
  } finally {
    submitting.value = false
  }
}

function showImport(prize: any) {
  importPrize.value = prize
  codesText.value = ''
  showImportModal.value = true
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

    const res = await fetch(`/api/admin/prizes/${importPrize.value.id}/codes/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('admin_token') || ''}`,
      },
      body: JSON.stringify({ codes }),
    })
    const data = await res.json()
    if (data.ok) {
      showToast(`成功导入 ${codes.length} 个码`, 'success')
      showImportModal.value = false
    } else {
      showToast(data.message || '导入失败', 'error')
    }
  } catch {
    showToast('导入失败', 'error')
  } finally {
    importing.value = false
  }
}

onMounted(loadData)
</script>