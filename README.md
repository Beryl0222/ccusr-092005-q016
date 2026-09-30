# 海外眼健康行动协同

面向网络不稳定、跨机构交接的流动眼科医疗队的协同后端（纯领域逻辑，零外部依赖）。Node.js 代码读取领域资料并强制执行业务规则，`node:test` 覆盖离线筛查、临时加急、资源冲突与返程交接全流程。

## 执行

```bash
npm test
```

## 业务规则与对应实现

| 关注点 | 规则 | 实现入口 |
| --- | --- | --- |
| 患者别名 | 以当地别名 + 可核验凭证（社区名册/指纹/证件）入批；重复登记回到同一例 | `registerPatient` / `resolveByAlias` |
| 离线回传 | 便携设备离线批次按客户端批次号幂等接收；图像摘要按内容指纹跨设备去重合并，辅助判断仅作参考 | `syncScreeningBatch` |
| 人工决定 | 只有医生复核为候选，患者才可进入治疗路径 | `reviewByDoctor` |
| 资源锁定 | 手术室时段、人员、设备、耗材同时锁定，冲突/缺货拒绝 | `lockSlot` / `advanceStage` |
| 绿色通道 | 必须记录理由与申请人；先为被挤者安排替代时段；已进入术前准备/术中的患者不可挤占 | `lockSlot({greenChannel})` |
| 知情同意 | 保存语言版本、翻译来源与具备资格的见证人；翻译修订留新版本，不覆盖旧版 | `recordConsent` |
| 治疗幂等 | 无同意不开台；同一客户端记录重复同步不产生第二例治疗 | `startTreatment` / `completeTreatment` |
| 患者退出 | 释放资源锁，必须生成有本地责任人与后续安排的转介 | `patientWithdraw` |
| 设备故障 | 未进关键阶段的患者尝试重排，无法保证即转介；故障设备停止锁定 | `reportEquipmentFailure` |
| 访问控制 | 中方成员仅访问任务名册范围，任务关闭后访问冻结；本地医院经授权交接后续看 | `assertViewPatient` / `authorizeHandover` |
| 任务收尾 | 先授权交接；每位未完成治疗者必须有本地责任人，否则拒绝关闭 | `closeMission` |
| 全链还原 | 从别名还原 筛查 → 人工决定 → 治疗或转介 → 后续负责人；连续性审计保证无孤儿记录 | `timelineByAlias` / `continuityAudit` |

## 代码结构

- `fixtures/seed.json` — 领域资料基线：斐济任务、两台便携筛查设备、手术室、中方/本地人员、耗材、机构
- `src/seed.js` — 资料读取校验
- `src/backend.js` — 协同后端核心（`MissionBackend`，含 `DomainError` 错误码）
- `src/setup.js` — 从资料基线装配环境并按任务日期生成手术时段
- `src/timeline.js` — 别名时间线还原与连续性审计
- `test/seed.test.js`、`test/workflow.test.js` — 基线校验与 10 项端到端规则测试（共 11 个测试）
