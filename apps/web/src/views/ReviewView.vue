<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  NEXT_ACTION_LABEL,
  NEXT_ACTIONS,
  REVIEW_GRADE_DESC,
  REVIEW_GRADE_LABEL,
  VERDICT_LABEL,
  VERDICTS,
  type NextAction,
  type ReviewGrade,
  type Verdict,
} from '@gml/shared';
import { repairApi } from '../api';
import { ApiError, messageOf } from '../api/client';
import type { RepairDetail } from '../types';

const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();
const repairId = String(route.params.id);
const data = ref<RepairDetail | null>(null);
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
const isFailed = computed(() => form.value.verdict === 'failed');
const isPassing = computed(() => form.value.verdict === 'good' || form.value.verdict === 'fair');
const damage = computed(() => repair.value?.damageEvent);
/** 这个破损事件此前已经连续不合格的轮次数（1 = 本次再不合格就会升级 L3） */
const priorFailures = computed(() => damage.value?.consecutiveFailures ?? 0);
const willEscalate = computed(() => isFailed.value && priorFailures.value >= 1);

/** 提交后预判的分级（仅用于界面提示，真正分级以服务端返回为准） */
const previewGrade = computed<ReviewGrade>(() => {
  if (!isFailed.value) return 'L1';
  return willEscalate.value ? 'L3' : 'L2';
});

const daysSinceRepair = computed(() => {
  if (!repair.value) return 0;
  return Math.max(
    0,
    Math.round((Date.now() - new Date(repair.value.finishedAt).getTime()) / 86_400_000),
  );
});

const availableActions = computed<readonly NextAction[]>(() =>
  isFailed.value ? NEXT_ACTIONS.filter((a) => a !== 'close' && a !== 'monitor') : NEXT_ACTIONS,
);

onMounted(async () => {
  try {
    data.value = await repairApi.detail(repairId);
    if (data.value.repair.change?.visibleFromOutside) form.value.verdict = 'fair';
  } catch (error) {
    ElMessage.error(messageOf(error));
  }
});

async function submit(): Promise<void> {
  // 分级流程：L2/L3 都不能闭环；L3 由服务端自动升级，这里只需提示后果
  if (isFailed.value && (form.value.nextAction === 'close' || form.value.nextAction === 'monitor')) {
    ElMessage.warning('复检不合格时不能闭环或仅观察，请选择返工重修或评估退役');
    return;
  }
  if (willEscalate.value) {
    try {
      await ElMessageBox.confirm(
        `这个破损已经连续 ${priorFailures.value} 轮判定不合格。本次再判「不合格」将自动升级为「退役评估」，` +
          '破损会标记为不可修，并立即通知衣橱里的家人，且无法撤销。确认继续？',
        '即将升级为 L3 退役评估',
        {
          type: 'error',
          confirmButtonText: '确认不合格并升级',
          cancelButtonText: '再检查一下',
        },
      );
    } catch {
      return; // 用户取消
    }
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
      grade?: ReviewGrade;
      autoEscalated?: boolean;
      familyNotified?: number;
      reminderCreated?: { kind: string } | null;
    };
    try {
      result = (await repairApi.review(repairId, { ...payload, confirmEarly: false })) as typeof result;
    } catch (error) {
      // 观察期还没到：服务端要求显式确认，确认后带 confirmEarly 再提交一次（二次确认）
      if (error instanceof ApiError && error.code === 'OBSERVATION_NOT_FINISHED') {
        await ElMessageBox.confirm(
          `${error.message}。分级提示：${REVIEW_GRADE_DESC[previewGrade.value]}确定现在就要复检吗？`,
          '提前复检（观察期未满）',
          {
            type: 'warning',
            confirmButtonText: '仍然提交',
            cancelButtonText: '再等等',
          },
        );
        result = (await repairApi.review(repairId, { ...payload, confirmEarly: true })) as typeof result;
      } else {
        throw error;
      }
    }

    if (result.autoEscalated) {
      await ElMessageBox.alert(
        `已连续两轮复检不合格，系统自动升级为「L3 退役评估」：破损已标记为不可修，退役评估待办已生成，` +
          `并已通知 ${result.familyNotified ?? 0} 位家人。请与家人商量后在档案里登记最终处置方式。`,
        '已自动升级为退役评估',
        { type: 'error', confirmButtonText: '我知道了' },
      ).catch(() => undefined);
    } else {
      ElMessage.success(
        `复检已提交（${result.grade ? REVIEW_GRADE_LABEL[result.grade] : ''}）：修补 ${result.repairStatus} / 破损 ${result.damageStatus}` +
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
    // 用户在确认框里点了取消：ElMessageBox 以 'cancel'/'close' 拒绝，不算错误
    const cancelled = error === 'cancel' || error === 'close';
    if (!cancelled) ElMessage.error(messageOf(error));
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
          <h1 class="page-title">修补复检 · 分级流程</h1>
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
          title="复检分级"
          description="L1 初检通过（良好/尚可）：收口或继续观察；L2 加严复检（第 1 次不合格）：返工重修或评估退役；L3 退役评估（同一破损连续两轮不合格）：系统自动升级，转退役处置并通知家人。"
        />

        <!-- 已有 1 次不合格：本次再不合格就要升级 L3 -->
        <el-alert
          v-if="priorFailures >= 1"
          :type="willEscalate ? 'error' : 'warning'"
          :closable="false"
          show-icon
          style="margin-bottom: 12px"
          :title="`这个破损此前已连续 ${priorFailures} 轮复检不合格（L2）`"
          :description="
            willEscalate
              ? '本次若提交「不合格」，将立即自动升级为 L3 退役评估并通知家人，且无法撤销。'
              : '保持良好/尚可结论即可解除加严状态；再次不合格则自动升级退役评估。'
          "
        />

        <el-form label-width="130px">
          <el-form-item label="复检日期" required>
            <el-date-picker v-model="form.reviewedAt" type="date" value-format="YYYY-MM-DD" style="width: 200px" />
          </el-form-item>
          <el-form-item label="结论" required>
            <el-radio-group v-model="form.verdict">
              <el-radio-button v-for="item in VERDICTS" :key="item" :label="item">{{ VERDICT_LABEL[item] }}</el-radio-button>
            </el-radio-group>
            <el-tag
              :type="previewGrade === 'L3' ? 'danger' : previewGrade === 'L2' ? 'warning' : 'success'"
              effect="plain"
              style="margin-left: 12px"
            >
              本次将判定为 {{ REVIEW_GRADE_LABEL[previewGrade] }}
            </el-tag>
          </el-form-item>
          <el-form-item label="分级含义">
            <span class="muted">{{ REVIEW_GRADE_DESC[previewGrade] }}</span>
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
              <el-radio-button v-for="item in availableActions" :key="item" :label="item">
                {{ NEXT_ACTION_LABEL[item] }}
              </el-radio-button>
            </el-radio-group>
            <div class="field-hint">
              <template v-if="isPassing">
                闭环结束：本次破损收口，进入长期统计；继续观察：30 天后再提醒一次。
              </template>
              <template v-else-if="!willEscalate">
                L2 加严复检：返工重修生成返工任务、保留本轮记录；评估退役：转入处置流程。下一轮仍不合格将自动升级 L3 并通知家人。
              </template>
              <template v-else>
                已到连续第 2 轮不合格：无论选哪项，提交后都会自动升级为 L3 退役评估并通知家人；此处选择仅记录你的倾向。
              </template>
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
