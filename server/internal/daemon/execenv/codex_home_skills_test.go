package execenv

import (
	"os"
	"path/filepath"
	"testing"
)

// linkUserGlobalCodexSkills implements the "codex agent should see what
// `codex` sees on the operator's box" pass-through. The cases below pin
// the contracts that, in past incidents, were the surprising defaults:
//
//   - empty workspace skills must NOT block user-global pass-through
//     (the original "debugger has no jira skill" report — debugger had
//     zero folio-assigned skills, and the prior implementation returned
//     early before ever consulting ~/.codex/skills/)
//   - folio-managed skills must always win on a name collision (because
//     writeSkillFiles uses os.WriteFile, which would otherwise follow a
//     symlink and clobber the operator's source SKILL.md)
//   - dotfile entries (~/.codex/skills/.DS_Store etc.) and loose files
//     in the skills/ root are NOT skills and must be skipped, otherwise
//     a Mac DS_Store creates a confusing dangling .DS_Store directory
//     inside every task home

func TestLinkUserGlobalCodexSkillsExposesUntakenNames(t *testing.T) {
	t.Parallel()

	shared := t.TempDir()
	skillsSrc := filepath.Join(shared, "skills")
	if err := os.MkdirAll(filepath.Join(skillsSrc, "jira"), 0o755); err != nil {
		t.Fatalf("mkdir jira: %v", err)
	}
	if err := os.WriteFile(filepath.Join(skillsSrc, "jira", "SKILL.md"), []byte("# jira"), 0o644); err != nil {
		t.Fatalf("write SKILL.md: %v", err)
	}

	codexHome := t.TempDir()
	skillsDir := filepath.Join(codexHome, "skills")

	if err := linkUserGlobalCodexSkills(skillsDir, shared, discardLogger()); err != nil {
		t.Fatalf("link: %v", err)
	}

	dst := filepath.Join(skillsDir, "jira")
	fi, err := os.Lstat(dst)
	if err != nil {
		t.Fatalf("expected %s to exist, got %v", dst, err)
	}
	if fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("expected %s to be a symlink, got mode %v", dst, fi.Mode())
	}
	target, err := os.Readlink(dst)
	if err != nil {
		t.Fatalf("readlink: %v", err)
	}
	if target != filepath.Join(skillsSrc, "jira") {
		t.Fatalf("symlink target = %s, want %s", target, filepath.Join(skillsSrc, "jira"))
	}
}

