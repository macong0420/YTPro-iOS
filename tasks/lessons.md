# 项目经验

- 处理 YouTube 广告响应时，不能把“删除 `streamingData`”等同于“跳过广告”：真机日志显示播放器随后 `no-playing-video`、`duration=NaN`，会等待并产生黑屏。媒体响应保持完整；用真机日志验证时延，不能仅靠模拟器测试宣称已消除黑屏。
- 拦截到 `/get_watch`、剥除 `adBreakHeartbeatParams` 仍不代表移除了广告调度：真机仍出现 15 秒广告，seek 到末尾后又发起 `get_watch` 并重复。未知响应结构时先记录有限的字段名和播放器能力（不能记录值/令牌），拿到证据再更改过滤规则；不要靠猜测字段继续宣称已修复。
- 后续真机日志显示移动播放器 `skipAd=false`，只有 `cancelPlayback=true` 和 `getAdState=true`；`cancelPlayback` 语义未知，不能贸然当跳广告接口调用。仅靠删心跳字段、媒体 seek 和猜测内部方法都不足以保证直接播放正片；涉及改播放器架构时先与用户确认取舍。
