<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  ALLOWED_NEXT_ACTIONS,
  CONSECUTIVE_FAILED_LIMIT,
  NEXT_ACTION_LABEL,
  REVIEW_GRADE_LABEL,
  VERDICT_GRADE,
  VERDICT_LABEL,
  VERDICTS,
  type NextAction,
  type Verdict,
} from '@gml/shared';
import { repairApi } from '../api';
import { ApiError, messageOf } from '../api/client';
import type { RepairDetail, RepairListItem } from '../types';

const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();
const repairId = String(route.params.id);
const data = ref<RepairDetail | null>(null);
const allRounds = ref<RepairListItem[]>([]);
const busy = ref(false);

const form = ref({
  reviewedAt: new Date().toISOString().slice(0, 10),
  verdict: 'good' as Verdict,
  wornSince: undefined as number | undefined,
  reoccurred: false,
  verdictNote: '',
  nextAction: 'close' as NextAction,
});

const repair = computed(() => data.value?.repair);
const grade = computed(() => VERDICT_GRADE[form.value.verdict]);

/** 观察期是否未满（未满提交会触发二次确认） */
const observationOpen = computed(() => {
  if (!repair.value) return false;
  return new Date(form.value.reviewedAt).getTime() < new Date(repair.value.observationUntil).getTime();
});

/** 之前各轮（不含本轮）最后一次复检结论，按轮次倒序 */
const priorVerdicts = computed<Verdict[]>(() =>
  allRounds.value
    .filter(
      (item) =>
        item.id !== repairId &&
        item.garment.id === repair.value?.damageEvent.garmentId &&
        item.damageCode === repair.value?.damageEvent.code &&
        item.round < (repair.value?.round ?? 1),
    )
    .sort((a, b) => b.round - a.round)
    .map((item) => item.latestVerdict)
    .filter((verdict): verdict is Verdict => verdict === 'good' || verdict === 'fair' || verdict === 'failed'),
);

const priorConsecutiveFailed = computed(() => {
  let count = 0;
  for (const verdict of priorVerdicts.value) {
    if (verdict === 'failed') count += 1;
    else break;
  }
  return count;
});

/** 当前选 C 级，且上一轮也是 C 级：本轮将被系统强制升级退役评估 */
const willEscalate = computed(
  () => form.value.verdict === 'failed' && priorConsecutiveFailed.value + 1 >= CONSECUTIVE_FAILED_LIMIT,
);

const availableActions = computed<NextAction[]>(() =>
  willEscalate.value ? ['retire'] : [...ALLOWED_NEXT_ACTIONS[form.value.verdict]],
);

const daysSinceRepair = computed(() => {
  if (!repair.value) return 0;
  return Math.max(
    0,
    Math.round((Date.now() - new Date(repair.value.finishedAt).getTime()) / 86_400_000),
  );
});