func TestLinkUserGlobalCodexSkillsPreservesFolioWritten(t *testing.T) {
	t.Parallel()

	shared := t.TempDir()
	if err := os.MkdirAll(filepath.Join(shared, "skills", "pr-review"), 0o755); err != nil {
		t.Fatalf("mkdir pr-review: %v", err)
	}
	if err := os.WriteFile(filepath.Join(shared, "skills", "pr-review", "SKILL.md"), []byte("user version"), 0o644); err != nil {
		t.Fatalf("write user pr-review: %v", err)
	}

	codexHome := t.TempDir()
	skillsDir := filepath.Join(codexHome, "skills")
	folioDir := filepath.Join(skillsDir, "pr-review")
	if err := os.MkdirAll(folioDir, 0o755); err != nil {
		t.Fatalf("mkdir folio pr-review: %v", err)
	}
	folioSkill := filepath.Join(folioDir, "SKILL.md")
	if err := os.WriteFile(folioSkill, []byte("folio version"), 0o644); err != nil {
		t.Fatalf("write folio pr-review: %v", err)
	}

	if err := linkUserGlobalCodexSkills(skillsDir, shared, discardLogger()); err != nil {
		t.Fatalf("link: %v", err)
	}

	// The folio-written directory must remain a regular dir with the
	// folio content intact — never converted into a symlink, never
	// followed-and-overwritten by future writeSkillFiles calls.
	fi, err := os.Lstat(folioDir)
	if err != nil {
		t.Fatalf("stat folio dir: %v", err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("folio dir was clobbered into a symlink: mode=%v", fi.Mode())
	}
	got, err := os.ReadFile(folioSkill)
	if err != nil {
		t.Fatalf("read folio SKILL.md: %v", err)
	}
	if string(got) != "folio version" {
		t.Fatalf("folio SKILL.md content = %q, want %q", string(got), "folio version")
	}
	// And the operator's source must be untouched.
	src, err := os.ReadFile(filepath.Join(shared, "skills", "pr-review", "SKILL.md"))
	if err != nil {
		t.Fatalf("read user SKILL.md: %v", err)
	}
	if string(src) != "user version" {
		t.Fatalf("user SKILL.md got rewritten to %q", string(src))
	}
}

func TestLinkUserGlobalCodexSkillsSkipsDotfilesAndLooseFiles(t *testing.T) {
	t.Parallel()

	shared := t.TempDir()
	skillsSrc := filepath.Join(shared, "skills")
	if err := os.MkdirAll(skillsSrc, 0o755); err != nil {
		t.Fatalf("mkdir skills: %v", err)
	}
	// dotfile dir
	if err := os.MkdirAll(filepath.Join(skillsSrc, ".cache"), 0o755); err != nil {
		t.Fatalf("mkdir .cache: %v", err)
	}
	// loose file
	if err := os.WriteFile(filepath.Join(skillsSrc, "README.md"), []byte("readme"), 0o644); err != nil {
		t.Fatalf("write README: %v", err)
	}
	// real skill
	if err := os.MkdirAll(filepath.Join(skillsSrc, "deploy-doris"), 0o755); err != nil {
		t.Fatalf("mkdir deploy-doris: %v", err)
	}

	codexHome := t.TempDir()
	skillsDir := filepath.Join(codexHome, "skills")
	if err := linkUserGlobalCodexSkills(skillsDir, shared, discardLogger()); err != nil {
		t.Fatalf("link: %v", err)
	}

	if _, err := os.Lstat(filepath.Join(skillsDir, ".cache")); !os.IsNotExist(err) {
		t.Fatalf("dotfile .cache should not be linked, got err=%v", err)
	}
	if _, err := os.Lstat(filepath.Join(skillsDir, "README.md")); !os.IsNotExist(err) {
		t.Fatalf("loose file README.md should not be linked, got err=%v", err)
	}
	if _, err := os.Lstat(filepath.Join(skillsDir, "deploy-doris")); err != nil {
		t.Fatalf("real skill deploy-doris should be linked: %v", err)
	}
}

func TestLinkUserGlobalCodexSkillsMissingSharedHomeIsNoop(t *testing.T) {
	t.Parallel()

	// sharedHome exists but skills/ subdir doesn't — this is the brand-new
	// operator case where ~/.codex exists for auth but no skills installed.
	shared := t.TempDir()
	codexHome := t.TempDir()
	skillsDir := filepath.Join(codexHome, "skills")

	if err := linkUserGlobalCodexSkills(skillsDir, shared, discardLogger()); err != nil {
		t.Fatalf("missing skills/ should be noop, got %v", err)
	}
	// And we shouldn't have created an empty skillsDir as a side effect.
	if _, err := os.Stat(skillsDir); !os.IsNotExist(err) {
		t.Fatalf("skillsDir should not be created when nothing to link, got err=%v", err)
	}
}

func TestLinkUserGlobalCodexSkillsEmptySharedHomeIsNoop(t *testing.T) {
	t.Parallel()
	if err := linkUserGlobalCodexSkills(t.TempDir(), "", discardLogger()); err != nil {
		t.Fatalf("empty sharedHome should be noop, got %v", err)
	}
}

// End-to-end through writeCodexWorkspaceSkills: the original report
// ("debugger has zero folio skills, codex sees nothing") must come back
// with the user-global skill linked.
func TestWriteCodexWorkspaceSkillsLinksUserGlobalWhenAgentHasNoSkills(t *testing.T) {
	shared := t.TempDir()
	if err := os.MkdirAll(filepath.Join(shared, "skills", "jira"), 0o755); err != nil {
		t.Fatalf("mkdir jira: %v", err)
	}
	if err := os.WriteFile(filepath.Join(shared, "skills", "jira", "SKILL.md"), []byte("# jira"), 0o644); err != nil {
		t.Fatalf("write jira: %v", err)
	}

	t.Setenv("CODEX_HOME", shared)
	defer t.Setenv("CODEX_HOME", "")

	codexHome := t.TempDir()
	if err := writeCodexWorkspaceSkills(codexHome, nil, discardLogger()); err != nil {
		t.Fatalf("writeCodexWorkspaceSkills: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(codexHome, "skills", "jira")); err != nil {
		t.Fatalf("expected jira to be linked, got %v", err)
	}
}
