# 海外眼健康行动协同后端

面向流动眼科医疗队（如 2026 斐济光明行）的协同后端：网络不稳定、多点离线筛查、
临时加急与翻译变更并存，系统保证**患者交接关系不丢、资源锁定不乱、返程后无人不落空**。

零运行时依赖（Node.js ≥ 18，仅使用 `node:` 内置模块），可在便携笔记本/边缘服务器直接运行；
`STATE_FILE` 指向本地 JSON 文件即可原子落盘，不设则纯内存运行（测试/演示）。

## 运行

```bash
npm test          # 24 个测试（领域规则 + HTTP 集成 + 持久化重启）
npm run demo      # 斐济返程倒计时全流程演示
npm start         # 启动 HTTP 服务（默认 8787；PORT / STATE_FILE / SEED_PATH 环境变量）
```

## 核心不变量

| 风险 | 系统保证 |
| --- | --- |
| 离线多点重复登记 | 患者以**当地可核验别名**（姓名+村落，规范化大小写/空格，当地联络人当面核验）进入筛查批次；同人多语言译名追加别名，不产生第二例档案 |
| 弱网重传/换机同步 | 图像摘要按 `任务+患者+内容哈希` **去重合并**（保留多批次来源）；同步号 `clientSyncId` 幂等 |
| 辅助判断越权 | 设备/算法结论一律 `advisory_only`；**只有医生复核**（角色校验）才能进入候选治疗路径 |
| 资源双订 | 手术间、设备、人员、耗材统一按时段锁定；重叠返回 `RESOURCE_CONFLICT`；耗材锁定即预占库存，完成治疗才扣减 |
| 加急挤占重症 | 绿色通道必须在医生复核时**记录理由**，加急时再记理由；已进入 `scheduled/preop/in_surgery/treated` 关键阶段的患者受保护，冲突返回 `PROTECTED_PATIENT` 而不是踢人 |
| 同意书瑕疵 | 知情同意保存**语言版本、文本版本、签署方式与见证人**（见证人不可为登记人本人），未复核为候选不得签署 |
| 重复治疗 | 每例患者至多一条治疗：业务唯一键 + 客户端事务号双层幂等，重复同步返回原记录，耗材不重复扣减 |
| 退出/故障/返程落空 | 退出、设备故障、任务结束都必须生成**明确转介**：目的地医院、原因、**责任人**与时限；同时释放未完成的资源锁定与耗材预占 |
| 越权访问 | 中方成员仅能访问被分配的任务（任务关闭后只读）；本地医院**获授权交接后**才能继续查看，可确认承接转介 |
| 返程后无法追溯 | 关闭任务前做零孤儿校验（未治疗者必须有转介+责任人）；凭当地别名可还原 `筛查→图像→人工决定→同意→排程→治疗/转介→后续责任人` 全链 |

## 数据模型（src/backend.js）

```
mission ── batches ── contacts ── patient(aliases[]) ── images[]（内容哈希去重）
                              └── reviews（医生决定，唯一闸门）
                              └── consents[]（语言版本 + 见证人）
                              └── slots[]（room/equipment/staff 时段锁定 + 耗材预占）
                              ├── treatment（每例至多一条，幂等）
                              └── referral（withdrawn / equipment_failure / mission_end + 责任人）
handover（医院授权）   audit（全程追加审计）
```

## HTTP API

身份通过 `x-member-id` 请求头传递（流动内网，TLS 由反向代理终止）。
写操作成功返回 201；幂等重放/重复提交返回 200 并带 `replayed`/`duplicate` 标记。

```
POST  /missions/:missionId/batches/:batchId/screenings   别名入批（localName, village, verifierId, deviceId）
POST  /missions/:missionId/images                        离线图像摘要同步（contentHash, clientSyncId）
POST  /patients/:patientId/reviews                       医生复核（eligible|green_channel|observe|reject, reason）
POST  /patients/:patientId/consents                      知情同意（languageVersion, witnessId, signatureType）
POST  /patients/:patientId/slots                         资源时段锁定（startAt/endAt, resourceIds, staffIds, consumables）
POST  /patients/:patientId/expedite                      绿色加急（reason；关键阶段保护）
POST  /slots/:slotId/phase                               推进 preop/in_surgery
POST  /patients/:patientId/treatment                     治疗完成（procedure, clientTxId；重复不产生第二例）
POST  /patients/:patientId/referral                      退出/故障/结束转介（outcome, reason, followUpOwnerId, followUpDueAt）
POST  /missions/:missionId/equipment/:equipmentId/failure  设备故障登记（受影响患者自动转介）
POST  /referrals/:referralId/acknowledge                 本地责任人确认承接
POST  /missions/:missionId/handovers                     授权本地医院交接（hospitalId）
POST  /missions/:missionId/close                         关闭任务（零孤儿校验）
GET   /missions/:missionId/resolve?local_name=&village=  按当地别名还原全链
GET   /patients/:patientId/timeline                      单人全链与结局
GET   /missions/:missionId/orphans                       无归属患者扫描
GET   /missions/:missionId/audit                         审计事件
GET   /consumables/:resourceId                           耗材库存/预占/可用
```

错误码（HTTP 状态码）：`VALIDATION(400)`、`UNAUTHENTICATED(401)`、
`FORBIDDEN/ROLE_DENIED/OUT_OF_MISSION_SCOPE/NO_HANDOVER(403)`、`NOT_FOUND(404)`、
`RESOURCE_CONFLICT/PROTECTED_PATIENT/CONSUMABLE_SHORTAGE/ALREADY_REFERRED/ORPHANED_PATIENTS(409)`、
`INVALID_STATE/HANDOVER_REQUIRED/MISSION_CLOSED/NOT_CANDIDATE/NOT_REVIEWED/NO_CONSENT(409)`。

## 代码结构

```
fixtures/seed.json     任务、医院、手术间/设备/耗材、中外方成员（稳定标识基线）
src/seed.js            基线加载与校验
src/store.js           内存状态、幂等索引、别名/内容哈希索引、原子落盘与重启重建
src/errors.js          类型化业务错误
src/backend.js         全部领域规则与不变量（MissionBackend）
src/server.js          零依赖 HTTP 适配层
src/main.js            应用装配与启动入口
scripts/demo.mjs       全流程演示
test/                  node:test 测试（领域规则 / HTTP / 持久化）
```

## 设计说明

- **双层幂等**：客户端事务号（`clientSyncId`/`clientTxId`）消除重传歧义；业务唯一键
  （患者-治疗唯一、图像内容哈希、别名索引）在重启后仍然兜底，持久化文件无需保存临时幂等表。
- **拒绝而不是重排**：加急遇到关键阶段患者直接报错并指出阻塞时段，由协调员改时间或换资源，
  系统不替人做"踢台"决定。
- **闭环才可关闭**：任务关闭要求先完成医院交接授权，且每名未治疗患者都有带责任人的转介；
  `findOrphans` 也可在返程倒计时中随时自查。
