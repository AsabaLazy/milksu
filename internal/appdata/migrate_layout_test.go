package appdata

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// layoutMigrationFixture describes one synthetic version-1 root entry: content
// is written at the version-1 location, target is the expected version-2
// location, and both must be byte-identical after the migration.
type layoutMigrationFixture struct {
	name    string
	content map[string]string // relative paths inside the entry -> payload
}

func layoutMigrationFixtures() []layoutMigrationFixture {
	return []layoutMigrationFixture{
		{name: "conversations", content: map[string]string{
			"one.json":        `{"id":"one","title":"会话一"}`,
			"archived/2.json": `{"id":"two","archived":true}`,
		}},
		{name: "session-index", content: map[string]string{"obelisk.sqlite": "index-bytes"}},
		{name: "usage", content: map[string]string{"model-usage.sqlite3": "usage-bytes"}},
		{name: "lab-jobs", content: map[string]string{"job.json": "lab"}},
		{name: "coding-project-memory.json", content: map[string]string{"coding-project-memory.json": "memory"}},
		{name: "settings.json", content: map[string]string{"settings.json": `{"theme":"dark"}`}},
		{name: "credentials.db", content: map[string]string{"credentials.db": "credentials"}},
		{name: "agent-home", content: map[string]string{
			"pi/sessions/s.jsonl":                     "session",
			"attachments/a.png":                       "png",
			"coding-collaboration/writer-1/README.md": "collab",
		}},
		{name: "agent-resources", content: map[string]string{"skills/x/SKILL.md": "skill"}},
		{name: "companion", content: map[string]string{"state.json": `{"ok":true}`}},
		{name: "runtime", content: map[string]string{"events.sqlite3": "events", "milksu.log": "log"}},
		{name: "lifespan.json", content: map[string]string{"lifespan.json": `{"lastExit":"clean"}`}},
		{name: "model-catalog", content: map[string]string{"tokenflux.json": "catalog"}},
		{name: "plugins", content: map[string]string{"installed/p/plugin.json": "plugin"}},
		{name: "envbroker", content: map[string]string{"leases.json": "leases"}},
		{name: "coding-tools", content: map[string]string{"ghidra-rpc-state/state": "ghidra"}},
		{name: "security-tools", content: map[string]string{"capa/1.0/capa": "capa"}},
		{name: "computer-use", content: map[string]string{"task-authorizations/t.json": "grant"}},
		{name: "ctf", content: map[string]string{"memory.sqlite3": "ctf-memory"}},
		{name: "nssctf", content: map[string]string{"catalog.sqlite3": "nssctf"}},
		{name: "ctfshow", content: map[string]string{"catalog.sqlite3": "ctfshow"}},
		{name: "vuln", content: map[string]string{"feed-snapshots/src/1.json": "feed"}},
		{name: "evalsuite", content: map[string]string{"board.json": "board"}},
		{name: "agent-workspace", content: map[string]string{".git/HEAD": "", "notes.md": "workspace"}},
		{name: "agent-workspaces", content: map[string]string{"Coding/任务-a/README.md": "aws"}},
		{name: "ctf-workspaces", content: map[string]string{"ctf-1/README.md": "ctfw"}},
		{name: "browser", content: map[string]string{"bridge-pairing.json": "pairing"}},
		{name: "restore", content: map[string]string{"pending.zip": "zip"}},
	}
}

func writeLayoutMigrationRoot(t *testing.T, root string) {
	t.Helper()
	for _, fixture := range layoutMigrationFixtures() {
		for relative, payload := range fixture.content {
			writeMigrationFixture(t, filepath.Join(root, fixture.name, filepath.FromSlash(relative)), payload)
		}
	}
	writeMigrationFixture(t, filepath.Join(root, "settings.json.dev-probe"), "probe")
	writeMigrationFixture(t, filepath.Join(root, "unknown-leftover.bin"), "leftover")
}