onMounted(async () => {
  try {
    const detail = await repairApi.detail(repairId);
    data.value = detail;
    if (detail.repair.change?.visibleFromOutside) {
      form.value.verdict = 'fair';
      form.value.nextAction = 'close';
    }
    const garmentId = detail.repair.damageEvent.garmentId;
    const damageCode = detail.repair.damageEvent.code;
    const roundList = await repairApi
      .list({ garmentId, limit: 200 })
      .catch(() => ({ items: [] as RepairListItem[] }));
    allRounds.value = roundList.items.filter((item) => item.damageCode === damageCode);
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
});

function onVerdictChange(value: Verdict): void {
  form.value.verdict = value;
  // 分级动作矩阵：切换结论后，下一步若不在允许集合里，自动落到该分级的第一个动作
  if (!availableActions.value.includes(form.value.nextAction)) {
    form.value.nextAction = availableActions.value[0];
  }
}

async function submit(): Promise<void> {
  if (!availableActions.value.includes(form.value.nextAction)) {
    form.value.nextAction = availableActions.value[0];
  }
  busy.value = true;
  try {
    const payload = {
      reviewedAt: form.value.reviewedAt,
      verdict: form.value.verdict,
      wornSince: form.value.wornSince ?? null,
      reoccurred: form.value.reoccurred,
      verdictNote: form.value.verdictNote || null,
      nextAction: form.value.nextAction,
    };
    let result: {
      repairStatus: string;
      damageStatus: string;
      reminderCreated?: { kind: string } | null;
      autoEscalated?: boolean;
      familyNotified?: Array<{ userId: string }>;
    };
    try {
      // 观察期未满时第一次提交会被服务端 409 拦下 —— 这是分级流程里的"二次确认"
      result = (await repairApi.review(repairId, { ...payload, confirmEarly: false })) as typeof result;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'OBSERVATION_NOT_FINISHED') {
        try {
          await ElMessageBox.confirm(
            `${error.message}。提前复检的结论同样会计入分级与连续不合格轮次，确定现在就要复检吗？`,
            '观察期未满 · 二次确认',
            {
              type: 'warning',
              confirmButtonText: '我确认，提前复检',
              cancelButtonText: '等到观察期结束',
            },
          );
        } catch {
          // 用户在确认框里点了取消：不算错误，直接回到表单
          return;
        }
        result = (await repairApi.review(repairId, { ...payload, confirmEarly: true })) as typeof result;
      } else {
        throw error;
      }
    }

    if (result.autoEscalated) {
      await ElMessageBox.alert(
        `这是连续第 ${CONSECUTIVE_FAILED_LIMIT} 轮 C 级（不合格），系统已自动升级为退役评估，并通知了 ${
          result.familyNotified?.length ?? 0
        } 位家人，请和家人一起确认处置方式。`,
        '已自动升级退役评估',
        { type: 'warning', confirmButtonText: '我知道了' },
      ).catch(() => undefined);
    } else {
      ElMessage.success(
        `${REVIEW_GRADE_LABEL[grade.value]}：修补 ${result.repairStatus} / 破损 ${result.damageStatus}` +
          (result.reminderCreated ? '，已生成后续提醒' : ''),
      );
    }
    // 复检会同时改修补、破损、衣物与提醒的状态，缓存必须一起失效，
    // 否则跳回档案页看到的还是 15 秒前的旧数据。
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['garment'] }),
      queryClient.invalidateQueries({ queryKey: ['garments'] }),
      queryClient.invalidateQueries({ queryKey: ['reminders'] }),
      queryClient.invalidateQueries({ queryKey: ['wardrobe'] }),
    ]);
    await router.push({ name: 'garment-detail', params: { id: repair.value!.damageEvent.garmentId } });
  } catch (error) {
    ElMessage.error(messageOf(error));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <el-skeleton v-if="!repair" :rows="4" animated />
    <template v-else>
      <div class="page-header">
        <div>
          <h1 class="page-title">修补复检（分级）</h1>
          <div class="page-subtitle">
            {{ repair.damageEvent.garment.name }} · 第 {{ repair.round }} 轮 · {{ repair.stitch.name }} ·
            完成于 {{ repair.finishedAt.slice(0, 10) }}（已 {{ daysSinceRepair }} 天，观察期至 {{ repair.observationUntil.slice(0, 10) }}）
          </div>
        </div>
        <el-button link @click="router.back()">返回</el-button>
      </div>

      <el-card shadow="never">
        <el-alert
          type="info"
          :closable="false"
          style="margin-bottom: 12px"
          title="分级复检流程"
          description="A 级 良好：直接闭环；B 级 尚可：闭环或 30 天后再观察一次；C 级 不合格：首轮返工重修，连续两轮 C 级则自动升级退役评估并通知家人。观察期未满提交时需要二次确认。"
        />
        <el-alert
          v-if="observationOpen"
          type="warning"
          :closable="false"
          style="margin-bottom: 12px"
          title="观察期尚未结束"
          description="现在提交属于提前复检，提交时会再弹出一次确认。"
        />
        <el-alert
          v-if="willEscalate"
          type="error"
          :closable="false"
          style="margin-bottom: 12px"
          title="连续两轮 C 级：提交后将自动升级退役评估"
          :description="`上一轮（第 ${repair.round - 1} 轮）复检已判定不合格，本次若再判 C 级，系统将不再安排返工，直接转入退役评估，并通知衣橱里的家人。`"
        />
        <el-form label-width="130px">
          <el-form-item label="复检日期" required>
            <el-date-picker v-model="form.reviewedAt" type="date" value-format="YYYY-MM-DD" style="width: 200px" />
          </el-form-item>
          <el-form-item label="结论分级" required>
            <el-radio-group :model-value="form.verdict" @change="onVerdictChange">
              <el-radio-button v-for="item in VERDICTS" :key="item" :label="item">
                {{ VERDICT_GRADE[item] }} 级 · {{ VERDICT_LABEL[item] }}
              </el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="复检时穿着次数">
            <el-input-number v-model="form.wornSince" :min="0" style="width: 160px" />
            <span class="muted" style="margin-left: 8px">不填则按档案里的穿着记录自动统计</span>
          </el-form-item>
          <el-form-item label="同一位置又坏了">
            <el-switch v-model="form.reoccurred" />
            <span class="muted" style="margin-left: 8px">如果又破了，建议先去档案页登记一条新破损并关联复发</span>
          </el-form-item>
          <el-form-item label="复检说明">
            <el-input v-model="form.verdictNote" type="textarea" :rows="3" maxlength="1000" placeholder="例：织补处平整，拉扯也没有松动；边缘略紧" />
          </el-form-item>
          <el-form-item label="下一步" required>
            <el-radio-group v-model="form.nextAction">
              <el-radio-button
                v-for="item in availableActions"
                :key="item"
                :label="item"
                :disabled="willEscalate && item !== 'retire'"
              >
                {{ NEXT_ACTION_LABEL[item] }}
              </el-radio-button>
            </el-radio-group>
            <div class="field-hint">
              <template v-if="grade === 'A'">A 级：本次破损收口，进入长期统计。</template>
              <template v-else-if="grade === 'B'">B 级：可直接收口，或继续观察 30 天后再提醒一次。</template>
              <template v-else-if="willEscalate">
                C 级且连续两轮不合格：只能评估退役，提交后自动升级并通知家人。
              </template>
              <template v-else>C 级：生成返工任务，保留这一轮的记录；也可以直接评估退役。</template>
            </div>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="busy" @click="submit">提交复检</el-button>
            <el-button @click="router.push({ name: 'repair-detail', params: { id: repairId } })">看看修补详情</el-button>
          </el-form-item>
        </el-form>
      </el-card>
    </template>
  </div>
</template>
