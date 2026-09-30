<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NSelect, NStatistic, NSwitch, NTag } from "naive-ui";
import { useOnline } from "@vueuse/core";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useAssessmentStore, type Household, type NeedLevel } from "~/stores/assessment";
import { probeCache } from "~/utils/api";

const store = useAssessmentStore();
const browserOnline = useOnline();
const panel = ref("需求记录");
const selectedId = ref(store.households[0]?.id ?? "");
const cacheProbe = ref<{ cachedAt: string; source: string } | null>(null);
const schema = toTypedSchema(z.object({ head: z.string().min(2, "请输入户主姓名"), community: z.string().min(2), address: z.string().min(4), members: z.string().min(1, "请输入家庭人数").regex(/^[1-9]\d*$/, "请输入正整数"), needLevel: z.enum(["紧急", "高", "一般"]), needs: z.string().min(2), note: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema, initialValues: { head: "", community: "河湾社区", address: "", members: "1", needLevel: "一般" as NeedLevel, needs: "", note: "" } });
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

onMounted(async () => {
  cacheProbe.value = await probeCache();
  store.online = browserOnline.value;
});
const submit = handleSubmit((values) => {
  store.addHousehold({ head: values.head, community: values.community, address: values.address, members: Number(values.members), vulnerable: [], needLevel: values.needLevel as NeedLevel, needs: values.needs.split(/[，,]/).map((item) => item.trim()).filter(Boolean), note: values.note });  resetForm();
});
function assignTask() {
  if (!selected.value) return;
  store.addTask({ householdId: selected.value.id, title: taskTitle.value, assignee: taskAssignee.value, priority: selected.value.needLevel, due: "2026-09-30 18:00" });
}
function sync() {
  store.simulateSync();
}
function conflictHead(householdId: string) {
  return store.households.find((item) => item.id === householdId)?.head ?? "已合并记录";
}
</script>

<template>
  <div class="shell">
    <aside class="side">
      <div class="brand"><b>FIELD OPS</b><span>灾后评估</span></div>
      <nav>
        <button v-for="item in ['需求记录', '重复合并', '任务分派', '同步队列', '冲突处理']" :key="item" :class="{ active: panel === item }" @click="panel = item">
          {{ item }}
          <span v-if="item === '同步队列' && store.metrics.queued">({{ store.metrics.queued }})</span>
          <span v-if="item === '冲突处理' && store.metrics.blocked" class="dot-dot"></span>
        </button>
      </nav>
      <div class="network">
        <small>设备与网络</small>
        <b>{{ browserOnline && store.online ? '在线' : '弱网 / 离线' }}</b>
        <NSwitch v-model:value="store.online" />
        <small>最近同步 {{ new Date(store.lastSyncedAt).toLocaleTimeString('zh-CN') }}</small>
      </div>
    </aside>
    <main>
      <header>
        <div>
          <small>评估批次 2026-09-29 · 河湾片区</small>
          <h1>灾后需求评估与任务分派</h1>
          <p>记录可离线保存，恢复连接后按统一操作号续传；字段冲突未清前家庭不能结案。</p>
        </div>
        <div class="status-chip">
          <NProgress type="circle" :percentage="100 - store.metrics.queued * 8" :stroke-width="8" :width="42" />
          <span>{{ store.metrics.queued ? `${store.metrics.queued} 项待同步` : '数据已同步' }}</span>
        </div>
      </header>

      <section class="metrics">
        <NCard><NStatistic label="评估家庭" :value="store.metrics.households" /></NCard>
        <NCard><NStatistic label="紧急需求" :value="store.metrics.urgent" /></NCard>
        <NCard><NStatistic label="未完成任务" :value="store.metrics.openTasks" /></NCard>
        <NCard><NStatistic label="本地队列" :value="store.metrics.queued" /></NCard>
      </section>

      <NAlert v-if="!browserOnline || !store.online" type="warning" show-icon>当前网络不可用。新增记录与任务仍可操作，所有变更写入本地缓存与待同步队列；恢复后从未完成项续传，已处理项不重复执行。</NAlert>
      <NAlert v-if="store.blockedMessage" type="warning" show-icon class="blocked-alert">{{ store.blockedMessage }}</NAlert>

      <div v-if="panel === '需求记录'" class="page-grid">
        <NCard title="家庭走访记录">
          <div class="households">
            <article v-for="item in store.households" :key="item.id" class="household" :class="{ selected: selectedId === item.id, conflicted: store.hasUnresolvedConflict(item.id) }" @click="selectedId = item.id">
              <div>
                <b>{{ item.head }} · {{ item.members }}人</b>
                <small>{{ item.community }} / {{ item.address }}</small>
                <p>{{ item.needs.join('、') }} · {{ item.note }}</p>
              </div>
              <div class="tags">
                <NTag :type="item.needLevel === '紧急' ? 'error' : item.needLevel === '高' ? 'warning' : 'success'">{{ item.needLevel }}</NTag>
                <NTag v-if="store.hasUnresolvedConflict(item.id)" type="warning">冲突未清</NTag>
                <small>{{ item.status }} · v{{ item.version }}</small>
              </div>
            </article>
          </div>
        </NCard>
        <NCard title="新增需求记录">
          <form class="field-grid" @submit.prevent="submit">
            <label class="field"><span>户主姓名</span><NInput v-model:value="head" /><small>{{ errors.head }}</small></label>
            <label class="field"><span>社区</span><NInput v-model:value="community" /></label>
            <label class="field wide"><span>地址描述</span><NInput v-model:value="address" placeholder="不使用地图坐标时可描述楼栋与单元" /><small>{{ errors.address }}</small></label>
            <label class="field"><span>家庭人数</span><NInput v-model:value="members" inputmode="numeric" /><small>{{ errors.members }}</small></label>
            <label class="field"><span>需求等级</span><NSelect v-model:value="needLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" /></label>
            <label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="needs" placeholder="临时安置，饮用水" /><small>{{ errors.needs }}</small></label>
            <label class="field wide"><span>现场说明</span><NInput v-model:value="note" type="textarea" /><small>{{ errors.note }}</small></label>
            <div class="actions wide"><NButton attr-type="submit" type="primary">保存本地记录</NButton><NButton @click="sync">尝试同步</NButton></div>
          </form>
        </NCard>
      </div>

      <NCard v-if="panel === '重复合并'" title="疑似重复记录">
        <NAlert type="info" show-icon class="merge-hint">合并按统一操作号处理：字段级三方合并，不同字段各自合并，同一字段双方都改则保留两版；任务与待同步操作转入保留记录，进度不倒退。</NAlert>
        <div v-for="group in store.duplicates" :key="group.map((item) => item.id).join('-')" class="duplicate">
          <b>{{ group[0].head }} · {{ group[0].community }}</b>
          <p>{{ group.map((item) => `${item.address} / ${item.note}`).join('；') }}</p>
          <NButton type="primary" size="small" @click="store.mergeDuplicate(group[1].id, group[0].id)">合并为一条并转入任务</NButton>
        </div>
        <p v-if="!store.duplicates.length" class="empty">没有检测到疑似重复记录。</p>
      </NCard>

      <div v-if="panel === '任务分派'" class="page-grid">
        <NCard title="任务列表">
          <div v-for="task in store.tasks" :key="task.id" class="task-row">
            <div>
              <b :class="{ complete: task.status === '已完成' }">{{ task.title }}</b>
              <small>{{ conflictHead(task.householdId) }} · {{ task.due }}</small>
            </div>
            <NTag>{{ task.priority }}</NTag>
            <span>{{ task.assignee }} · {{ task.status }}</span>
            <NButton size="small" :disabled="task.status === '已完成'" @click="store.advanceTask(task.id)">推进状态</NButton>
          </div>
        </NCard>
        <NCard title="分派新任务">
          <p>当前家庭：<b>{{ selected?.head }}</b></p>
          <label class="field"><span>任务内容</span><NInput v-model:value="taskTitle" /></label>
          <label class="field"><span>执行人/小组</span><NInput v-model:value="taskAssignee" /></label>
          <NButton type="primary" block :disabled="!selected" @click="assignTask">加入任务并本地排队</NButton>
        </NCard>
      </div>

      <NCard v-if="panel === '同步队列'" title="待同步操作">
        <div class="sync-toolbar">
          <NTag :type="store.metrics.failed ? 'error' : 'success'">已处理 {{ store.doneOps }} / {{ store.ops.length }}</NTag>
          <label class="fail-toggle"><NSwitch v-model:value="store.injectFailure" /> 模拟中途断网（处理 2 项后中断，已处理项保留）</label>
        </div>
        <p>{{ store.syncMessage || '恢复连接后按操作号顺序提交，已处理项不重复执行。' }}</p>
        <div v-for="item in store.queue" :key="item.id" class="queue-row" :class="{ failed: item.status === 'failed' }">
          <NTag :type="item.status === 'failed' ? 'error' : 'info'">{{ item.action }}</NTag>
          <span>{{ item.entity }} · {{ item.detail }}</span>
          <small>操作号 {{ item.batchId.slice(0, 8) }} · {{ new Date(item.time).toLocaleTimeString('zh-CN') }}</small>
          <NTag v-if="item.status === 'failed'" type="error">失败</NTag>
          <NButton v-if="item.status === 'failed'" size="small" type="primary" @click="store.retryFailed(item.id)">续传</NButton>
        </div>
        <p v-if="!store.queue.length" class="empty">待同步队列为空，全部操作已处理。</p>
        <NButton type="primary" :loading="store.syncing" @click="sync">人工确认并同步</NButton>
        <small v-if="cacheProbe"> 数据缓存时间：{{ new Date(cacheProbe.cachedAt).toLocaleTimeString('zh-CN') }}</small>
      </NCard>

      <NCard v-if="panel === '冲突处理'" title="字段级冲突">
        <NAlert type="warning" show-icon class="merge-hint">存在未处理冲突的家庭不能结案；任务转入保留记录后进度不倒退。</NAlert>
        <div v-for="item in store.conflicts" :key="item.id" class="conflict">
          <b>{{ conflictHead(item.householdId) }} · {{ item.field }}</b>
          <NTag :type="item.origin === 'merge' ? 'warning' : 'info'">{{ item.origin === 'merge' ? '重复合并' : '同步' }}</NTag>
          <div class="conflict-values">
            <div><small>本机记录</small><span>{{ item.localValue }}</span></div>
            <div><small>远端记录</small><span>{{ item.remoteValue }}</span></div>
          </div>
          <div class="actions">
            <NButton size="small" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用本地')">采用本机</NButton>
            <NButton size="small" type="primary" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用远端')">采用远端</NButton>
            <NTag>{{ item.status }}</NTag>
          </div>
        </div>
        <p v-if="!store.conflicts.length" class="empty">暂无字段冲突。可先点击“人工确认并同步”模拟多人合并。</p>
      </NCard>
    </main>
  </div>
</template>
