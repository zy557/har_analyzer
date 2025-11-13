# 事件关系图生成说明

本文档说明本项目事件关系图的生成方法、关系建立规则与阶段统计来源。

## 数据来源
- 输入：标准 HAR 文件（Chrome/Firefox/DevTools 导出），解析后得到每个请求条目（entry）。
- 解析：`server.har_utils.parse_har_file` 解析 JSON，`normalize_entries` 归一化字段（时间戳、URL、method、status、mimeType、资源类型、timings 等）。

## 关系图构建
- 实现位置：`server/event_relations.py` 的 `build_event_graph(entries)`。
- 输出结构：
  - `nodes`: 每个请求对应一个节点，包含 `id、url、host、path、type（resourceType）、status、method、started_ms` 等。
  - `edges`: 请求之间的触发关系，包含 `source（发起者 id）、target（当前请求 id）、reason（parser/script/redirect/xhr/prefetch/preload 等）`。

### 关系判定规则
`build_event_graph` 会综合以下线索建立边：
1. parser 触发：HTML 文档在解析阶段触发的资源（样式表、脚本、图片、字体等），依据 `initiator` 字段的 `type='parser'` 或 HAR 中的请求的入站关系；
2. script 触发：由脚本执行触发（`fetch/xhr/dynamic import` 等），依据 `initiator.type='script'` 或者请求的 `initiator.stack` 里出现的脚本 URL；
3. redirect：HTTP 重定向（3xx），`edges` 中记录前后请求之间的 `reason='redirect'`；
4. xhr：显式的 XHR/fetch 类型，`reason='xhr'`；
5. 预取/预加载：`prefetch/preload` 等资源提示；
6. 兜底：若 `initiator` 不足以确定，使用同 `document` 会话内的时间先后与常见资源依赖推断（谨慎使用）。

辅助函数：
- `_get_initiator_url(entry)`：从 HAR 的 `initiator`（如 `stack.callFrames` 或 `url`）提取触发源 URL；
- `_to_int/_to_float`：健壮地转换整数/浮点，避免异常；

节点与边去重/稳定化：
- 节点 id 使用条目下标或稳定哈希；
- 边按 `(source,target,reason)` 组合去重；

## 阶段统计
- 实现位置：`build_phase_stats(entries)`。
- 统计项：按 HAR `timings` 汇总 `blocked/dns/connect/ssl/send/wait/receive` 各阶段耗时；
- 输出：`total`（全局汇总）与 `byType`（按资源类型细分）；

## 前端可视化要点
- 力导向：事件页前端 `static/events.js` 使用 D3 `forceSimulation`（`link/charge/collide/center`），并对孤立节点弱化斥力、添加径向力，将其收敛在中心附近，便于查看；
- 颜色与箭头：边按 `reason` 着色并绘制箭头，节点按资源类型着色；
- 交互：缩放、拖拽、悬停提示、点击节点邻接高亮、框选多节点；
- 对比：支持快照 A/B，对比新增/移除并支持“仅显示变化”过滤；
- 导入/导出：支持导出 JSON/PNG；也可从导出的 JSON 复原关系图（保留坐标时直接复原，不带坐标时重新布局）。

## 事件页交互扩展（多选与群拖拽）
- 框选（Shift + 拖拽）：
  - 替换模式：仅按住 Shift 时，框选结果替换当前多选集合；
  - 添加模式：Shift + Ctrl，框选区域内的节点加入到现有多选集合；
  - 移除模式：Shift + Alt，框选区域内的节点从现有多选集合移除；
- 单个切换（Ctrl + 点击）：切换该节点是否在多选集合中；
- 群拖拽：当存在多选集合时，拖拽任一被选节点会整体移动多选集合中所有节点（保持相对位置）；无多选时仅拖拽该节点；
- 快捷键：按下 Esc 清空所有选择；
- 侧边栏：右侧「文本面板」显示「多选（计数）」与所选节点列表（最多 100 条，超出显示省略提示）。

## 阶段统计图扩展
- 位置：事件页「阶段统计」画布 `#evtPhaseCanvas`；
- 对数 Y 轴：勾选「对数 Y 轴」复选框启用 `log1p` 缩放，小值更易比较；刻度标签通过反变换 `expm1` 显示等距对数域刻度；
- 图例与轴标题：画布上绘制 X 轴标题「资源类型」、Y 轴标题「耗时 (ms)」，右上角显示阶段颜色图例；
- 导出：支持导出 PNG（阶段图）与 CSV（按类型分阶段统计）。

## 验证建议
- 多选与群拖拽：
  1. 使用 Ctrl + 点击选择若干节点；
  2. 拖拽其中一个被选节点，确认其他被选节点随之整体移动；
  3. 使用 Shift + 拖拽进行框选，测试替换/添加/移除三种模式；
  4. 按 Esc 清空选择，侧边栏计数归零；
- 阶段统计图：
  1. 加载阶段统计数据并查看柱状图；
  2. 勾选/取消「对数 Y 轴」观察缩放与刻度变化；
  3. 悬停提示显示类型与阶段耗时；
  4. 导出 PNG 与 CSV 文件验证内容。

## 从导出 JSON 复原关系图
导出的 JSON 结构：
```json
{
  "nodes": [{"id":1,"url":"...","type":"script","status":200,"x":0,"y":0}, ...],
  "edges": [{"source":1,"target":2,"reason":"parser"}, ...]
}
```
在事件页点击“导入JSON”，选择该文件即可复原：
- 若 `nodes` 带 `x/y`，将按原位置绘制；
- 若未带 `x/y`，将初始化随机位置并使用 D3 力仿真重新布局。

## 注意事项
- HAR 的 `initiator` 字段在不同浏览器/版本有差异，关系推断可能不完整；
- 重定向链会被串接为连续边；
- 大图建议使用过滤与子树聚焦以提升可读性；

## 贡献
欢迎提交包含更多 `initiator` 判定与关系规则的 PR，或针对特殊框架（如 React/Vue/Angular）事件链的增强。