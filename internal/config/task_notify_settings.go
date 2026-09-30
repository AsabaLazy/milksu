package config

// TaskNotifyPreferences —— 任务通知的开关（外壳侧 NotifyTask 的补充层）。
//
// 照 CompanionProactivity 的既有范式：可选布尔（*bool + omitempty）⇒ 缺字段时由下面的
// 规范化/访问器给默认值，而不是让零值 false 把"默认开"吃掉。
//
// 默认值：**五类全关（零打扰）**——needsInput / failed / completed / stalled / sound 全部默认 false。
//
//	—— 通知是强提醒，升级后不该突然开始弹；想收的人去设置里按类打开。
//	—— sound 默认 **false（静默）**：带系统提示音属于强提醒，
//	    ⇒ 想要声音的人自己去设置里打开（外壳 NotifyTask 的 silent 字段本来就有 ✓）。
type TaskNotifyPreferences struct {
	NeedsInput *bool `json:"needs_input,omitempty"`
	Failed     *bool `json:"failed,omitempty"`
	Completed  *bool `json:"completed,omitempty"`
	Stalled    *bool `json:"stalled,omitempty"`
	Sound      *bool `json:"sound,omitempty"`
}

// normalizeTaskNotifyPreferences 给缺失字段补默认值（非法/缺失都不崩，回落默认）。
func normalizeTaskNotifyPreferences(value TaskNotifyPreferences) TaskNotifyPreferences {
	if value.NeedsInput == nil {
		value.NeedsInput = boolPointer(false)
	}
	if value.Failed == nil {
		value.Failed = boolPointer(false)
	}
	if value.Completed == nil {
		value.Completed = boolPointer(false)
	}
	if value.Stalled == nil {
		value.Stalled = boolPointer(false)
	}
	if value.Sound == nil {
		value.Sound = boolPointer(false)
	}
	return value
}

// NormalizedTaskNotifyPreferences 是给外部（含测试）用的公开入口。
func NormalizedTaskNotifyPreferences(value TaskNotifyPreferences) TaskNotifyPreferences {
	return normalizeTaskNotifyPreferences(value)
}

// 访问器：nil（缺字段/旧配置）一律按默认值处理（默认全关，零打扰）。
func TaskNotifyNeedsInputEnabled(value TaskNotifyPreferences) bool {
	if value.NeedsInput == nil {
		return false
	}
	return *value.NeedsInput
}

func TaskNotifyFailedEnabled(value TaskNotifyPreferences) bool {
	if value.Failed == nil {
		return false
	}
	return *value.Failed
}

func TaskNotifyCompletedEnabled(value TaskNotifyPreferences) bool {
	if value.Completed == nil {
		return false
	}
	return *value.Completed
}

// TaskNotifyStalledEnabled：是否发“模型疑似挂死”（停滞看门狗）这一类系统告警。
// 默认 **false（关）**：新增通知类型默认不打扰，想收的人自己去设置里打开。
func TaskNotifyStalledEnabled(value TaskNotifyPreferences) bool {
	if value.Stalled == nil {
		return false
	}
	return *value.Stalled
}

// TaskNotifySoundEnabled：是否允许通知带提示音。默认 false（静默）—— 静音是善意默认：
// 提示音属于强提醒，读者明确抱怨过“有点打扰” ⇒ 宁愿少响一声，也不要吓人一跳。
func TaskNotifySoundEnabled(value TaskNotifyPreferences) bool {
	if value.Sound == nil {
		return false
	}
	return *value.Sound
}

// cloneTaskNotifyPreferences 拷贝指针，避免调用方共享同一块布尔内存。
func cloneTaskNotifyPreferences(value TaskNotifyPreferences) TaskNotifyPreferences {
	if value.NeedsInput != nil {
		flag := *value.NeedsInput
		value.NeedsInput = &flag
	}
	if value.Failed != nil {
		flag := *value.Failed
		value.Failed = &flag
	}
	if value.Completed != nil {
		flag := *value.Completed
		value.Completed = &flag
	}
	if value.Stalled != nil {
		flag := *value.Stalled
		value.Stalled = &flag
	}
	if value.Sound != nil {
		flag := *value.Sound
		value.Sound = &flag
	}
	return value
}
