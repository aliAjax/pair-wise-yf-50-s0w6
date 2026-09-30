<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NSelect, NStatistic, NSwitch, NTag } from "naive-ui";
import { useOnline } from "@vueuse/core";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useAssessmentStore, type FieldTask, type NeedLevel, type TaskStatus } from "~/stores/assessment";
import { probeCache } from "~/utils/api";

const statusRank: Record<TaskStatus, number> = { "待接收": 0, "进行中": 1, "已完成": 2 };
const store = useAssessmentStore();
const browserOnline = useOnline();
const panel = ref("需求记录");
const selectedId = ref(store.households[0]?.id ?? "");
const cacheProbe = ref<{ cachedAt: string; source: string } | null>(null);
const syncMessage = ref("");
const syncResult = ref<Awaited<ReturnType<typeof store.flushBatch>> | null>(null);
const schema = toTypedSchema(z.object({ head: z.string().min(2, "请输入户主姓名"), community: z.string().min(2), address: z.string().min(4), members: z.coerce.number().min(1).max(30), needLevel: z.enum(["紧急", "高", "一般"]), needs: z.string().min(2), note: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema, initialValues: { head: "", community: "河湾社区", address: "", members: 1, needLevel: "一般" as NeedLevel, needs: "", note: "" } });
const [head] = defineField("head");
const [community] = defineField("community");
const [address] = defineField("address");
const [members] = defineField("members");
const [needLevel] = defineField("needLevel");
const [needs] = defineField("needs");
const [note] = defineField("note");
const selected = computed(() => store.households.find((item) => item.id === selectedId.value) ?? store.households[0]);
const taskAssignee = ref("救援一组");
const taskTitle = ref("现场复核");
const openConflicts = computed(() => store.conflicts.filter((item) => item.status === "待处理"));

function taskHousehold(householdId: string) {
  return store.households.find((item) => item.id === store.canonicalHouseholdId(householdId));
}

onMounted(async () => {
  cacheProbe.value = await probeCache();
  store.online = browserOnline.value;
});
const submit = handleSubmit((values) => {
  store.addHousehold({ head: values.head, community: values.community, address: values.address, members: Number(values.members), vulnerable: [], needLevel: values.needLevel as NeedLevel, needs: values.needs.split(/[，,]/).map((item) => item.trim()).filter(Boolean), note: values.note });
  resetForm();
});
function assignTask() {
  if (!selected.value) return;
  store.addTask({ householdId: selected.value.id, title: taskTitle.value, assignee: taskAssignee.value, priority: selected.value.needLevel, due: "2026-09-30 18:00" });
}
function advanceTask(id: string) {
  store.advanceTask(id);
}
async function sync() {
  if (!store.online) {
    syncResult.value = null;
    syncMessage.value = "仍在弱网状态：队列保留在设备中，恢复后只提交未完成项。";
    return;
  }
  syncMessage.value = "正在按统一操作号提交批次；已提交操作会跳过，不会重复合并或转移。";
  const previousBatchId = syncResult.value?.batchId;
  const hasOperationOutsideBatch = previousBatchId
    ? store.operations.some((item) => item.status !== "已同步" && item.submitBatchId !== previousBatchId)
    : false;
  const result = await store.flushBatch(syncResult.value?.ok === false || hasOperationOutsideBatch === false ? previousBatchId : undefined);
  syncResult.value = result;
  syncMessage.value = result.message;
}
function canAdvance(task: FieldTask) {
  if (task.status === "已完成") return false;
  return store.openConflictCount(task.householdId) === 0;
}
</script>

<template>
  <div class="shell">
    <aside class="side"><div class="brand"><b>FIELD OPS</b><span>灾后评估</span></div><nav><button v-for="item in ['需求记录', '重复合并', '任务分派', '同步队列', '冲突处理']" :key="item" :class="{ active: panel === item }" @click="panel = item">{{ item }} <span v-if="item === '同步队列' && store.queue.length">({{ store.queue.length }})</span></button></nav><div class="network"><small>设备与网络</small><b>{{ browserOnline && store.online ? '在线' : '弱网 / 离线' }}</b><NSwitch v-model:value="store.online" /><small>最近同步 {{ new Date(store.lastSyncedAt).toLocaleTimeString('zh-CN') }}</small></div></aside>
    <main>
      <header><div><small>评估批次 2026-09-29 · 河湾片区</small><h1>灾后需求评估与任务分派</h1><p>批次提交、重复合并、任务转移共用同一个操作号；字段冲突未清前不能结案。</p></div><div class="status-chip"><NProgress type="circle" :percentage="store.queue.length ? Math.max(8, 100 - store.queue.length * 8) : 100" :stroke-width="8" :width="42" /><span>{{ store.queue.length ? `${store.queue.length} 项待同步` : '数据已同步' }}</span></div></header>
      <section class="metrics"><NCard><NStatistic label="评估家庭" :value="store.metrics.households" /></NCard><NCard><NStatistic label="紧急需求" :value="store.metrics.urgent" /></NCard><NCard><NStatistic label="未完成任务" :value="store.metrics.openTasks" /></NCard><NCard><NStatistic label="本地队列" :value="store.metrics.queued" /></NCard></section>
      <NAlert v-if="!browserOnline || !store.online" type="warning" show-icon>当前网络不可用。新增记录、合并和任务仍可操作，所有变更会写入本地缓存；断网续传只处理未完成项，同一操作号不会执行两次。</NAlert>
      <div v-if="panel === '需求记录'" class="page-grid">
        <NCard title="家庭走访记录"><div class="households"><article v-for="item in store.households" :key="item.id" class="household" :class="{ selected: selectedId === item.id }" @click="selectedId = item.id"><div><b>{{ item.head }} · {{ item.members }}人</b><small>{{ item.community }} / {{ item.address }}</small><p>{{ item.needs.join('、') }} · {{ item.note }}</p><small v-if="item.mergedFrom.length" class="merge-hint">已转入：{{ item.mergedFrom.join('、') }}</small><small v-if="store.openConflictCount(item.id)" class="conflict-hint">有 {{ store.openConflictCount(item.id) }} 个字段冲突，暂不能结案</small></div><div><NTag :type="item.needLevel === '紧急' ? 'error' : item.needLevel === '高' ? 'warning' : 'success'">{{ item.needLevel }}</NTag><small>{{ item.status }} · v{{ item.version }}</small></div></article></div></NCard>
        <NCard title="新增需求记录"><form class="field-grid" @submit.prevent="submit"><label class="field"><span>户主姓名</span><NInput v-model:value="head" /><small>{{ errors.head }}</small></label><label class="field"><span>社区</span><NInput v-model:value="community" /></label><label class="field wide"><span>地址描述</span><NInput v-model:value="address" placeholder="不使用地图坐标时可描述楼栋与单元" /><small>{{ errors.address }}</small></label><label class="field"><span>家庭人数</span><input v-model="members" type="number" /></label><label class="field"><span>需求等级</span><NSelect v-model:value="needLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" /></label><label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="needs" placeholder="临时安置，饮用水" /><small>{{ errors.needs }}</small></label><label class="field wide"><span>现场说明</span><NInput v-model:value="note" type="textarea" /><small>{{ errors.note }}</small></label><div class="actions wide"><NButton attr-type="submit" type="primary">保存本地记录</NButton><NButton @click="sync">尝试同步</NButton></div></form></NCard>
      </div>
      <NCard v-if="panel === '重复合并'" title="疑似重复记录"><div v-for="group in store.duplicates" :key="group.map((item) => item.id).join('-')" class="duplicate"><b>{{ group[0].head }} · {{ group[0].community }}</b><p>{{ group.map((item) => `${item.address} / ${item.note}`).join('；') }}</p><small>不同字段自动合并；同一字段双方均有修改时保留两版；待同步操作会改指保留记录，任务进度只升不降。</small><NButton type="primary" size="small" @click="store.mergeDuplicate(group[1].id, group[0].id)">合并并转移复核任务</NButton></div><p v-if="!store.duplicates.length" class="empty">没有检测到疑似重复记录。</p></NCard>
      <div v-if="panel === '任务分派'" class="page-grid"><NCard title="任务列表"><div v-for="task in store.tasks" :key="task.id" class="task-row"><div><b :class="{ complete: task.status === '已完成' }">{{ task.title }}</b><small>{{ taskHousehold(task.householdId)?.head ?? '已合并家庭' }} · {{ task.due }}</small><small v-if="store.openConflictCount(task.householdId)" class="conflict-hint">家庭字段冲突未清，不能推进到结案</small></div><NTag>{{ task.priority }}</NTag><span>{{ task.assignee }} · {{ task.status }}</span><NButton size="small" :disabled="!canAdvance(task)" @click="advanceTask(task.id)">推进状态</NButton></div></NCard><NCard title="分派新任务"><p>当前家庭：<b>{{ selected?.head }}</b></p><p v-if="selected && store.openConflictCount(selected.id)" class="conflict-hint">该家庭有未清冲突，新增任务会保持开放，系统不会自动结案。</p><label class="field"><span>任务内容</span><NInput v-model:value="taskTitle" /></label><label class="field"><span>执行人/小组</span><NInput v-model:value="taskAssignee" /></label><NButton type="primary" block :disabled="!selected" @click="assignTask">加入任务并本地排队</NButton></NCard></div>
      <NCard v-if="panel === '同步队列'" title="待同步操作"><p>{{ syncMessage || '恢复连接后按统一操作号顺序提交，失败后保留已处理项，冲突不会自动覆盖。' }}</p><div v-if="syncResult" class="batch-summary"><NTag :type="syncResult.ok ? 'success' : 'warning'">{{ syncResult.ok ? '批次成功' : '等待续传' }}</NTag><span>操作号/批次：{{ syncResult.batchId }}</span><span>已处理 {{ syncResult.processed }} / 剩余 {{ syncResult.remaining }}</span></div><div v-for="item in store.operations" :key="item.id" class="queue-row"><NTag :type="item.status === '已同步' ? 'success' : item.status === '同步中' ? 'warning' : 'default'">{{ item.status }}</NTag><div><b>{{ item.entity }} · {{ item.detail }}</b><small>{{ item.action }} · 操作号 {{ item.id.slice(0, 13) }}{{ item.submitBatchId ? ` · 批次 ${item.submitBatchId.slice(0, 8)}` : '' }}</small><em v-if="item.error">{{ item.error }}</em></div><small>{{ new Date(item.time).toLocaleTimeString('zh-CN') }}</small></div><p v-if="!store.queue.length" class="empty">待同步队列为空。已完成操作仍保留在本地，用于防重放审计。</p><NButton type="primary" :loading="store.syncing" @click="sync">{{ syncResult?.ok === false ? '续传未完成项' : '人工确认并同步' }}</NButton><small v-if="cacheProbe"> 数据缓存时间：{{ new Date(cacheProbe.cachedAt).toLocaleTimeString('zh-CN') }}</small></NCard>
      <NCard v-if="panel === '冲突处理'" title="字段级冲突"><div v-for="item in openConflicts" :key="item.id" class="conflict"><b>{{ store.households.find((household) => household.id === item.householdId)?.head }} · {{ item.field }}</b><NTag size="small" :type="item.kind === '重复合并' ? 'info' : 'warning'">{{ item.kind }}</NTag><div class="conflict-values"><div><small>{{ item.localLabel }}</small><span>{{ item.localValue }}</span></div><div><small>{{ item.remoteLabel }}</small><span>{{ item.remoteValue }}</span></div></div><div class="actions"><NButton size="small" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用本地')">采用左侧</NButton><NButton size="small" type="primary" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用远端')">采用右侧</NButton><NTag>{{ item.status }}</NTag></div></div><p v-if="!openConflicts.length" class="empty">暂无待处理字段冲突。冲突解决后，任务进度才允许推进到结案。</p></NCard>
    </main>
  </div>
</template>
