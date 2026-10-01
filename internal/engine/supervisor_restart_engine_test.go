package engine

import (
	"testing"
	"time"
)

// RestartEngine is the reader's escape hatch for a Sidecar that has stopped reading stdin:
// abort_session is written into a process that no longer consumes it, so the retry queued
// behind the stuck prompt never runs. The fix is to kill that process now, take it out of
// rotation, and let the next dispatch spawn a fresh one.
//
// One Sidecar serves a whole (kernel, workspace), so restarting it ends every running turn
// in that workspace. Each of those sessions has to be told via engine.restarted, otherwise
// the renderer leaves them spinning forever. engine.restarted (not engine.error) keeps an
// action the reader asked for out of the failure banner.
func TestRestartEngineKillsTheSidecarAndReportsEachServedSession(t *testing.T) {
	collector := newEventCollector()
	supervisor := NewSupervisor(collector.emit)
	process := testSidecarProcess("/workspace/a")
	supervisor.process = process
	registerTestSession(supervisor, "session-a", KernelPi, "/workspace/a", true)
	registerTestSession(supervisor, "session-b", KernelPi, "/workspace/a", true)

	if err := supervisor.RestartEngine("session-a"); err != nil {
		t.Fatalf("RestartEngine: %v", err)
	}

	if !process.retired.Load() {
		t.Fatal("the restarted process must be marked retired")
	}
	if supervisor.process != nil {
		t.Fatal("the kernel slot must be cleared so the next dispatch spawns a fresh Sidecar")
	}
	for _, id := range []string{"session-a", "session-b"} {
		if _, exists := supervisor.sessions[id]; exists {
			t.Fatalf("session %s must be forgotten after its Sidecar was killed", id)
		}
	}
	for _, id := range []string{"session-a", "session-b"} {
		event := awaitRestartedSession(t, collector, id)
		if !event.Done {
			t.Fatalf("engine.restarted for %s must be a terminal event", id)
		}
		if event.Error != "" {
			t.Fatalf("engine.restarted must not carry an error the reader did not cause: %q", event.Error)
		}
	}
}

func awaitRestartedSession(t *testing.T, collector *eventCollector, sessionID string) Event {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if event, found := collector.find(sessionID, "engine.restarted"); found {
			return event
		}
		if time.Now().After(deadline) {
			t.Fatalf("session %s was never told its engine was restarted", sessionID)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestRestartEngineOnAParkedWorkspaceClearsTheParkedSlot(t *testing.T) {
	collector := newEventCollector()
	supervisor := NewSupervisor(collector.emit)
	process := parkTestProcess(supervisor, "/workspace/parked", time.Now())
	registerTestSession(supervisor, "session-parked", KernelPi, "/workspace/parked", true)

	if err := supervisor.RestartEngine("session-parked"); err != nil {
		t.Fatalf("RestartEngine: %v", err)
	}

	key := sidecarWorkspaceKey(KernelPi, "/workspace/parked")
	if _, stillParked := supervisor.parked[key]; stillParked {
		t.Fatal("a restarted parked Sidecar must be removed from the parked set")
	}
	if !process.retired.Load() {
		t.Fatal("the restarted parked process must be marked retired")
	}
	awaitRestartedSession(t, collector, "session-parked")
}

// A retiring Sidecar carries every busy turn it was retired with. Killing it from
// RestartEngine must settle all of them: the replacement sidecar never heard of those
// sessions, and nothing else settles them once the process dies, so leaving one out
// would keep it busy forever. This is the branch a reader reaches after a credentials
// save retired the old sidecar while their turn was still in flight on it.
func TestRestartEngineOnARetiringProcessSettlesEveryCarriedTurn(t *testing.T) {
	collector := newEventCollector()
	supervisor := NewSupervisor(collector.emit)
	retiringStdin := &recordingStdin{}
	retiring := retiringTestProcess(retiringStdin, "/workspace/a")
	supervisor.process = retiring
	registerTestSession(supervisor, "session-a", KernelPi, "/workspace/a", true)
	registerTestSession(supervisor, "session-b", KernelPi, "/workspace/a", true)

	supervisor.InvalidateCredentials("settings saved")
	supervisor.retireStaleProcessLocked(KernelPi, retiring)
	// The kernel slot now serves a different workspace, so the retiring process is
	// reached through the carried turn, not through the slot.
	supervisor.process = testSidecarProcess("/workspace/probe")

	if err := supervisor.RestartEngine("session-a"); err != nil {
		t.Fatalf("RestartEngine: %v", err)
	}

	if !retiring.retired.Load() {
		t.Fatal("the restarted retiring process must be marked retired")
	}
	for _, id := range []string{"session-a", "session-b"} {
		if _, exists := supervisor.sessions[id]; exists {
			t.Fatalf("carried session %s must be forgotten after its Sidecar was killed", id)
		}
		if _, busy := supervisor.busySessions[id]; busy {
			t.Fatalf("carried session %s must not stay busy forever", id)
		}
		awaitRestartedSession(t, collector, id)
	}
}
