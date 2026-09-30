package config

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestTaskNotifyPreferencesDefaults(t *testing.T) {
	var zero TaskNotifyPreferences
	if TaskNotifyNeedsInputEnabled(zero) {
		t.Fatalf("needsInput 缺字段时必须默认关（零打扰）")
	}
	if TaskNotifyFailedEnabled(zero) {
		t.Fatalf("failed 缺字段时必须默认关（零打扰）")
	}
	if TaskNotifyCompletedEnabled(zero) {
		t.Fatalf("completed 缺字段时必须默认关")
	}
	normalized := normalizeTaskNotifyPreferences(zero)
	if normalized.NeedsInput == nil || normalized.Failed == nil || normalized.Completed == nil {
		t.Fatalf("规范化后三个字段都不该是 nil")
	}
	if TaskNotifyStalledEnabled(zero) {
		t.Fatalf("stalled 缺字段时必须默认关（新通知类型默认不打扰）")
	}
	if normalized.Stalled == nil || *normalized.Stalled {
		t.Fatalf("规范化后 stalled 必须是显式的 false")
	}
}

func TestTaskNotifyPreferencesExplicitValues(t *testing.T) {
	off := false
	on := true
	value := TaskNotifyPreferences{NeedsInput: &off, Failed: &off, Completed: &on}
	if TaskNotifyNeedsInputEnabled(value) {
		t.Fatalf("显式 false 必须生效（不能被默认覆盖）")
	}
	if TaskNotifyFailedEnabled(value) {
		t.Fatalf("显式 false 必须生效")
	}
	if !TaskNotifyCompletedEnabled(value) {
		t.Fatalf("显式 true 必须生效")
	}
}

func TestTaskNotifyPreferencesKeepsExplicitFalseThroughNormalize(t *testing.T) {
	off := false
	normalized := NormalizedTaskNotifyPreferences(TaskNotifyPreferences{Failed: &off})
	if TaskNotifyFailedEnabled(normalized) {
		t.Fatalf("规范化必须保住显式 false（不能丢成 nil 又回落默认）")
	}
	if TaskNotifyNeedsInputEnabled(normalized) || TaskNotifyCompletedEnabled(normalized) {
		t.Fatalf("未给的字段仍应是默认 false/false/false")
	}
}

func TestAppSettingsTaskNotifyMountedWithDefaults(t *testing.T) {
	// 旧配置（没有 task_notify 字段）⇒ 走 withDefaults ⇒ 全关（零打扰）。
	settings := withDefaults(AppSettings{})
	if TaskNotifyNeedsInputEnabled(settings.TaskNotify) {
		t.Fatalf("AppSettings 缺 task_notify 时 needsInput 必须默认关")
	}
	if TaskNotifyFailedEnabled(settings.TaskNotify) {
		t.Fatalf("AppSettings 缺 task_notify 时 failed 必须默认关")
	}
	if TaskNotifyCompletedEnabled(settings.TaskNotify) {
		t.Fatalf("AppSettings 缺 task_notify 时 completed 必须默认关")
	}
	// 显式关掉 needsInput ⇒ 经 withDefaults 仍然是关。
	off := false
	explicit := withDefaults(AppSettings{TaskNotify: TaskNotifyPreferences{NeedsInput: &off}})
	if TaskNotifyNeedsInputEnabled(explicit.TaskNotify) {
		t.Fatalf("显式 false 不能被 withDefaults 覆盖成默认 true")
	}
}

func TestAppSettingsTaskNotifyJSONRoundTrip(t *testing.T) {
	off := true
	raw, err := json.Marshal(AppSettings{TaskNotify: TaskNotifyPreferences{Completed: &off}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !bytes.Contains(raw, []byte(`"task_notify"`)) {
		t.Fatalf("期望 JSON 名是 task_notify，实际: %s", string(raw))
	}
	var back AppSettings
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !TaskNotifyCompletedEnabled(back.TaskNotify) {
		t.Fatalf("completed 显式 true 应能往返")
	}
}

// stalled（模型疑似挂死）默认必须是**关**：新增的通知类型默认不打扰，
// 想收的人自己去设置里打开。这条测试钉住默认值，防止以后被“顺手改成 true”。
func TestTaskNotifyStalledDefaultsToOff(t *testing.T) {
	var zero TaskNotifyPreferences
	if TaskNotifyStalledEnabled(zero) {
		t.Fatalf("stalled 缺字段时必须默认关")
	}
	normalized := normalizeTaskNotifyPreferences(zero)
	if normalized.Stalled == nil || *normalized.Stalled {
		t.Fatalf("归一化后 stalled 必须是显式的 false")
	}
	on := true
	enabled := normalizeTaskNotifyPreferences(TaskNotifyPreferences{Stalled: &on})
	if !TaskNotifyStalledEnabled(enabled) {
		t.Fatalf("显式打开 stalled 后必须读回 true")
	}
	clone := cloneTaskNotifyPreferences(enabled)
	if clone.Stalled == enabled.Stalled {
		t.Fatalf("clone 必须复制指针，不能与原值共享地址")
	}
	*clone.Stalled = false
	if !TaskNotifyStalledEnabled(enabled) {
		t.Fatalf("改克隆体不得影响原值")
	}
}

// sound（提示音）默认必须是**关**：系统提示音是强提醒，读者明确反馈“有点打扰”
// ⇒ 想要声音的人自己去设置里打开。这条测试钉住默认值，防止以后被"顺手改成 true"。
func TestTaskNotifySoundDefaultsToSilent(t *testing.T) {
	var zero TaskNotifyPreferences
	if TaskNotifySoundEnabled(zero) {
		t.Fatalf("sound 缺字段时必须默认关（静默）")
	}
	normalized := normalizeTaskNotifyPreferences(zero)
	if normalized.Sound == nil || *normalized.Sound {
		t.Fatalf("归一化后 sound 必须是显式的 false")
	}
	on := true
	enabled := normalizeTaskNotifyPreferences(TaskNotifyPreferences{Sound: &on})
	if !TaskNotifySoundEnabled(enabled) {
		t.Fatalf("显式打开 sound 后必须读回 true")
	}
	clone := cloneTaskNotifyPreferences(enabled)
	if clone.Sound == enabled.Sound {
		t.Fatalf("clone 必须复制指针，不能与原值共享地址")
	}
	*clone.Sound = false
	if !TaskNotifySoundEnabled(enabled) {
		t.Fatalf("改克隆体不得影响原值")
	}
}
