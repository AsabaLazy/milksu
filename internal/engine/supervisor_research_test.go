package engine

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"testing"
)

func TestContinueRegisteredMessageQueuesWhileBusyAndStartsWhenIdle(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()

	supervisor := NewSupervisor(nil)
	supervisor.process = &childProcess{stdin: writer, workspace: t.TempDir()}
	supervisor.sessions["session-busy"] = struct{}{}
	supervisor.sessions["session-idle"] = struct{}{}
	supervisor.busySessions["session-busy"] = struct{}{}
	defer func() {
		supervisor.mu.Lock()
		supervisor.process = nil
		supervisor.sessions = make(map[string]struct{})
		supervisor.busySessions = make(map[string]struct{})
		supervisor.mu.Unlock()
	}()

	if err := supervisor.ContinueRegisteredMessage("session-busy", "synthesize run one"); err != nil {
		t.Fatal(err)
	}
	if err := supervisor.ContinueRegisteredMessage("session-idle", "synthesize run two"); err != nil {
		t.Fatal(err)
	}
	if !supervisor.SessionBusy("session-idle") {
		t.Fatal("starting a continuation on an idle session should mark it busy")
	}

	commands := make([]map[string]any, 0, 2)
	lines := bufio.NewReader(reader)
	for range 2 {
		line, err := lines.ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		var command map[string]any
		if err := json.Unmarshal(line, &command); err != nil {
			t.Fatal(err)
		}
		commands = append(commands, command)
	}
	if commands[0]["action"] != "followup_message" || commands[0]["conversationId"] != "session-busy" {
		t.Fatalf("busy-session continuation = %#v", commands[0])
	}
	if commands[1]["action"] != "relay_message" || commands[1]["conversationId"] != "session-idle" {
		t.Fatalf("idle-session continuation = %#v", commands[1])
	}
}

func TestCancelResearchRunUsesPiSessionAndResearchTasksNormalize(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()

	supervisor := NewSupervisor(nil)
	supervisor.process = &childProcess{stdin: writer, workspace: t.TempDir()}
	supervisor.sessions["pi-session"] = struct{}{}
	if err := supervisor.CancelResearchRun("pi-session", "research_run_1", true); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(reader).ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var command map[string]any
	if err := json.Unmarshal(line, &command); err != nil {
		t.Fatal(err)
	}
	if command["action"] != "cancel_research_run" || command["runId"] != "research_run_1" ||
		command["workerStopMayBeRunning"] != true {
		t.Fatalf("unexpected research cancel command: %#v", command)
	}

	supervisor.sessions["dsh-session"] = struct{}{}
	supervisor.BindSessionKernel("dsh-session", KernelDSH)
	if err := supervisor.CancelResearchRun("dsh-session", "research_run_1", true); err == nil {
		t.Fatal("CancelResearchRun() accepted a DSH session")
	}

	event := normalizeBridgeEvent(bridgeEvent{
		Type:          "research_tasks",
		ID:            "pi-session",
		ResearchRunID: "research_run_1",
		ResearchTasks: []ResearchTaskUpdate{{
			ID:       "tool-call-1",
			Prompt:   "compare two official sources",
			Status:   "completed",
			WorkerID: "worker-1",
			Result:   "The sources agree.",
		}},
	})
	if event.Type != "runtime.research_tasks" || event.SessionID != "pi-session" ||
		event.ResearchRunID != "research_run_1" || len(event.ResearchTasks) != 1 ||
		event.ResearchTasks[0].WorkerID != "worker-1" {
		t.Fatalf("unexpected normalized research event: %#v", event)
	}
}