func assertLayoutMigrationLanded(t *testing.T, root string) {
	t.Helper()
	for _, fixture := range layoutMigrationFixtures() {
		target, mapped := dataLayoutV2MigrationMap[fixture.name]
		if !mapped {
			t.Fatalf("fixture %q is missing from dataLayoutV2MigrationMap", fixture.name)
		}
		for relative, want := range fixture.content {
			path := filepath.Join(root, filepath.FromSlash(target), filepath.FromSlash(relative))
			got, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("expected %q migrated to %q: %v", fixture.name, path, err)
			}
			if string(got) != want {
				t.Fatalf("migrated %s content = %q, want %q", path, got, want)
			}
		}
		if _, err := os.Lstat(filepath.Join(root, fixture.name)); !os.IsNotExist(err) {
			t.Fatalf("expected version-1 entry %q removed from the root: %v", fixture.name, err)
		}
	}
	for name, target := range map[string]string{
		"settings.json.dev-probe": filepath.Join("data", "legacy-unmapped", "settings.json.dev-probe"),
		"unknown-leftover.bin":    filepath.Join("data", "legacy-unmapped", "unknown-leftover.bin"),
	} {
		got, err := os.ReadFile(filepath.Join(root, target))
		if err != nil {
			t.Fatalf("expected unmapped entry %q preserved: %v", name, err)
		}
		if name == "settings.json.dev-probe" && string(got) != "probe" {
			t.Fatalf("unexpected preserved content for %q: %q", name, got)
		}
	}
}