func TestResearchWorkersPinPiSidecarAfterParentTurnSettles(t *testing.T) {
	supervisor := NewSupervisor(nil)
	process := &childProcess{kernel: KernelPi, workspace: "research-workspace"}
	supervisor.process = process
	supervisor.sessions["research-session"] = struct{}{}
	supervisor.sessionKernels["research-session"] = KernelPi
	supervisor.sessionWorkspaces["research-session"] = "research-workspace"
	supervisor.busySessions["research-session"] = struct{}{}
	isPinned := func() bool {
		supervisor.mu.Lock()
		defer supervisor.mu.Unlock()
		return supervisor.processBusyLocked(process) &&
			supervisor.workspaceHasRunningTurnLocked(KernelPi, "research-workspace")
	}

	supervisor.observeRuntimeEvent(Event{
		Type:          "runtime.research_tasks",
		SessionID:     "research-session",
		ResearchRunID: "research_run_1",
		ResearchTasks: []ResearchTaskUpdate{{ID: "task-1", Status: "running"}},
	})
	supervisor.observeTurnLifecycle(
		bridgeEvent{Type: "turn_settled", ID: "research-session"},
		Event{Type: "assistant.settled", SessionID: "research-session"},
	)
	if supervisor.SessionBusy("research-session") {
		t.Fatal("the parent turn should have settled")
	}
	if !isPinned() {
		t.Fatal("a detached research worker must keep its Pi Sidecar alive")
	}

	supervisor.observeRuntimeEvent(Event{
		Type:          "runtime.research_tasks",
		SessionID:     "research-session",
		ResearchRunID: "research_run_1",
		ResearchTasks: []ResearchTaskUpdate{{ID: "task-1", Status: "completed"}},
	})
	if isPinned() {
		t.Fatal("a terminal research worker must release its Pi Sidecar")
	}
}

func TestActiveResearchRunIsInterruptedWithItsSidecarWithoutWorkers(t *testing.T) {
	supervisor := NewSupervisor(nil)
	supervisor.sessions["research-idle"] = struct{}{}
	supervisor.sessionKernels["research-idle"] = KernelPi
	supervisor.sessionWorkspaces["research-idle"] = "research-workspace"
	supervisor.TrackResearchRun("research-idle", "research_run_2", true)

	supervisor.mu.Lock()
	interrupted := supervisor.dropWorkspaceSessionsLocked(KernelPi, "research-workspace")
	supervisor.mu.Unlock()
	if len(interrupted) != 1 || interrupted[0] != "research-idle" {
		t.Fatalf("Sidecar loss did not report the run between worker batches: %v", interrupted)
	}
	if _, active := supervisor.researchRunSessions["research-idle"]; active {
		t.Fatal("forgetting the lost session left its ResearchRun tracking entry")
	}
}

func TestRetiredResearchSidecarKeepsSessionUntilWorkerStops(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()

	supervisor := NewSupervisor(nil)
	process := &childProcess{
		command:   &exec.Cmd{},
		stdin:     writer,
		kernel:    KernelPi,
		workspace: "research-workspace",
	}
	supervisor.process = process
	supervisor.sessions["research-session"] = struct{}{}
	supervisor.sessionKernels["research-session"] = KernelPi
	supervisor.sessionWorkspaces["research-session"] = "research-workspace"
	supervisor.observeRuntimeEvent(Event{
		Type:          "runtime.research_tasks",
		SessionID:     "research-session",
		ResearchRunID: "research_run_1",
		ResearchTasks: []ResearchTaskUpdate{{ID: "task-1", Status: "running"}},
	})
	supervisor.observeTurnLifecycle(
		bridgeEvent{Type: "turn_settled", ID: "research-session"},
		Event{Type: "assistant.settled", SessionID: "research-session"},
	)

	supervisor.mu.Lock()
	supervisor.retireStaleProcessLocked(KernelPi, process)
	if supervisor.processForSessionLocked("research-session") != process {
		supervisor.mu.Unlock()
		t.Fatal("research session should remain routed to its retired Sidecar while the worker runs")
	}
	interrupted := supervisor.stopRetiredProcessLocked(process)
	supervisor.mu.Unlock()
	if len(interrupted) != 1 || interrupted[0] != "research-session" {
		t.Fatalf("stopping a retired research Sidecar interrupted %v", interrupted)
	}
	if len(supervisor.researchWorkerTasks["research-session"]) != 0 {
		t.Fatal("stopping the Sidecar left research worker pin state behind")
	}
}