// TestDataLayoutV1To2MovesEveryEntry builds a version-1 root that carries the
// full mapping table plus unmapped leftovers and structural directories, and
// asserts every entry lands byte-identical at its version-2 location.
func TestDataLayoutV1To2MovesEveryEntry(t *testing.T) {
	root := t.TempDir()
	writeLayoutMigrationRoot(t, root)
	writeDataLayoutFixture(t, root, DataLayout{
		Schema:    DataLayoutSchema,
		Version:   1,
		UpdatedAt: "2026-10-01T00:00:00Z",
	})
	// A partial version-2 run may have left the structural directories
	// behind; their contents (here: a hand-made incident backup) must stay
	// exactly where they are.
	writeMigrationFixture(t, filepath.Join(root, "backups", "conversations-pre-v2-20261001", "one.json"), "backup")
	writeMigrationFixture(t, filepath.Join(root, "workspaces", "browser", "bridge-pairing.json"), "skeleton")

	if err := ensureDataLayout(root); err != nil {
		t.Fatalf("ensureDataLayout() error = %v", err)
	}
	assertLayoutMigrationLanded(t, root)

	layout, err := ReadDataLayout(root)
	if err != nil {
		t.Fatalf("ReadDataLayout() error = %v", err)
	}
	if layout.Version != CurrentDataLayoutVersion {
		t.Fatalf("layout version = %d, want %d", layout.Version, CurrentDataLayoutVersion)
	}
	if _, err := os.Lstat(filepath.Join(root, dataLayoutMigrationJournalName)); !os.IsNotExist(err) {
		t.Fatalf("expected migration journal removed, stat err = %v", err)
	}
	// Structural directories are never filed under legacy-unmapped.
	got, err := os.ReadFile(filepath.Join(root, "backups", "conversations-pre-v2-20261001", "one.json"))
	if err != nil || string(got) != "backup" {
		t.Fatalf("structural backups/ content was disturbed: %q %v", got, err)
	}
	if _, err := os.Lstat(filepath.Join(root, "data", "legacy-unmapped", "workspaces")); !os.IsNotExist(err) {
		t.Fatalf("workspaces/ must stay at the root, not move to legacy-unmapped: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(root, "data", "legacy-unmapped", "backups")); !os.IsNotExist(err) {
		t.Fatalf("backups/ must stay at the root, not move to legacy-unmapped: %v", err)
	}
}

// TestDataLayoutV1To2ResumesAfterInterruption simulates a crash after some
// entries moved and the journal recorded them, then reruns the migration and
// asserts it finishes the remaining entries without touching completed ones.
func TestDataLayoutV1To2ResumesAfterInterruption(t *testing.T) {
	root := t.TempDir()
	writeLayoutMigrationRoot(t, root)
	writeDataLayoutFixture(t, root, DataLayout{
		Schema:    DataLayoutSchema,
		Version:   1,
		UpdatedAt: "2026-10-01T00:00:00Z",
	})

	// Crash point 1: "conversations" and "settings.json" fully moved and
	// recorded in the journal.
	conversationsTarget := filepath.Join(root, "data", "stores", "conversations")
	if err := os.MkdirAll(filepath.Join(conversationsTarget, "archived"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(
		filepath.Join(root, "conversations", "one.json"),
		filepath.Join(conversationsTarget, "one.json"),
	); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(
		filepath.Join(root, "conversations", "archived", "2.json"),
		filepath.Join(conversationsTarget, "archived", "2.json"),
	); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "conversations", "archived")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "conversations")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(root, "settings.json"), filepath.Join(root, "config", "settings.json")); err != nil {
		t.Fatal(err)
	}
	if err := writeDataLayoutMigrationJournal(root, dataLayoutMigrationJournal{
		Schema:      dataLayoutMigrationJournalSchema,
		FromVersion: 1,
		ToVersion:   2,
		StartedAt:   "2026-10-01T12:00:00Z",
		Completed:   []string{"conversations", "settings.json"},
	}); err != nil {
		t.Fatal(err)
	}
	// Crash point 2: usage moved but the journal write never happened (the
	// move is durable, the record is not).
	if err := os.MkdirAll(filepath.Join(root, "data", "stores"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(
		filepath.Join(root, "usage"),
		filepath.Join(root, "data", "stores", "usage"),
	); err != nil {
		t.Fatal(err)
	}
	// Crash point 3: the runtime directory merge stopped halfway through its
	// children, with events.sqlite3 already merged and milksu.log left behind.
	if err := os.MkdirAll(filepath.Join(root, "data", "runtime"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(
		filepath.Join(root, "runtime", "events.sqlite3"),
		filepath.Join(root, "data", "runtime", "events.sqlite3"),
	); err != nil {
		t.Fatal(err)
	}

	if err := ensureDataLayout(root); err != nil {
		t.Fatalf("ensureDataLayout() resume error = %v", err)
	}
	assertLayoutMigrationLanded(t, root)
	layout, err := ReadDataLayout(root)
	if err != nil {
		t.Fatal(err)
	}
	if layout.Version != CurrentDataLayoutVersion {
		t.Fatalf("layout version after resume = %d, want %d", layout.Version, CurrentDataLayoutVersion)
	}
}

// TestDataLayoutV1To2PreservesExistingTargets covers the incident shape: a
// partial version-2 run already created files and directories at the new
// paths. Every pre-existing target is renamed aside with the
// .pre-v2-migration suffix, never overwritten or deleted.
func TestDataLayoutV1To2PreservesExistingTargets(t *testing.T) {
	root := t.TempDir()
	writeLayoutMigrationRoot(t, root)
	writeDataLayoutFixture(t, root, DataLayout{
		Schema:    DataLayoutSchema,
		Version:   1,
		UpdatedAt: "2026-10-01T00:00:00Z",
	})
	// A default settings file a partial v2 run wrote plus a browser skeleton
	// with its own pairing file.
	writeMigrationFixture(t, filepath.Join(root, "config", "settings.json"), `{"theme":"light"}`)
	writeMigrationFixture(t, filepath.Join(root, "workspaces", "browser", "bridge-pairing.json"), "skeleton-pairing")
	writeMigrationFixture(t, filepath.Join(root, "workspaces", "browser", "profile", "lock"), "lock")
	writeMigrationFixture(t, filepath.Join(root, "workspaces", "agent-workspace", ".git", "HEAD"), "")

	if err := ensureDataLayout(root); err != nil {
		t.Fatalf("ensureDataLayout() error = %v", err)
	}
	assertLayoutMigrationLanded(t, root)

	// The partial-run default survives under .pre-v2-migration.
	got, err := os.ReadFile(filepath.Join(root, "config", "settings.json.pre-v2-migration"))
	if err != nil || string(got) != `{"theme":"light"}` {
		t.Fatalf("pre-existing settings.json was not preserved: %q %v", got, err)
	}
	got, err = os.ReadFile(filepath.Join(root, "workspaces", "browser", "bridge-pairing.json.pre-v2-migration"))
	if err != nil || string(got) != "skeleton-pairing" {
		t.Fatalf("pre-existing browser pairing was not preserved: %q %v", got, err)
	}
	// Directory merges are per sub-item: non-conflicting skeleton children
	// stay, conflicting ones are renamed aside, and the version-1 children
	// land untouched on top.
	got, err = os.ReadFile(filepath.Join(root, "workspaces", "browser", "profile", "lock"))
	if err != nil || string(got) != "lock" {
		t.Fatalf("non-conflicting target child was lost: %q %v", got, err)
	}
	if _, err := os.Lstat(filepath.Join(root, "workspaces", "agent-workspace", ".git")); err != nil {
		t.Fatalf("expected agent-workspace .git boundary kept after merge: %v", err)
	}
}

// TestDataLayoutV1To2KeepsVersionOneOnFailure makes one move fail halfway
// through (a file blocks the data/stores directory path) and asserts the
// version marker stays at 1 while the journal records the completed prefix.
// Removing the blockage and rerunning finishes the migration to version 2.
func TestDataLayoutV1To2KeepsVersionOneOnFailure(t *testing.T) {
	root := t.TempDir()
	writeLayoutMigrationRoot(t, root)
	writeDataLayoutFixture(t, root, DataLayout{
		Schema:    DataLayoutSchema,
		Version:   1,
		UpdatedAt: "2026-10-01T00:00:00Z",
	})
	// data/stores as a regular file makes every store target unwritable.
	writeMigrationFixture(t, filepath.Join(root, "data", "stores"), "blocker")

	if err := ensureDataLayout(root); err == nil {
		t.Fatal("expected ensureDataLayout() to fail while a target path is blocked")
	}
	layout, err := ReadDataLayout(root)
	if err != nil {
		t.Fatal(err)
	}
	if layout.Version != 1 {
		t.Fatalf("layout version after failed migration = %d, want 1", layout.Version)
	}
	if _, err := os.Lstat(filepath.Join(root, dataLayoutMigrationJournalName)); err != nil {
		t.Fatalf("expected interrupted migration to leave its journal: %v", err)
	}
	// Entries sorted before the blocked one (agent-home and friends) already
	// landed and are recorded as completed in the journal.
	if _, err := os.Lstat(filepath.Join(root, "data", "agent", "home")); err != nil {
		t.Fatalf("expected early entries to have moved before the failure: %v", err)
	}
	var journal dataLayoutMigrationJournal
	payload, err := os.ReadFile(filepath.Join(root, dataLayoutMigrationJournalName))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(payload, &journal); err != nil {
		t.Fatal(err)
	}
	if len(journal.Completed) == 0 {
		t.Fatal("expected the journal to record completed entries")
	}

	// Unblock and rerun: the migration resumes and reaches version 2.
	if err := os.Remove(filepath.Join(root, "data", "stores")); err != nil {
		t.Fatal(err)
	}
	if err := ensureDataLayout(root); err != nil {
		t.Fatalf("ensureDataLayout() after unblocking error = %v", err)
	}
	assertLayoutMigrationLanded(t, root)
	layout, err = ReadDataLayout(root)
	if err != nil {
		t.Fatal(err)
	}
	if layout.Version != CurrentDataLayoutVersion {
		t.Fatalf("layout version after resumed migration = %d, want %d",
			layout.Version, CurrentDataLayoutVersion)
	}
}

// TestDataLayoutMigrationMapsAgreeWithHomeMigration asserts that entries
// present in both migration tables agree on the version-2 target: the same
// top-level name must not land in different places depending on which
// migration path moved it.
func TestDataLayoutMigrationMapsAgreeWithHomeMigration(t *testing.T) {
	for name, homeTarget := range homeMigrationMap {
		if layoutTarget, ok := dataLayoutV2MigrationMap[name]; ok && layoutTarget != homeTarget {
			t.Fatalf(
				"migration tables disagree on %q: home=%q layout=%q",
				name, homeTarget, layoutTarget,
			)
		}
	}
}