func TestUnexpectedRetiredSidecarExitInterruptsResearchWithoutStoppingEngine(t *testing.T) {
	collector := newEventCollector()
	supervisor := NewSupervisor(collector.emit)
	command := exec.Command("/bin/sh", "-c", "exit 0")
	if runtime.GOOS == "windows" {
		command = exec.Command("cmd.exe", "/c", "exit", "0")
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	process := &childProcess{
		command:   command,
		kernel:    KernelPi,
		workspace: "research-workspace",
		stderr:    newSidecarStderrBuffer(),
	}
	supervisor.process = process
	for _, id := range []string{"worker-session", "between-batches-session", "normal-session"} {
		supervisor.sessions[id] = struct{}{}
		supervisor.sessionKernels[id] = KernelPi
		supervisor.sessionWorkspaces[id] = process.workspace
	}
	supervisor.busySessions["normal-session"] = struct{}{}
	supervisor.researchWorkerTasks["worker-session"] = map[string]struct{}{"worker-1": {}}
	supervisor.researchRunSessions["between-batches-session"] = "research-run-1"
	supervisor.mu.Lock()
	supervisor.retireStaleProcessLocked(KernelPi, process)
	if len(process.retiredTurns) != 3 {
		supervisor.mu.Unlock()
		t.Fatalf("retired turns = %v, want active Research and foreground sessions", process.retiredTurns)
	}
	supervisor.mu.Unlock()

	supervisor.readEvents(KernelPi, process, stdout)

	collector.awaitSessionError(t, "worker-session")
	collector.awaitSessionError(t, "between-batches-session")
	collector.awaitSessionError(t, "normal-session")
	if _, found := collector.find("", engineSidecarStoppedEvent); !found {
		t.Fatalf("unexpectedly exited retired Sidecar did not report its lifecycle receipt")
	}
	if _, found := collector.find("", "engine.stopped"); found {
		t.Fatal("a retired Sidecar exit must not stop the whole Pi engine")
	}
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	for _, id := range []string{"worker-session", "between-batches-session", "normal-session"} {
		if _, live := supervisor.sessions[id]; live {
			t.Fatalf("interrupted Research session %s remained registered", id)
		}
	}
}

func TestResearchCancelUnconfirmedEventNormalizesForRenderer(t *testing.T) {
	event := normalizeBridgeEvent(bridgeEvent{
		Type:    "research_cancel_unconfirmed",
		ID:      "research-session",
		Content: "Could not confirm worker stop",
	}, KernelPi)
	if event.Type != "runtime.research_cancel_unconfirmed" ||
		event.SessionID != "research-session" ||
		event.Text != "Could not confirm worker stop" {
		t.Fatalf("unexpected normalized stop warning: %#v", event)
	}
}

func TestResearchCancelConfirmedEventNormalizesForRenderer(t *testing.T) {
	event := normalizeBridgeEvent(bridgeEvent{
		Type:          "research_cancel_confirmed",
		ID:            "research-session",
		ResearchRunID: "research-run",
	}, KernelPi)
	if event.Type != "runtime.research_cancel_confirmed" ||
		event.SessionID != "research-session" ||
		event.ResearchRunID != "research-run" {
		t.Fatalf("unexpected normalized stop confirmation: %#v", event)
	}
}

func TestShutdownChildProcessRequestsGracefulSidecarCleanup(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	process := &childProcess{
		command: &exec.Cmd{},
		stdin:   writer,
		done:    make(chan struct{}),
	}
	read := make(chan error, 1)
	go func() {
		line, err := bufio.NewReader(reader).ReadBytes('\n')
		if err != nil {
			read <- err
			return
		}
		var command map[string]any
		if err := json.Unmarshal(line, &command); err != nil {
			read <- err
			return
		}
		if command["action"] != "shutdown" {
			read <- fmt.Errorf("shutdown action = %#v", command["action"])
			return
		}
		read <- nil
		close(process.done)
	}()

	shutdownChildProcess(process)
	if err := <-read; err != nil {
		t.Fatal(err)
	}
}
